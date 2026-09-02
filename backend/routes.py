"""万事屋 · 功能路由
监控 / 天气 / 单词 / 书签 / 笔记 / 计划 / 日历 / 保险库 / 工具箱 / 搜索 / 备份。
"""
import re
import threading
import time
import uuid
import json
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Body, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import storage
import secretbox
from sessions import require_user, verify_password

router = APIRouter()

WMO = {0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "雾凇",
       51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨", 56: "冻毛毛雨", 57: "强冻毛毛雨",
       61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
       71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
       80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "小阵雪", 86: "大阵雪",
       95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"}
WMO_ICON = {0: "sun", 1: "sun", 2: "cloud-sun", 3: "cloud", 45: "cloud", 48: "cloud",
            51: "cloud-rain", 53: "cloud-rain", 55: "cloud-rain", 56: "cloud-rain",
            57: "cloud-rain", 61: "cloud-rain", 63: "cloud-rain", 65: "cloud-rain",
            66: "cloud-rain", 67: "cloud-rain", 71: "cloud", 73: "cloud", 75: "cloud",
            77: "cloud", 80: "cloud-rain", 81: "cloud-rain", 82: "cloud-rain",
            85: "cloud", 86: "cloud", 95: "cloud-rain", 96: "cloud-rain", 99: "cloud-rain"}


# ---------- 偏好（个性化主题等） ----------
@router.get("/api/settings")
def get_settings(authorization: Optional[str] = Header(None)):
    return storage.get_prefs(require_user(authorization))


class PrefsIn(BaseModel):
    theme: Optional[dict] = None
    layout: Optional[dict] = None
    locale: Optional[dict] = None
    weather: Optional[dict] = None


@router.put("/api/settings")
def put_settings(body: PrefsIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    prefs = storage.get_prefs(username)
    for key in ("theme", "layout", "locale", "weather"):
        val = getattr(body, key)
        if val:
            prefs[key].update(val)
    storage.save_prefs(username, prefs)
    return prefs


# ---------- 系统监控 ----------
def _monitor_gate(authorization: Optional[str]):
    """监控功能门控：仅管理员可用，且需管理员在设置·功能设置中开启。"""
    username = require_user(authorization)
    _require_admin(username)
    if not storage.get_config().get("monitorEnabled"):
        raise HTTPException(403, "系统监控未开启，管理员可在设置·功能设置中开启")
    return username


@router.get("/api/system/stats")
def system_stats(authorization: Optional[str] = Header(None)):
    _monitor_gate(authorization)
    import psutil
    import platform
    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    cpu_temp, disk_temp = _sensor_temps()
    boot = datetime_from_ts(psutil.boot_time())
    return {
        "host": platform.node() or "nas",
        "platform": f"{platform.system()} {platform.release()}",
        "cpu": round(cpu),
        "cpuCount": psutil.cpu_count(logical=True),
        "temp": cpu_temp,
        "diskTemp": disk_temp,
        "mem": round(mem.percent),
        "memUsedGB": round(mem.used / 1073741824, 1),
        "memTotalGB": round(mem.total / 1073741824, 1),
        "disk": round(disk.percent),
        "diskUsedTB": round(disk.used / 1099511627776, 1),
        "diskTotalTB": round(disk.total / 1099511627776, 1),
        # 网络：算出真正的速率（MB/s），不是累计字节。
        # 累计字节 / 1024² 会随启动时间无限增长，曾被前端错误标注为 "MB/s"。
        # 现在跨请求用 module-level 状态机保存上一次快照，按 dt 求速率。
        "netUpMbps": round(_net_rate('up', net.bytes_sent), 2),
        "netDownMbps": round(_net_rate('down', net.bytes_recv), 2),
        "disks": _physical_disks(disk),
        "bootTime": boot,
    }


# 主机网络速率：上一组（累计字节 + 时间戳），按方向分别保存以避免同一请求内
# 两次调用互相干扰（见 _net_rate 注释）。
_NET_PREV = {
    "up":   {"ts": 0.0, "val": 0},
    "down": {"ts": 0.0, "val": 0},
}
_NET_PREV_LOCK = threading.Lock()


def _net_rate(direction: str, current: int) -> float:
    """bytes/秒 → MB/s。首次调用或时间倒流返回 0。

       按方向分别保存上一次快照 —— 同一请求里 _net_rate('up') 与 _net_rate('down')
       会先后调用，若共用一对 prev_ts/prev_val，第二次就会拿"刚刚被第一次
       覆盖的 ts + 仍是模块初值的 0 val"算 diff/dt，dt 微秒级 + diff=累计字节
       算出会出现 22 TB/s 这种伪速率。每个方向各自 init 才能避开。"""
    now = time.time()
    with _NET_PREV_LOCK:
        prev_ts = _NET_PREV[direction]["ts"]
        prev_val = _NET_PREV[direction]["val"]
        if prev_ts == 0:
            # 首次采样：把当前值记下，返回 0 让前端不要渲染一个假速率
            _NET_PREV[direction]["ts"] = now
            _NET_PREV[direction]["val"] = current
            return 0.0
        _NET_PREV[direction]["ts"] = now
        _NET_PREV[direction]["val"] = current
    dt = now - prev_ts
    if dt <= 0.5 or dt < 0:           # <0.5s 数据太短不统计；负值=时钟回退
        return 0.0
    diff = current - prev_val
    if diff < 0:                  # 计数器回绕 / 接口重置
        return 0.0
    return diff / dt / 1048576


# 物理硬盘枚举（Linux 优先用 /sys/block，跨平台兜底用 psutil 分区聚合）
_RE_LPART_TAIL = __import__("re").compile(r"^(.*?)(\d+)$")


def _physical_disk_names() -> set:
    """返回本机所有物理硬盘名（sda / nvme0n1 / mmcblk0 …），跨平台。
       用于过滤 psutil 那些"包山包海"的总览（分区、回环、dm-*、ram）。"""
    from pathlib import Path
    names = set()
    sb = Path("/sys/block")
    if not sb.exists():
        return names
    for entry in sb.iterdir():
        n = entry.name
        if n.startswith(("loop", "ram", "dm-")):
            continue
        if (entry / "partition").exists():          # 分区，而非物理盘
            continue
        names.add(n)
    return names


def _physical_disks(root_disk):
    """列出每块物理硬盘的容量与占用。
       返回 [{name, device, model, sizeBytes, usedBytes, totalBytes, percent, mountpoint?}]。
       跳过分区、回环、ram、dm-*；未挂载时 used/percent 留空。"""
    import psutil as _psu
    import re
    from pathlib import Path
    disks = []
    sb = Path("/sys/block")
    # 把已挂载分区按"父磁盘"归类（处理 sda1→sda、nvme0n1p1→nvme0n1、mmcblk0p1→mmcblk0 等）
    parts_by_parent = {}
    if hasattr(_psu, "disk_partitions"):
        for p in _psu.disk_partitions(all=False):
            dev = (p.device or "").replace("/dev/", "")
            if not dev:
                continue
            m = _RE_LPART_TAIL.match(dev)
            parent = m.group(1) if m else dev
            entry = parts_by_parent.setdefault(parent, [])
            entry.append((p.mountpoint, dev))
    seen = set()
    if sb.exists():
        for entry in sorted(sb.iterdir(), key=lambda p: p.name):
            name = entry.name
            if name in seen:
                continue
            if name.startswith(("loop", "ram", "dm-")):
                continue
            if (entry / "partition").exists():
                continue
            try:
                size_bytes = int((entry / "size").read_text().strip()) * 512
            except (OSError, ValueError):
                continue
            model = ""
            try:
                m = (entry / "device" / "model").read_text().strip()
                if m: model = m
            except OSError:
                pass
            item = {"name": name, "device": "/dev/" + name,
                    "model": model, "sizeBytes": size_bytes}
            # 取该盘下第一个可挂载分区的占用
            mountpoint = None
            for mp, _ in parts_by_parent.get(name, []):
                try:
                    u = _psu.disk_usage(mp)
                    item["mountpoint"] = mp
                    item["usedBytes"] = u.used
                    item["totalBytes"] = u.total
                    item["percent"] = round(u.percent)
                    mountpoint = mp
                    break
                except (PermissionError, OSError):
                    continue
            if not mountpoint:
                item["usedBytes"] = 0
                item["totalBytes"] = size_bytes
                item["percent"] = 0
            disks.append(item)
            seen.add(name)
    # 兜底：非 Linux（如开发机 macOS）仍能拿到主分区，避免界面完全没数据
    if not disks:
        # sdiskusage 没有 mountpoint 属性；用 psutil 在挂载点字典里找 /，找不到就固定 "/"
        mp = "/"
        try:
            for p in _psu.disk_partitions(all=False):
                if p.mountpoint == "/":
                    mp = "/"
                    break
        except Exception:
            pass
        disks.append({
            "name": mp,
            "device": "/",
            "model": "",
            "sizeBytes": root_disk.total,
            "usedBytes": root_disk.used,
            "totalBytes": root_disk.total,
            "percent": round(root_disk.percent),
            "mountpoint": mp,
        })
    return disks


def datetime_from_ts(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def _sensor_temps():
    """读取 CPU / 硬盘温度；容器内无权限或无传感器时返回 (None, None)。"""
    import psutil
    cpu_temp = disk_temp = None
    try:
        temps = psutil.sensors_temperatures() or {}
        for name, entries in temps.items():
            if not entries or not entries[0].current:
                continue
            low = name.lower()
            if cpu_temp is None and low.startswith(
                    ("coretemp", "k10temp", "cpu", "zenpower", "soc", "thermal")):
                cpu_temp = round(entries[0].current)
            elif disk_temp is None and (
                    low.startswith("nvme") or "drivetemp" in low or
                    low.startswith(("ata", "sd", "hdd", "smartctl"))):
                disk_temp = round(entries[0].current)
        if cpu_temp is None:  # 无法识别类型时取首个可用传感器兜底
            first = next((e for e in temps.values() if e), None)
            if first:
                cpu_temp = round(first[0].current)
    except Exception:
        pass
    return cpu_temp, disk_temp


def _uptime_text(ts: float) -> str:
    if not ts:
        return "—"
    delta = time.time() - ts
    if delta < 0:
        return "—"
    days = int(delta // 86400)
    return f"{days} 天" if days else f"{int(delta // 3600)} 小时"


def _docker_client():
    try:
        import docker
        return docker.from_env()
    except Exception:
        return None


def _online_cores(cpu_stats) -> int:
    """兼容 online_cpus 的整数（docker 新版）与数组（旧版）两种形态。"""
    oc = (cpu_stats or {}).get("online_cpus")
    if isinstance(oc, (list, tuple)):
        return len(oc) or 1
    if isinstance(oc, (int, float)) and oc >= 1:
        return int(oc)
    return 1


# 容器资源采样：两次请求间的累计增量算速率（与 docker stats 口径一致）
_CONT_LAST = {}   # container id -> {ts, cpu, sys, rx, tx}

# 单飞锁 + 短 TTL 缓存：并发请求只做一次真实采集，其余共享结果。
# 既避免轮询间隔短于采集耗时时线程池堆积放大，也让重复请求瞬时返回。
_CONT_LOCK = threading.Lock()
_CONT_CACHE = {"ts": 0.0, "data": None}
CONT_CACHE_TTL = 2.0      # 秒
CONT_MAX_WORKERS = 16     # 并行采集上限


def _fetch_container_stats(c):
    """线程池 worker：只采集 stats，不做计算。失败返回 None（保持 0）。"""
    try:
        if c.status != "running":
            return None
        return c.stats(stream=False)
    except Exception:
        return None


def _collect_containers(client):
    """真实采集：并行拉取 stats（串行 20s → 并行约 2s），再串行计算输出。"""
    out = []
    now = time.time()
    cts = client.containers.list(all=True)
    stats_by_cid = {}
    with ThreadPoolExecutor(max_workers=min(CONT_MAX_WORKERS, len(cts) or 1)) as pool:
        futures = {pool.submit(_fetch_container_stats, c): c for c in cts}
        for fut in as_completed(futures):
            stats_by_cid[futures[fut].short_id] = fut.result()
    for c in cts:
        cid = c.short_id
        stats = {"cpu": 0, "memMB": 0, "memPct": 0,
                 "netDownKBps": 0, "netUpKBps": 0}
        running = c.status == "running"
        s = stats_by_cid.get(cid)
        if running and s:
            try:
                cs = s.get("cpu_stats") or {}
                ps_ = s.get("precpu_stats") or {}
                cur = (cs.get("cpu_usage") or {}).get("total_usage", 0)
                prev = (ps_.get("cpu_usage") or {}).get("total_usage", 0)
                sys_cur = cs.get("system_cpu_usage", 0)
                sys_prev = ps_.get("system_cpu_usage", 0)
                cores = _online_cores(cs)
                last = _CONT_LAST.get(cid) or {}
                base_ts = last.get("ts", 0)
                dt = now - base_ts if base_ts else 0
                # 优先用两次轮询间的增量；首次轮询回落响应自带区间
                if base_ts and dt > 0.5 and cur >= last.get("cpu", 0) \
                        and sys_cur > last.get("sys", 0):
                    cpu_delta = cur - last["cpu"]
                    sys_delta = sys_cur - last["sys"]
                else:
                    cpu_delta = max(cur - prev, 0)
                    sys_delta = sys_cur - sys_prev
                stats["cpu"] = min(round(cpu_delta / sys_delta * 100 * cores),
                                   100 * cores) if sys_delta > 0 else 0
                # 内存：cgroup v2 下扣除页缓存，与 docker stats 口径一致
                ms = s.get("memory_stats") or {}
                usage = ms.get("usage", 0)
                page_cache = ms.get("inactive_file") or ms.get("cache") or 0
                used = max(usage - page_cache, 0)
                stats["memMB"] = round(used / 1048576)
                limit = ms.get("limit") or 0
                if limit and limit < (1 << 60):
                    stats["memPct"] = round(used / limit * 100, 1)
                # 网络：聚合全部网卡流量，按上次轮询差值折算速率
                nets = s.get("networks") or {}
                rx = sum((v or {}).get("rx_bytes", 0) for v in nets.values())
                tx = sum((v or {}).get("tx_bytes", 0) for v in nets.values())
                if base_ts and dt > 0.5 and rx >= last.get("rx", 0) \
                        and tx >= last.get("tx", 0):
                    stats["netDownKBps"] = round((rx - last["rx"]) / dt / 1024, 1)
                    stats["netUpKBps"] = round((tx - last["tx"]) / dt / 1024, 1)
                _CONT_LAST[cid] = {"ts": now, "cpu": cur, "sys": sys_cur,
                                   "rx": rx, "tx": tx}
            except Exception:
                pass
        started_ts = parse_iso(c.attrs["State"].get("StartedAt")) if running else 0
        out.append({
            "id": cid,
            "name": c.name,
            "image": (c.image.tags[0] if c.image.tags else str(c.image.short_id)),
            "status": c.status,
            "cpu": stats["cpu"],
            "memMB": stats["memMB"],
            "memPct": stats["memPct"],
            "netDownKBps": stats["netDownKBps"],
            "netUpKBps": stats["netUpKBps"],
            "upSecs": int(now - started_ts) if started_ts else 0,
            "started": _uptime_text(started_ts),
        })
    return {"available": True, "containers": out}


@router.get("/api/system/containers")
def containers(authorization: Optional[str] = Header(None)):
    _monitor_gate(authorization)
    client = _docker_client()
    if client is None:
        return {"available": False, "containers": [],
                "hint": "无法连接 Docker（本地未安装或未挂载 docker.sock）"}
    # 持锁期间并发请求排队；后来者命中刚写入的缓存直接返回，不会重复采集
    with _CONT_LOCK:
        cached = _CONT_CACHE["data"]
        if cached and time.time() - _CONT_CACHE["ts"] < CONT_CACHE_TTL:
            return cached
        try:
            data = _collect_containers(client)
        except Exception as e:
            return {"available": False, "containers": [], "hint": str(e)}
        _CONT_CACHE["ts"] = time.time()
        _CONT_CACHE["data"] = data
        return data


def parse_iso(s: str):
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


@router.post("/api/system/containers/{cid}/{action}")
def container_action(cid: str, action: str,
                     authorization: Optional[str] = Header(None)):
    _monitor_gate(authorization)
    if action not in ("restart", "stop", "start"):
        raise HTTPException(400, "不支持的操作")
    client = _docker_client()
    if client is None:
        raise HTTPException(503, "无法连接 Docker")
    try:
        c = client.containers.get(cid)
        getattr(c, action)()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"操作失败：{e}")


# ---------- 资源监控（时序采样：两次请求间的增量折算速率） ----------
_METRIC_LAST = {"ts": 0, "net": (0, 0), "disk": {}}
_GPU_CACHE = {"ts": 0, "data": None}


@router.get("/api/system/monitor-config")
def get_monitor_config(authorization: Optional[str] = Header(None)):
    """监控功能开关（默认关闭）：任何登录用户可读，用于前端控制入口可见性。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    return {"enabled": bool(cfg.get("monitorEnabled")),
            "isAdmin": cfg["users"].get(username, {}).get("role") == "admin"}


@router.put("/api/system/monitor-config")
def put_monitor_config(body: dict,
                       authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    _require_admin(username)
    cfg = storage.get_config()
    cfg["monitorEnabled"] = bool(body.get("enabled"))
    storage.save_config(cfg)
    return {"ok": True, "enabled": cfg["monitorEnabled"]}


def _gpu_metrics():
    """NVIDIA GPU：调 nvidia-smi，无卡 / 无驱动时 available=false（结果缓存 2 秒）。"""
    import shutil
    import subprocess
    now = time.time()
    if _GPU_CACHE["data"] is not None and now - _GPU_CACHE["ts"] < 2:
        return _GPU_CACHE["data"]
    data = {"available": False, "util": None, "temp": None, "name": ""}
    exe = shutil.which("nvidia-smi")
    if exe:
        try:
            out = subprocess.run(
                [exe, "--query-gpu=utilization.gpu,temperature.gpu,name",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3).stdout.strip()
            if out:
                parts = [p.strip() for p in out.splitlines()[0].split(",")]
                if len(parts) >= 2:
                    data = {"available": True,
                            "util": int(float(parts[0])),
                            "temp": int(float(parts[1])),
                            "name": parts[2] if len(parts) > 2 else ""}
        except Exception:
            pass
    _GPU_CACHE.update({"ts": now, "data": data})
    return data


@router.get("/api/system/metrics")
def system_metrics(authorization: Optional[str] = Header(None)):
    """资源监控时序数据：CPU/内存/网络/各硬盘读写速率/温度，前端定时轮询后绘制曲线。"""
    _monitor_gate(authorization)
    import psutil
    global _METRIC_LAST
    now = time.time()
    prev = _METRIC_LAST
    dt = (now - prev["ts"]) if prev["ts"] else 0
    # cpu_percent 需先预热一次才有非阻塞读数；首次调用短阻塞兜底
    cpu = psutil.cpu_percent(interval=None if prev["ts"] else 0.2)
    cpu_temp, disk_temp = _sensor_temps()
    mem = psutil.virtual_memory()
    net = psutil.net_io_counters()
    net_down = net_up = 0.0
    if prev["ts"] and dt > 0.5:
        net_down = max(net.bytes_recv - prev["net"][0], 0) / dt / 1048576
        net_up = max(net.bytes_sent - prev["net"][1], 0) / dt / 1048576
    try:
        io_all = psutil.disk_io_counters(perdisk=True) or {}
    except Exception:
        io_all = {}
    # 过滤：只保留物理硬盘，跳过分区 / loop / ram / dm-*
    # （之前直接把 perdisk 列表交给前端，导致下拉里出现 sda1、nvme0n1p1、loop0 等几十项）
    phys = _physical_disk_names()
    disks = []
    for name, io in io_all.items():
        if phys and name not in phys:
            continue
        r = w = 0.0
        p = prev["disk"].get(name)
        if prev["ts"] and p and dt > 0.5:
            r = max(io.read_bytes - p[0], 0) / dt / 1048576
            w = max(io.write_bytes - p[1], 0) / dt / 1048576
        disks.append({"name": name, "read": round(r, 2), "write": round(w, 2)})
    _METRIC_LAST = {
        "ts": now,
        "net": (net.bytes_recv, net.bytes_sent),
        "disk": {n: (io.read_bytes, io.write_bytes) for n, io in io_all.items()},
    }
    return {
        "ts": int(now),
        "cpu": round(cpu, 1),
        "cpuTemp": cpu_temp,
        "mem": round(mem.percent, 1),
        "netDown": round(net_down, 2),
        "netUp": round(net_up, 2),
        "disks": disks,
        "diskTemp": disk_temp,
        "gpu": _gpu_metrics(),
    }


# ---------- 天气（Open-Meteo 免 key） ----------
@router.get("/api/weather")
def weather(lat: float = 30.2741, lon: float = 120.1552,
            authorization: Optional[str] = Header(None)):
    require_user(authorization)
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat}&longitude={lon}"
           "&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
           "weather_code,wind_speed_10m,wind_direction_10m,uv_index"
           "&daily=weather_code,temperature_2m_max,temperature_2m_min,"
           "precipitation_probability_max"
           "&timezone=auto&forecast_days=7")
    try:
        r = httpx.get(url, timeout=10)
        data = r.json()
    except Exception as e:
        raise HTTPException(502, f"天气服务暂不可用：{e}")
    cur = data.get("current", {})
    daily = data.get("daily", {})
    code = cur.get("weather_code", 0)
    rain_list = daily.get("precipitation_probability_max") or []
    days = []
    for i in range(len(daily.get("time", []))):
        c = daily["weather_code"][i]
        days.append({
            "date": daily["time"][i],
            "cond": WMO.get(c, "未知"),
            "icon": WMO_ICON.get(c, "cloud"),
            "max": round(daily["temperature_2m_max"][i]),
            "min": round(daily["temperature_2m_min"][i]),
            "rain": rain_list[i] if i < len(rain_list) else None,
        })
    # 空气质量（独立接口，失败不影响主数据）
    aqi = None
    try:
        r = httpx.get("https://air-quality-api.open-meteo.com/v1/air-quality",
                      params={"latitude": lat, "longitude": lon,
                              "current": "us_aqi"}, timeout=8)
        aqi = r.json().get("current", {}).get("us_aqi")
    except Exception:
        pass
    return {
        "temp": round(cur.get("temperature_2m", 0)),
        "feels": round(cur.get("apparent_temperature", 0)),
        "cond": WMO.get(code, "未知"),
        "icon": WMO_ICON.get(code, "cloud"),
        "humidity": cur.get("relative_humidity_2m"),
        "windSpeed": round(cur.get("wind_speed_10m", 0)),
        "windDeg": cur.get("wind_direction_10m", 0),
        "uv": cur.get("uv_index"),
        "aqi": aqi,
        "rainProb": rain_list[0] if rain_list else None,
        "tzOffset": data.get("utc_offset_seconds", 0),
        "tzName": data.get("timezone", ""),
        "updated": time.strftime("%H:%M"),
        "days": days,
    }


def _search_openmeteo(name):
    """Open-Meteo 地名词典：仅保留可信的城市/区县级结果，
    滤掉同名村镇（无人口且非行政驻地），避免“南昌”搜出各地南昌路/村。"""
    try:
        r = httpx.get("https://geocoding-api.open-meteo.com/v1/search",
                      params={"name": name, "count": 10, "language": "zh"}, timeout=8)
        out = []
        for x in r.json().get("results", []):
            code = x.get("feature_code") or ""
            if not x.get("population") and not code.startswith(("PPLA", "ADM")):
                continue
            out.append({"city": x["name"], "lat": x["latitude"], "lon": x["longitude"],
                        "region": x.get("admin1", ""),
                        "district": x.get("admin2", "") or "",
                        "_pop": x.get("population") or 0})
        return out
    except Exception:
        return []


_PROVINCE_SUFFIX = ("壮族自治区", "维吾尔自治区", "回族自治区", "自治区", "特别行政区", "省", "市")


def _search_photon(name):
    """Photon（OSM）正向搜索：覆盖 Open-Meteo 缺失的区县，支持模糊匹配。"""
    try:
        r = httpx.get("https://photon.komoot.io/api/",
                      params={"q": name, "limit": 6},
                      headers={"User-Agent": "Mozilla/5.0 (OmniHome self-hosted portal)"},
                      timeout=8)
        out = []
        for f in r.json().get("features", []):
            p = f.get("properties", {})
            nm = p.get("name") or ""
            # 仅保留名称完全匹配的结果，排除车站 / 设施等噪音（如“抚州站”“资溪县人民法院”）
            if nm != name:
                continue
            lon, lat = (f.get("geometry") or {}).get("coordinates", (None, None))
            region = p.get("state") or ""
            for sfx in _PROVINCE_SUFFIX:
                if region.endswith(sfx):
                    region = region[:-len(sfx)]
                    break
            district = p.get("county") or p.get("city") or ""
            if district == nm:
                district = ""
            out.append({"city": nm, "lat": lat, "lon": lon,
                        "region": region, "district": district, "_pop": 0})
        return out
    except Exception:
        return []


@router.get("/api/weather/geocode")
def geocode(city: Optional[str] = None, lat: Optional[float] = None,
            lon: Optional[float] = None, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    # 经纬度 → 反向解析城市名（精确到区县；Nominatim 主源，bigdatacloud 备源，均免 key）
    if not city and lat is not None and lon is not None:
        district = ""
        try:
            r = httpx.get("https://nominatim.openstreetmap.org/reverse",
                          params={"lat": lat, "lon": lon, "format": "json",
                                  "accept-language": "zh", "zoom": 14},
                          headers={"User-Agent": "OmniHome/1.0 (self-hosted portal)"},
                          timeout=6)
            d = r.json()
            addr = d.get("address", {})
            name = (addr.get("city") or addr.get("town") or addr.get("county")
                    or addr.get("state") or d.get("name") or "")
            district = (addr.get("city_district") or addr.get("suburb")
                        or addr.get("county") or addr.get("town") or "")
            # 区县与城市同名时不重复展示（如北京市→朝阳区保留，县市级去重）
            if district and district == name:
                district = ""
        except Exception:
            name = ""
        if not name:
            try:
                r = httpx.get("https://api.bigdatacloud.net/data/reverse-geocode-client",
                              params={"latitude": lat, "longitude": lon,
                                      "localityLanguage": "zh"}, timeout=8,
                              follow_redirects=True)
                d = r.json()
                name = (d.get("city") or d.get("locality")
                        or d.get("principalSubdivision") or "")
                district = d.get("locality") or ""
                if district and district == name:
                    district = ""
            except Exception:
                name = ""
        if not name:
            return []
        return [{"city": name, "district": district,
                 "lat": lat, "lon": lon, "region": ""}]
    if not city:
        raise HTTPException(400, "请提供城市名或经纬度")
    q = city.strip()
    # 模糊搜索：原名 / 去行政后缀（抚州市→抚州） / 补后缀（抚州→抚州市、资溪→资溪县）
    base = re.sub(r"(市|县|区|省|盟|旗)$", "", q)
    candidates = [q]
    if base != q:
        candidates.append(base)
    else:
        candidates += [q + "市", q + "县"]
    results, seen = [], set()
    for name in candidates:
        for x in _search_openmeteo(name):
            k = (x["city"], x["region"])
            if k not in seen:
                seen.add(k)
                results.append(x)
    # 区县在 Open-Meteo 词典常缺失：无结果或结果过少时用 Photon 补充（不抛错，仅影响补全）
    if len(results) < 3:
        for name in candidates[:2]:
            for x in _search_photon(name):
                k = (x["city"], x["region"])
                if k not in seen:
                    seen.add(k)
                    results.append(x)
    if not results:
        raise HTTPException(502, "城市搜索失败：服务暂不可用，请稍后重试")
    # 排序：完全匹配（含去/补后缀变体）优先，其次按人口（大城市靠前），最多 6 条
    exacts = {q, base, base + "市", base + "县"}
    results.sort(key=lambda x: (x["city"] not in exacts, -x["_pop"]))
    return [{k: v for k, v in x.items() if k != "_pop"}
            for x in results[:6]]


# ---------- 每日单词 ----------
WORDS_FILE = storage.ROOT / "backend" / "data" / "words.json"


def load_words():
    return storage.read_json(WORDS_FILE, [])


@router.get("/api/dict/word")
def daily_word(date: Optional[str] = None, shuffle: bool = False,
               exclude: Optional[str] = None,
               authorization: Optional[str] = Header(None)):
    require_user(authorization)
    words = load_words()
    # 排除已加入生词本的单词（逗号分隔列表）
    if exclude:
        bad = {w.strip().lower() for w in exclude.split(",") if w.strip()}
        words = [w for w in words if w.get("word", "").lower() not in bad]
    if not words:
        raise HTTPException(404, "词库中的单词都已加入生词本")
    if shuffle:
        import random
        return random.choice(words)
    key = date or time.strftime("%Y-%m-%d")
    idx = sum(ord(ch) for ch in key) % len(words)
    return words[idx]


# ---------- 快捷导航（书签） ----------
class BookmarkIn(BaseModel):
    id: Optional[str] = None
    name: str
    url: str = ""
    cat: str = "common"
    order: int = 0
    icon: Optional[str] = None   # 空 = 自动获取站点图标；sym:i-xxx = 内置图标
    desc: Optional[str] = None
    tags: Optional[list] = None


DEFAULT_BOOKMARKS = [
    {"name": "GitHub", "url": "https://github.com", "cat": "dev"},
    {"name": "Bilibili", "url": "https://bilibili.com", "cat": "common"},
]


def _norm_bm(bm) -> dict:
    """规范化单条书签：补齐/兜底缺失字段。
    插件镜像同步、历史导入可能产出缺 name 的脏数据，
    前端 visible() 里 b.name.toLowerCase() 会直接抛 TypeError。"""
    if not isinstance(bm, dict):
        return None
    url = str(bm.get("url") or "").strip()
    name = str(bm.get("name") or "").strip() or url or "未命名"
    out = dict(bm)
    out["name"] = name
    out["url"] = url
    out.setdefault("id", uuid.uuid4().hex[:8])
    out.setdefault("cat", "common")
    out.setdefault("icon", "")
    out.setdefault("desc", "")
    tags = out.get("tags")
    out["tags"] = [str(t) for t in tags] if isinstance(tags, list) else []
    return out


def _bookmarks(username: str) -> list:
    """仅在首次使用（数据不存在）时播种默认书签；
    用户删光书签后数据仍存在（空列表），不会自动重生。
    读取时顺带规范化存量脏数据（缺 name 等），变更则回写。"""
    if not storage.user_file_exists(username, "bookmarks.json"):
        seed = []
        for i, s in enumerate(DEFAULT_BOOKMARKS):
            seed.append({"id": uuid.uuid4().hex[:8], "name": s["name"],
                         "url": s["url"], "cat": s["cat"],
                         "hue": hash(s["name"]) % 360, "order": i,
                         "icon": "", "desc": "", "tags": []})
        storage.save_user_json(username, "bookmarks.json", seed)
    data = storage.user_json(username, "bookmarks.json", [])
    norm = [n for n in (_norm_bm(b) for b in data) if n]
    if norm != data:
        storage.save_user_json(username, "bookmarks.json", norm)
    return norm


@router.get("/api/bookmarks")
def list_bookmarks(authorization: Optional[str] = Header(None)):
    return _bookmarks(require_user(authorization))


@router.post("/api/bookmarks")
def add_bookmark(body: BookmarkIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    bm = {"id": uuid.uuid4().hex[:8], "name": body.name, "url": body.url,
          "cat": body.cat or "common", "hue": hash(body.name) % 360,
          "order": len(bms), "icon": body.icon or "",
          "desc": body.desc or "", "tags": body.tags or []}
    bms.append(bm)
    storage.save_user_json(username, "bookmarks.json", bms)
    return bm


@router.put("/api/bookmarks")
def replace_bookmarks(bms: list = Body(...), authorization: Optional[str] = Header(None)):
    """整体保存（含拖拽排序后的顺序）；入库前规范化，杜绝缺字段脏数据。"""
    username = require_user(authorization)
    norm = [n for n in (_norm_bm(b) for b in bms) if n]
    storage.save_user_json(username, "bookmarks.json", norm)
    return {"ok": True}


@router.put("/api/bookmarks/{bid}")
def update_bookmark(bid: str, body: BookmarkIn,
                    authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    for bm in bms:
        if bm["id"] == bid:
            bm.update({"name": body.name, "url": body.url, "cat": body.cat,
                       "icon": body.icon or "", "desc": body.desc or "",
                       "tags": body.tags or []})
            storage.save_user_json(username, "bookmarks.json", bms)
            return bm
    raise HTTPException(404, "书签不存在")


@router.delete("/api/bookmarks/{bid}")
def delete_bookmark(bid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    bms = [b for b in bms if b["id"] != bid]
    storage.save_user_json(username, "bookmarks.json", bms)
    return {"ok": True}


# ---------- 书签分类（动态管理，书签以分类 id 引用） ----------
# 「全部」与「未分类」为内置分类：不可重命名 / 删除；「全部」位置可自由调整
DEFAULT_CATS = [{"id": "all", "name": "全部"}, {"id": "common", "name": "常用"},
                {"id": "dev", "name": "开发"}, {"id": "media", "name": "影音"},
                {"id": "none", "name": "未分类"}]
CATS_FILE = "bookmark-cats.json"


class CatIn(BaseModel):
    name: str


def _cats(username: str):
    cats = storage.user_json(username, CATS_FILE, None)
    if cats is None:   # 首次使用：播种默认分类并保留内置分类
        cats = [dict(c) for c in DEFAULT_CATS]
        storage.save_user_json(username, CATS_FILE, cats)
    if not any(c["id"] == "all" for c in cats):
        cats.insert(0, {"id": "all", "name": "全部"})
    if not any(c["id"] == "none" for c in cats):
        cats.append({"id": "none", "name": "未分类"})
    return cats


@router.get("/api/bookmark-cats")
def list_cats(authorization: Optional[str] = Header(None)):
    return _cats(require_user(authorization))


@router.post("/api/bookmark-cats")
def add_cat(body: CatIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "分类名称不能为空")
    cats = _cats(username)
    if any(c["name"] == name for c in cats):
        raise HTTPException(400, "同名分类已存在")
    cat = {"id": uuid.uuid4().hex[:8], "name": name}
    # 插在「未分类」之前，保持兜底分类始终在末尾（「全部」位置由用户自由调整）
    idx = next((i for i, c in enumerate(cats) if c["id"] == "none"), len(cats))
    cats.insert(idx, cat)
    storage.save_user_json(username, CATS_FILE, cats)
    return cat


@router.put("/api/bookmark-cats")
def replace_cats(cats: list = Body(...), authorization: Optional[str] = Header(None)):
    """整体保存（含拖拽排序后的顺序与重命名）。"""
    username = require_user(authorization)
    old = {c["id"]: c for c in _cats(username)}
    cleaned = []
    for c in cats:
        cid = c.get("id")
        name = str(c.get("name") or "").strip()
        if not cid or not name:
            continue
        item = {"id": cid, "name": name}
        if old.get(cid, {}).get("builtin"):
            item["builtin"] = True
        if c.get("hidden"):
            item["hidden"] = True
        cleaned.append(item)
    if not any(c["id"] == "all" for c in cleaned):
        cleaned.insert(0, {"id": "all", "name": "全部"})
    if not any(c["id"] == "none" for c in cleaned):
        cleaned.append({"id": "none", "name": "未分类"})
    storage.save_user_json(username, CATS_FILE, cleaned)
    return {"ok": True}


@router.put("/api/bookmark-cats/{cid}")
def rename_cat(cid: str, body: CatIn, authorization: Optional[str] = Header(None)):
    if cid in ("all", "none"):
        raise HTTPException(400, "内置分类不能重命名")
    username = require_user(authorization)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "分类名称不能为空")
    cats = _cats(username)
    target = next((c for c in cats if c["id"] == cid), None)
    if not target:
        raise HTTPException(404, "分类不存在")
    if any(c["name"] == name and c["id"] != cid for c in cats):
        raise HTTPException(400, "同名分类已存在")
    target["name"] = name
    storage.save_user_json(username, CATS_FILE, cats)
    # 书签按分类 id 引用，重命名无需改书签即可同步生效；
    # 同时规范历史数据：cat 字段不在分类列表内的书签归入未分类
    bms = _bookmarks(username)
    ids = {c["id"] for c in cats}
    fixed = False
    for bm in bms:
        if bm.get("cat") not in ids:
            bm["cat"] = "none"
            fixed = True
    if fixed:
        storage.save_user_json(username, "bookmarks.json", bms)
    return target


@router.delete("/api/bookmark-cats/{cid}")
def delete_cat(cid: str, authorization: Optional[str] = Header(None)):
    if cid == "none":
        raise HTTPException(400, "「未分类」为兜底分类，不能删除")
    if cid == "all":
        raise HTTPException(400, "「全部」为内置分类，不能删除")
    username = require_user(authorization)
    cats = _cats(username)
    if not any(c["id"] == cid for c in cats):
        raise HTTPException(404, "分类不存在")
    cats = [c for c in cats if c["id"] != cid]
    storage.save_user_json(username, CATS_FILE, cats)
    # 该分类下的书签移入未分类
    bms = _bookmarks(username)
    for bm in bms:
        if bm.get("cat") == cid:
            bm["cat"] = "none"
    storage.save_user_json(username, "bookmarks.json", bms)
    return {"ok": True}


# ---------- 站点元信息（后端代理抓取：图标 / 短标题） ----------
# 第三方图标服务（如 Google s2）在部分网络下不可达，改由后端直接抓取站点自身图标。
_FAV_CACHE = {}   # netloc -> (过期时间戳, 图标字节或 None, content_type)
_FAV_TTL = 7 * 86400
_FAV_FAIL_TTL = 600   # 失败短缓存，避免反复请求死站点
_BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def _parse_site_url(url: str):
    p = urlparse(url if re.match(r"^https?://", url) else "https://" + url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise HTTPException(400, "仅支持 http/https 网址")
    return p


def _fetch_site_icon(site_url: str, netloc: str):
    """依次尝试：首页声明的 icon 链接 → /favicon.ico → DuckDuckGo 图标源。
    成功返回 (bytes, content_type)，否则 None。"""
    headers = {"User-Agent": _BROWSER_UA}
    icon_urls = []
    try:
        r = httpx.get(site_url, headers=headers, timeout=6, follow_redirects=True)
        for m in re.finditer(r"<link[^>]+>", r.text[:60000], re.I):
            tag = m.group(0)
            if not re.search(r"rel\s*=\s*[\"']?[^\"'>\s]*icon", tag, re.I):
                continue
            hm = re.search(r"href\s*=\s*[\"']([^\"']+)", tag, re.I)
            if hm and not hm.group(1).strip().startswith("data:"):
                icon_urls.append(urljoin(str(r.url), hm.group(1).strip()))
    except Exception:
        pass
    icon_urls.append(site_url.rstrip("/") + "/favicon.ico")
    icon_urls.append(f"https://icons.duckduckgo.com/ip3/{netloc.split(':')[0]}.ico")
    for u in icon_urls:
        try:
            ri = httpx.get(u, headers=headers, timeout=6, follow_redirects=True)
            if ri.status_code != 200 or not ri.content:
                continue
            ctype = ri.headers.get("content-type", "").split(";")[0].strip()
            if not ctype.startswith("image/"):
                head = ri.content.lstrip()[:6]
                ctype = "image/svg+xml" if head.startswith((b"<svg", b"<?xml")) else ""
            if not ctype or len(ri.content) > 200_000:
                continue
            return ri.content, ctype
        except Exception:
            continue
    return None


@router.get("/api/favicon")
def favicon(url: str, authorization: Optional[str] = Header(None),
            token: Optional[str] = None):
    """站点图标代理（供 <img> 直接引用，token 以查询参数附加）。"""
    require_user(authorization, token)
    p = _parse_site_url(url)
    hit = _FAV_CACHE.get(p.netloc)
    if not hit or hit[0] <= time.time():
        got = _fetch_site_icon(p.geturl(), p.netloc)
        if len(_FAV_CACHE) > 300:
            _FAV_CACHE.clear()
        if got:
            hit = (time.time() + _FAV_TTL, got[0], got[1])
        else:
            hit = (time.time() + _FAV_FAIL_TTL, None, "")
        _FAV_CACHE[p.netloc] = hit
    if not hit[1]:
        raise HTTPException(404, "未能获取站点图标")
    return Response(content=hit[1], media_type=hit[2],
                    headers={"Cache-Control": "public, max-age=86400"})


def _short_title(t: str) -> str:
    """从网页标题提取简短站名：按分隔符取最短段。"""
    t = re.sub(r"\s+", " ", t or "").strip()
    for sep in ("|", "-", "–", "—", "_", "·", ":"):
        if sep in t:
            parts = [p.strip() for p in t.split(sep) if p.strip()]
            if parts:
                t = min(parts, key=len)
    return t[:20]


def _guess_name(netloc: str) -> str:
    """由域名猜短名：docs.bigmodel.cn → Bigmodel。"""
    host = netloc.split(":")[0].lower()
    labels = [l for l in host.split(".") if l]
    while len(labels) > 1 and labels[-1] in (
            "com", "cn", "org", "net", "io", "dev", "ai", "me", "co", "cc"):
        labels.pop()
    if len(labels) > 1 and len(labels[-1]) == 2:   # 国别码，如 com.cn
        labels.pop()
    while len(labels) > 1 and labels[0] in (
            "www", "m", "docs", "app", "api", "blog", "dev", "my"):
        labels.pop(0)
    return labels[0].capitalize() if labels else host


@router.get("/api/site-meta")
def site_meta(url: str, authorization: Optional[str] = Header(None)):
    """抓取网页标题并生成简短名称（新增书签时自动填充）。"""
    require_user(authorization)
    p = _parse_site_url(url)
    name = ""
    try:
        r = httpx.get(p.geturl(), headers={"User-Agent": _BROWSER_UA},
                      timeout=6, follow_redirects=True)
        m = re.search(r"<title[^>]*>([\s\S]*?)</title>", r.text[:60000], re.I)
        if m:
            name = _short_title(m.group(1))
    except Exception:
        pass
    return {"name": name or _guess_name(p.netloc)}


# ---------- 仪表盘布局（组件顺序 / 收纳） ----------
DEFAULT_WIDGETS = ["weather", "monitor", "quicknav", "calendar", "word",
                   "vault", "quicknote", "plan", "toolbox"]


class DashboardIn(BaseModel):
    order: list = []
    removed: list = []
    sizes: dict = {}      # 组件 id -> { col: 跨列数, h: 最小高度 px }


def _clean_sizes(sizes: dict, known: set) -> dict:
    """只保留已知组件且数值合法的尺寸，避免脏数据把卡片撑坏。"""
    out = {}
    for wid, v in (sizes or {}).items():
        if wid not in known or not isinstance(v, dict):
            continue
        item = {}
        col = v.get("col")
        if isinstance(col, (int, float)) and 3 <= col <= 12:
            item["col"] = int(col)
        h = v.get("h")
        if isinstance(h, (int, float)) and 160 <= h <= 2000:
            item["h"] = int(h)
        if item:
            out[wid] = item
    return out


@router.get("/api/dashboard")
def get_dashboard(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    d = storage.user_json(username, "dashboard.json",
                          {"order": [], "removed": [], "sizes": {}})
    d.setdefault("order", [])
    d.setdefault("removed", [])
    d.setdefault("sizes", {})
    return d


@router.put("/api/dashboard")
def put_dashboard(body: DashboardIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    known = set(DEFAULT_WIDGETS)
    order = [w for w in body.order if w in known]
    removed = [w for w in body.removed if w in known]
    storage.save_user_json(username, "dashboard.json",
                           {"order": order, "removed": removed,
                            "sizes": _clean_sizes(body.sizes, known)})
    return {"ok": True}


# ---------- 知识库（笔记，.md 文件 + 文件夹 + 常驻笔记） ----------
PINNED_TITLES = ("生词本",)
PLAN_FOLDER = "每日计划"   # 系统内置文件夹：首次拉取自动创建，不可删除（今日计划按月归档其中）
QUICK_FOLDER = "灵感速记"  # 仪表盘「灵感速记」专属文件夹：删除后拉取时自动重建（旧名「速记」自动迁移）


def _rename_quick(old: str, new: str):
    """文件夹改名工具：旧路径 → 新路径（含子路径）。"""
    def _ren(f):
        if f == old:
            return new
        if f.startswith(old + "/"):
            return new + f[len(old):]
        return f
    return _ren


def _ensure_pinned(username: str):
    """常驻笔记缺失时自动创建（删除后再次拉取即重建）；并确保「每日计划」「灵感速记」文件夹存在。"""
    idx = storage.notes_index(username)
    changed = False
    for title in PINNED_TITLES:
        hit = next((i for i in idx if i.get("title") == title), None)
        if hit:
            if not hit.get("pinned"):
                hit["pinned"] = True
                changed = True
            continue
        note_id = uuid.uuid4().hex[:8]
        idx.insert(0, {"id": note_id, "title": title, "tags": [],
                       "pinned": True, "folder": "",
                       "updated": int(time.time())})
        seed = "# 生词本\n\n从「每日单词」收藏的词汇会自动追加到这里。\n"
        storage.note_write(username, note_id, seed)
        changed = True
    if changed:
        storage.save_notes_index(username, idx)
    folders = storage.user_json(username, "notes/folders.json", [])
    changed_f = False
    # 旧版兼容：「速记」文件夹整体改名为「灵感速记」（含子路径与笔记归属）
    if "速记" in folders or any(f.startswith("速记/") for f in folders):
        ren = _rename_quick("速记", QUICK_FOLDER)
        # 改名后可能与已存在的「灵感速记」及其子路径撞名，保序去重再落库；
        # 否则重复名会撞 bm_note_folders 主键 (username, name)，每次拉取都 500。
        _seen, _merged = set(), []
        for _f in (ren(x) for x in folders):
            if _f not in _seen:
                _seen.add(_f)
                _merged.append(_f)
        folders = _merged
        idx = storage.notes_index(username)
        moved = False
        for item in idx:
            old_f = item.get("folder") or ""
            new_f = ren(old_f)
            if new_f != old_f:
                item["folder"] = new_f
                moved = True
        if moved:
            storage.save_notes_index(username, idx)
        changed_f = True
    if PLAN_FOLDER not in folders:
        folders.insert(0, PLAN_FOLDER)
        changed_f = True
    if QUICK_FOLDER not in folders:
        folders.append(QUICK_FOLDER)
        changed_f = True
    if changed_f:
        storage.save_user_json(username, "notes/folders.json", folders)


class NoteMetaIn(BaseModel):
    title: str
    tags: list = []
    folder: str = ""


@router.get("/api/notes")
def list_notes(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    _ensure_pinned(username)
    return {"notes": storage.notes_index(username),
            "folders": storage.user_json(username, "notes/folders.json", [])}


@router.post("/api/notes")
def create_note(body: NoteMetaIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    idx = storage.notes_index(username)
    note_id = uuid.uuid4().hex[:8]
    # 常驻标题兜底：始终带 pinned 标记且不进文件夹，避免产生重复副本
    pinned = body.title in PINNED_TITLES
    idx.insert(0, {"id": note_id, "title": body.title or "未命名笔记",
                   "tags": body.tags,
                   "folder": "" if pinned else (body.folder or ""),
                   "pinned": pinned,
                   "updated": int(time.time())})
    storage.save_notes_index(username, idx)
    storage.note_write(username, note_id, "")
    return idx[0]


class FolderIn(BaseModel):
    name: str


@router.post("/api/notes/folders")
def add_folder(body: FolderIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    name = (body.name or "").strip().strip("/")
    if not name:
        raise HTTPException(400, "文件夹名称不能为空")
    if any(not seg.strip() for seg in name.split("/")):
        raise HTTPException(400, "文件夹路径不合法")
    folders = storage.user_json(username, "notes/folders.json", [])
    if name in folders:
        raise HTTPException(400, "文件夹已存在")
    # 多级路径：逐级补齐缺失的上级文件夹（A/B/C → A、A/B 依次存在）
    cur = ""
    for seg in name.split("/"):
        cur = seg if not cur else cur + "/" + seg
        if cur not in folders:
            folders.append(cur)
    storage.save_user_json(username, "notes/folders.json", folders)
    return {"ok": True, "name": name}


class FoldersIn(BaseModel):
    folders: list = []


@router.put("/api/notes/folders")
def replace_folders(body: FoldersIn, authorization: Optional[str] = Header(None)):
    """整体保存文件夹列表（拖拽移动/排序后的新顺序），逐级补齐缺失父级并保留内置文件夹。"""
    username = require_user(authorization)
    seen, cleaned = set(), []
    for raw in body.folders:
        name = str(raw or "").strip().strip("/")
        if not name or name in seen:
            continue
        if any(not seg.strip() for seg in name.split("/")):
            continue
        seen.add(name)
        cleaned.append(name)
    out = []
    for name in cleaned:
        cur = ""
        for seg in name.split("/"):
            cur = seg if not cur else cur + "/" + seg
            if cur not in out:
                out.append(cur)
    if PLAN_FOLDER not in out:
        out.insert(0, PLAN_FOLDER)
    if QUICK_FOLDER not in out:
        out.append(QUICK_FOLDER)
    storage.save_user_json(username, "notes/folders.json", out)
    return {"ok": True, "folders": out}


@router.delete("/api/notes/folders/{name:path}")
def delete_folder(name: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if name == PLAN_FOLDER:
        raise HTTPException(403, "「每日计划」为系统内置文件夹，不可删除")
    folders = storage.user_json(username, "notes/folders.json", [])
    if name not in folders:
        raise HTTPException(404, "文件夹不存在")
    parent = name.rsplit("/", 1)[0] if "/" in name else ""
    prefix = name + "/"
    removed = {name} | {f for f in folders if f.startswith(prefix)}
    folders = [f for f in folders if f not in removed]
    storage.save_user_json(username, "notes/folders.json", folders)
    idx = storage.notes_index(username)
    for item in idx:
        f = item.get("folder") or ""
        # 本级与子文件夹内的笔记统一移到上级文件夹（顶层则回根目录）；
        # 子文件夹本身从列表移除，即「子文件夹一并删除」
        if f == name or f.startswith(prefix):
            item["folder"] = parent
    storage.save_notes_index(username, idx)
    return {"ok": True}


# ---------- 笔记附件：图片上传（剪贴板粘贴 / 拖拽 / 选择文件共用） ----------
_ASSET_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
                "image/webp": ".webp", "image/svg+xml": ".svg"}
_ASSET_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
_ASSET_NAME = re.compile(r"^[\w\-]+\.(?:png|jpe?g|gif|webp|svg)$", re.I)
ASSET_MAX = 5 * 1024 * 1024


@router.get("/api/notes/assets")
def list_assets(authorization: Optional[str] = Header(None)):
    """附件分区清单：.md 插图/上传的附件自动归档于此（随备份迁移）。"""
    username = require_user(authorization)
    out = []
    for name in storage.asset_list(username):
        if not _ASSET_NAME.match(name):
            continue
        raw = storage.asset_read(username, name)
        if raw is None:
            continue
        try:
            meta = json.loads(raw)
        except Exception:
            continue
        d = meta.get("d", "")
        pad = 2 if d.endswith("==") else (1 if d.endswith("=") else 0)
        out.append({"name": name, "type": meta.get("t", ""),
                    "size": len(d) * 3 // 4 - pad, "ts": meta.get("ts", 0)})
    out.sort(key=lambda a: a.get("ts") or 0, reverse=True)
    return {"assets": out}


@router.post("/api/notes/assets")
def upload_asset(file: UploadFile = File(...),
                 authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    data = file.file.read()
    if not data:
        raise HTTPException(400, "图片内容为空")
    if len(data) > ASSET_MAX:
        raise HTTPException(400, "图片过大（上限 5MB）")
    ext = _ASSET_TYPES.get((file.content_type or "").lower(), "")
    if not ext:
        ext = Path(file.filename or "").suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
    if ext not in _ASSET_MEDIA:
        raise HTTPException(400, "仅支持 png/jpg/gif/webp/svg 图片")
    # 保留原文件名便于附件分区辨识，短随机后缀防重名
    stem = re.sub(r"[^\w\u4e00-\u9fff-]", "_", Path(file.filename or "").stem)[:24]
    name = (stem or uuid.uuid4().hex[:8]) + "-" + uuid.uuid4().hex[:6] + ext
    payload = json.dumps({"t": _ASSET_MEDIA[ext],
                          "d": base64.b64encode(data).decode(),
                          "ts": int(time.time())})
    storage.asset_write(username, name, payload)
    return {"name": name, "url": "/api/notes/assets/" + name}


@router.get("/api/notes/assets/{name}")
def get_asset(name: str, authorization: Optional[str] = Header(None),
              token: Optional[str] = None):
    username = require_user(authorization, token)
    if not _ASSET_NAME.match(name):
        raise HTTPException(400, "非法附件名")
    raw = storage.asset_read(username, name)
    if raw is None:
        raise HTTPException(404, "附件不存在")
    try:
        meta = json.loads(raw)
        body = base64.b64decode(meta["d"])
    except Exception:
        raise HTTPException(500, "附件数据损坏")
    return Response(content=body, media_type=meta.get("t", "image/png"),
                    headers={"Cache-Control": "public, max-age=86400"})


@router.delete("/api/notes/assets/{name}")
def delete_asset(name: str, authorization: Optional[str] = Header(None),
                 token: Optional[str] = None):
    """删除附件。引用该附件的笔记中的 markdown 图片链接会自然变裂图，删除前请确认。"""
    username = require_user(authorization, token)
    if not _ASSET_NAME.match(name):
        raise HTTPException(400, "非法附件名")
    if storage.asset_read(username, name) is None:
        raise HTTPException(404, "附件不存在")
    storage.asset_delete(username, name)
    return {"ok": True}


# ---------- 笔记导入 / 导出（Markdown） ----------
import io as _io
import zipfile as _zipfile


# 跨平台资源垃圾：macOS zip 总带 ._xxx 与 __MACOSX/，Windows 带 Thumbs.db。
# 导入时必须过滤，否则会把资源派生文件当笔记建出来，UI 全是乱码、交互也容易出错。
_JUNK_BASENAMES = {".DS_Store", "Thumbs.db", "desktop.ini", "._.trashes"}
def _is_junk_path(path: str) -> bool:
    """是否 macOS / Windows 资源垃圾（不合法路径段或带 ._ 前缀）"""
    for seg in path.replace("\\", "/").split("/"):
        if not seg:
            continue
        if seg.startswith("._") or seg in _JUNK_BASENAMES:
            return True
        if seg == "__MACOSX":
            return True
    return False


def _safe_fs_name(s: str) -> str:
    """生成安全文件名：去除路径分隔符与控制字符，限制长度。"""
    if not s:
        return "untitled"
    s = re.sub(r"[\\/:*?\"<>|\r\n\t]", "_", s).strip(" ._")
    return (s or "untitled")[:80]


def _note_to_md(meta: dict, content: str) -> bytes:
    """单条笔记 → .md 字节（标题作 H1 + 空行 + 正文）"""
    title = meta.get("title") or "未命名笔记"
    body = (content or "").lstrip()
    # 如果正文不是以 # 开头，标题先单独放一行
    if not body.startswith("#"):
        md = f"# {title}\n\n{body}\n"
    else:
        md = f"{body}\n"
    return md.encode("utf-8")


@router.get("/api/notes/folder/export")
def export_folder_notes(path: str = "", authorization: Optional[str] = Header(None),
                        token: Optional[str] = None):
    """指定文件夹（含全部子文件夹）的笔记打包 zip；目录结构相对于所选文件夹。
    供文件夹 ⋯ 菜单「导出文件夹」使用（<a> 下载，支持 token 查询参数）。"""
    from urllib.parse import quote as _quote
    username = require_user(authorization, token)
    path = (path or "").strip().strip("/")
    if not path:
        raise HTTPException(400, "文件夹路径不能为空")
    idx = storage.notes_index(username)
    prefix = path + "/"
    picked = [m for m in idx
              if not m.get("pinned") and (m.get("folder") == path or (m.get("folder") or "").startswith(prefix))]
    if not picked:
        raise HTTPException(404, "该文件夹下没有笔记")
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        used = set()
        for m in picked:
            folder = (m.get("folder") or "").strip("/")
            rel = folder[len(path):].strip("/")            # 相对所选文件夹的子路径
            parts = [_safe_fs_name(p) for p in rel.split("/") if p] if rel else []
            arc = "/".join(parts + [_safe_fs_name(m.get("title") or m["id"]) + ".md"]) if parts \
                else (_safe_fs_name(m.get("title") or m["id"]) + ".md")
            base = arc; n = 2
            while arc in used:
                stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                arc = (f"{stem}-{n}.{ext}" if ext else f"{base}-{n}")
                n += 1
            used.add(arc)
            content = storage.note_read(username, m["id"]) or ""
            zf.writestr(arc, _note_to_md(m, content))
    buf.seek(0)
    fname = _safe_fs_name(path.rsplit("/", 1)[-1]) + ".zip"
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "folder.zip"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )


@router.get("/api/notes/{nid}/export")
def export_note_md(nid: str, authorization: Optional[str] = Header(None),
                   token: Optional[str] = None):
    """单条笔记下载为 .md 文件；含 Content-Disposition 触发浏览器另存。
    浏览器 <a> 下载带不了 Authorization 头，必须支持 token 查询参数（否则 401 变 JSON 下载）。"""
    from urllib.parse import quote as _quote
    username = require_user(authorization, token)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    meta = next((m for m in idx if m["id"] == nid), None)
    if not meta:
        raise HTTPException(404, "笔记不存在")
    content = storage.note_read(username, nid) or ""
    data = _note_to_md(meta, content)
    fname = _safe_fs_name(meta.get("title") or nid) + ".md"
    # 双形式 filename：ASCII 兜底 + RFC 5987 UTF-8（中文/空格都能正确解析）
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "note.md"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=data,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )


@router.get("/api/notes/all")
def export_all_notes(authorization: Optional[str] = Header(None),
                     token: Optional[str] = None):
    """全部笔记打包为 zip：按 folder 还原目录结构，文件名 = 标题.md。同样支持 token 查询参数供 <a> 下载。"""
    username = require_user(authorization, token)
    idx = storage.notes_index(username)
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        used = set()                                     # 防路径冲突
        for m in idx:
            if m.get("pinned") and not m.get("folder"):
                # 固定笔记（无文件夹）放根
                arc = _safe_fs_name(m.get("title") or m["id"]) + ".md"
            else:
                folder = (m.get("folder") or "").strip("/")
                parts = [_safe_fs_name(p) for p in folder.split("/") if p] if folder else []
                arc = ("/".join(parts + [_safe_fs_name(m.get("title") or m["id"]) + ".md"])) if parts \
                    else (_safe_fs_name(m.get("title") or m["id"]) + ".md")
            # 同名冲突时加短后缀
            base = arc; n = 2
            while arc in used:
                stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                arc = (f"{stem}-{n}.{ext}" if ext else f"{base}-{n}")
                n += 1
            used.add(arc)
            content = storage.note_read(username, m["id"]) or ""
            zf.writestr(arc, _note_to_md(m, content))
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="omnihome-notes.zip"',
                 "X-Content-Type-Options": "nosniff"},
    )


@router.post("/api/notes/import-md")
async def import_md(file: UploadFile = File(...),
                   authorization: Optional[str] = Header(None)):
    """导入 Markdown：
       - 单个 .md 文件 → 在「我的笔记」根目录创建一篇笔记
       - .zip 文件 → 按 zip 内的目录结构还原文件夹，逐级补齐，标题取自文件名"""
    import zipfile as _zf
    username = require_user(authorization)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    name = (file.filename or "").lower()
    # ---- 单文件 ----
    if name.endswith(".md") or file.content_type in ("text/markdown", "text/x-markdown"):
        title, content = _parse_md(raw, file.filename or "未命名笔记.md")
        return _create_imported_note(username, title, content, "")
    # ---- zip ----
    if not (name.endswith(".zip") or file.content_type in ("application/zip", "application/x-zip-compressed")):
        raise HTTPException(400, "仅支持 .md 或 .zip")
    try:
        zf = _zf.ZipFile(_io.BytesIO(raw))
        names = zf.namelist()
    except Exception as e:
        raise HTTPException(400, f"zip 解析失败：{e}")
    # 防 Zip Slip
    for n in names:
        if n.startswith("/") or ".." in n.replace("\\", "/").split("/"):
            raise HTTPException(400, f"非法路径：{n}")
    created, skipped = 0, 0
    for n in names:
        if n.endswith("/"):
            continue                                       # 目录条目
        if not n.lower().endswith(".md"):
            skipped += 1
            continue
        if _is_junk_path(n):
            # macOS 资源垃圾（._xxx、__MACOSX/…）和 Windows 缩略图——过滤掉
            skipped += 1
            continue
        path = n.replace("\\", "/").strip("/")
        # 关键：根目录下的 .md 文件（无 /）应视为 folder="" 而不是把整段路径当文件夹
        if "/" in path:
            folder, fname = path.rsplit("/", 1)
        else:
            folder, fname = "", path
        # 还原嵌套文件夹（顺序补齐父级）
        for depth in range(1, folder.count("/") + 2):
            sub = "/".join(folder.split("/")[:depth])
            if sub:
                _ensure_folder(username, sub)
        raw_md = zf.read(n)
        title, content = _parse_md(raw_md, fname)
        _create_imported_note(username, title, content, folder)
        created += 1
    return {"ok": True, "imported": created, "skipped": skipped}


class ImportedFilesIn(BaseModel):
    """前端拖拽 .md 文件 / 文件夹：每条带相对路径（如 '项目规划/前端/笔记.md'）。"""
    files: list = []              # [{path, content}, ...]


@router.post("/api/notes/import-files")
def import_files(body: ImportedFilesIn, authorization: Optional[str] = Header(None)):
    """从前端拖拽目录 / 多文件批量导入：path 视为 zip 内的相对路径，逐级补齐父文件夹。"""
    username = require_user(authorization)
    created, skipped = 0, 0
    for item in (body.files or []):
        path = (item.get("path") if isinstance(item, dict) else None) or ""
        content = (item.get("content") if isinstance(item, dict) else None) or ""
        if not path.lower().endswith(".md"):
            skipped += 1; continue
        if _is_junk_path(path):
            skipped += 1; continue
        norm = path.replace("\\", "/").strip("/")
        if not norm:
            skipped += 1; continue
        if "/" in norm:
            folder, fname = norm.rsplit("/", 1)
        else:
            folder, fname = "", norm
        for depth in range(1, folder.count("/") + 2):
            sub = "/".join(folder.split("/")[:depth])
            if sub:
                _ensure_folder(username, sub)
        raw_bytes = content.encode("utf-8") if isinstance(content, str) else content
        title, body_md = _parse_md(raw_bytes, fname)
        _create_imported_note(username, title, body_md, folder)
        created += 1
    return {"ok": True, "imported": created, "skipped": skipped}


@router.post("/api/notes/cleanup-junk")
def cleanup_junk_notes(authorization: Optional[str] = Header(None)):
    """清理 macOS zip 资源垃圾：标题以 ._ 开头的笔记、__MACOSX 文件夹（含嵌套）及其内笔记。
       一键修复 v0.2.6 之前没过滤导入导致的整树乱码。"""
    username = require_user(authorization)
    idx = storage.notes_index(username)
    folders = storage.user_json(username, "notes/folders.json", [])

    # 1. 找出垃圾文件夹（含嵌套）
    junk_folders = {f for f in folders if _is_junk_path(f)}
    kept_folders = [f for f in folders if f not in junk_folders]

    # 2. 笔记：标题 ._ 开头 / 在垃圾文件夹内 → 都删
    kept_notes = []
    deleted_notes = 0
    for n in idx:
        title_junk = n.get("title", "").startswith("._") or _is_junk_path(n.get("title", ""))
        in_junk_folder = n.get("folder", "") in junk_folders
        if title_junk or in_junk_folder:
            try:
                storage.note_delete(username, n["id"])
            except Exception:
                pass
            deleted_notes += 1
        else:
            kept_notes.append(n)

    storage.save_notes_index(username, kept_notes)
    storage.save_user_json(username, "notes/folders.json", kept_folders)

    return {"ok": True, "deleted_notes": deleted_notes,
            "deleted_folders": len(folders) - len(kept_folders)}


def _parse_md(raw: bytes, fallback_name: str) -> tuple:
    """从 .md 字节里解析出 (title, content)：若首行是 H1 则标题取 H1，否则取文件名。"""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    text = text.lstrip("\ufeff").lstrip()
    title, body = "", text
    m = re.match(r"^#\s+(.+?)\s*[\r\n]", text)
    if m:
        title = m.group(1).strip()
        body = text[m.end():].lstrip("\n")
    if not title:
        title = Path(fallback_name).stem or "未命名笔记"
    return title, body


def _ensure_folder(username: str, folder: str):
    """不存在则创建（与 /api/notes/folders 同语义，逐级补齐父级）"""
    folder = (folder or "").strip("/")
    if not folder:
        return
    folders = storage.user_json(username, "notes/folders.json", [])
    if folder in folders:
        return
    cur = ""
    for seg in folder.split("/"):
        cur = seg if not cur else cur + "/" + seg
        if cur not in folders:
            folders.append(cur)
    storage.save_user_json(username, "notes/folders.json", folders)


def _create_imported_note(username: str, title: str, content: str, folder: str) -> dict:
    """创建一篇笔记（避免与现有标题冲突，重复自动加序号）。"""
    idx = storage.notes_index(username)
    used = {m["title"] for m in idx}
    final = title
    n = 2
    while final in used:
        final = f"{title} ({n})"
        n += 1
    note_id = uuid.uuid4().hex[:8]
    idx.insert(0, {"id": note_id, "title": final, "tags": [],
                   "folder": folder, "pinned": False,
                   "updated": int(time.time())})
    storage.save_notes_index(username, idx)
    storage.note_write(username, note_id, content or "")
    return idx[0]





@router.get("/api/notes/{nid}")
def get_note(nid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    if not any(i["id"] == nid for i in idx):
        raise HTTPException(404, "笔记不存在")
    return {"id": nid, "content": storage.note_read(username, nid)}


class NoteContentIn(BaseModel):
    content: Optional[str] = None
    title: Optional[str] = None
    tags: Optional[list] = None
    folder: Optional[str] = None
    readonly: Optional[bool] = None


@router.put("/api/notes/{nid}")
def save_note(nid: str, body: NoteContentIn,
              authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    if not any(i["id"] == nid for i in idx):
        raise HTTPException(404, "笔记不存在")
    if body.content is not None:
        storage.note_write(username, nid, body.content)
    for item in idx:
        if item["id"] == nid:
            item["updated"] = int(time.time())
            if body.title is not None:
                item["title"] = body.title
                # 改成常驻标题（或常驻笔记被保存）时强制归位，避免重复副本
                if body.title in PINNED_TITLES:
                    item["pinned"] = True
                    item["folder"] = ""
            if body.tags is not None:
                item["tags"] = body.tags
            if body.folder is not None and not item.get("pinned"):
                item["folder"] = body.folder
            if body.readonly is not None:
                item["readonly"] = bool(body.readonly)
    idx.sort(key=lambda x: x["updated"], reverse=True)
    storage.save_notes_index(username, idx)
    return {"ok": True}


@router.delete("/api/notes/{nid}")
def delete_note(nid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    storage.note_delete(username, nid)
    idx = [i for i in storage.notes_index(username) if i["id"] != nid]
    storage.save_notes_index(username, idx)
    return {"ok": True}


# ---------- 今日计划（plan.md，已弃用：仪表盘改绑知识库常驻笔记） ----------
class PlanIn(BaseModel):
    content: str


@router.get("/api/plan")
def get_plan(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    return {"content": storage.user_text(username, "plan.md", "- [ ] \n")}


@router.put("/api/plan")
def put_plan(body: PlanIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    storage.save_user_text(username, "plan.md", body.content)
    return {"ok": True}


# ---------- 日历 ----------
class EventIn(BaseModel):
    date: str          # YYYY-MM-DD
    title: str
    note: str = ""


@router.get("/api/calendar")
def get_events(month: str = "", authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = storage.user_json(username, "calendar.json", [])
    if month and re.match(r"^\d{4}-\d{2}$", month):
        # 返回当月 + 相邻月需要的范围（前端直接全量也可，数据量小）
        pass
    return events


@router.post("/api/calendar")
def add_event(body: EventIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = storage.user_json(username, "calendar.json", [])
    ev = {"id": uuid.uuid4().hex[:8], "date": body.date,
          "title": body.title, "note": body.note}
    events.append(ev)
    events.sort(key=lambda e: e["date"])
    storage.save_user_json(username, "calendar.json", events)
    return ev


@router.delete("/api/calendar/{eid}")
def delete_event(eid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = [e for e in storage.user_json(username, "calendar.json", [])
              if e["id"] != eid]
    storage.save_user_json(username, "calendar.json", events)
    return {"ok": True}


# ---------- 密码保险库（零知识：服务端只存密文） ----------
class VaultBlob(BaseModel):
    id: str
    blob: str       # base64(AES-GCM 密文)
    meta: dict = {} # 仅存非敏感元数据（站点名），由客户端决定是否加密


class VaultSaveIn(BaseModel):
    check: Optional[str] = None   # 主密码校验密文
    salt: Optional[str] = None    # PBKDF2 盐（非敏感）
    items: Optional[dict] = None  # id -> {blob, meta}


@router.get("/api/vault")
def get_vault(authorization: Optional[str] = Header(None)):
    return storage.user_json(require_user(authorization), "vault.json",
                             {"check": None, "items": {}})


@router.put("/api/vault")
def put_vault(body: VaultSaveIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    vault = storage.user_json(username, "vault.json", {"check": None, "items": {}})
    if body.check is not None:
        vault["check"] = body.check
    if body.salt is not None:
        vault["salt"] = body.salt
    if body.items is not None:
        vault["items"] = body.items
    vault["updatedAt"] = int(time.time())
    storage.save_user_json(username, "vault.json", vault)
    return {"ok": True}


# ---------- 工具箱：翻译代理（Google gtx 主引擎 + MyMemory 备源） ----------
def _gt_translate(src_lang: str, tgt_lang: str, text: str) -> str:
    r = httpx.get("https://translate.googleapis.com/translate_a/single",
                  params={"client": "gtx", "sl": src_lang, "tl": tgt_lang,
                          "dt": "t", "q": text}, timeout=6)
    data = r.json()
    return "".join(seg[0] for seg in data[0] if seg and seg[0])


@router.get("/api/tools/translate")
def translate(text: str, source: str = "zh-CN", target: str = "en",
              authorization: Optional[str] = Header(None)):
    require_user(authorization)
    text = text[:500]

    def call_mymemory(src_lang, tgt_lang):
        r = httpx.get("https://api.mymemory.translated.net/get",
                      params={"q": text, "langpair": f"{src_lang}|{tgt_lang}"},
                      timeout=12)
        return r.json()

    # 主引擎：Google（质量优先）；网络不可达时自动回退 MyMemory
    try:
        out = _gt_translate(source, target, text)
        if out.strip():
            return {"translation": out}
    except Exception:
        pass
    try:
        data = call_mymemory(source, target)
        if str(data.get("responseStatus")) != "200" and "zh" in source + target:
            # MyMemory 对 zh-CN 偶发不识别，降级为 zh 再试一次（双向兼容）
            alt_s = "zh" if source == "zh-CN" else source
            alt_t = "zh" if target == "zh-CN" else target
            data = call_mymemory(alt_s, alt_t)
        if str(data.get("responseStatus")) == "200":
            return {"translation": data["responseData"]["translatedText"]}
        detail = str(data.get("responseDetails") or "")[:80]
        raise HTTPException(502, f"翻译服务返回异常：{detail}" if detail else "翻译服务返回异常")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"翻译服务暂不可用：{e}")


# ---------- 全局搜索：站内检索 ----------
@router.get("/api/search/site")
def site_search(q: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    q = q.strip().lower()
    results = []
    if not q:
        return results
    for bm in _bookmarks(username):
        if q in bm.get("name", "").lower() or q in bm.get("url", "").lower():
            results.append({"type": "bookmark", "title": bm["name"],
                            "sub": bm.get("url", ""), "go": "bookmarks"})
    for item in storage.notes_index(username):
        if q in item.get("title", "").lower():
            results.append({"type": "note", "title": item["title"],
                            "sub": "笔记", "go": "notes", "id": item["id"]})
    # 笔记正文
    for item in storage.notes_index(username):
        if q in storage.note_read(username, item["id"]).lower():
            if not any(r.get("id") == item["id"] for r in results):
                results.append({"type": "note", "title": item["title"],
                                "sub": "正文命中", "go": "notes", "id": item["id"]})
    plan = storage.user_text(username, "plan.md")
    if q in plan.lower():
        for line in plan.splitlines():
            if q in line.lower():
                results.append({"type": "plan", "title": line.strip("- []x"),
                                "sub": "今日计划", "go": "dashboard"})
                break
    vault = storage.user_json(username, "vault.json", {"items": {}})
    for _, v in vault.get("items", {}).items():
        name = v.get("meta", {}).get("name", "")
        if name and q in name.lower():
            results.append({"type": "vault", "title": name,
                            "sub": "保险库条目", "go": "vault"})
    for ev in storage.user_json(username, "calendar.json", []):
        if q in ev.get("title", "").lower():
            results.append({"type": "event", "title": ev["title"],
                            "sub": f"日程 · {ev['date']}", "go": "dashboard"})
    return results[:20]


# ---------- AI 智能（用户自带模型，兼容 OpenAI Chat Completions 格式） ----------
AI_FILE = "ai.json"


def _ai_cfg(username: str) -> dict:
    """读取 AI 配置；若密钥仍是历史明文，就地升级为密文后回写。"""
    cfg = storage.user_json(username, AI_FILE,
                            {"endpoint": "", "apiKey": "", "model": "",
                             "enabled": False})
    key = cfg.get("apiKey") or ""
    if key and not secretbox.is_encrypted(key):
        cfg["apiKey"] = secretbox.encrypt(key)
        storage.save_user_json(username, AI_FILE, cfg)
    return cfg


def _ai_key(cfg: dict) -> str:
    """取出可用的明文密钥（解密失败时返回空串，调用方按未配置处理）。"""
    return secretbox.decrypt(cfg.get("apiKey") or "")


def _ai_public(cfg: dict) -> dict:
    """返回给前端的配置（不回传密钥本身，仅告知是否已配置）"""
    return {"endpoint": cfg.get("endpoint", ""), "model": cfg.get("model", ""),
            "enabled": bool(cfg.get("enabled")),
            "hasKey": bool(_ai_key(cfg))}


class AiConfigIn(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None   # 空字符串 = 保留已有密钥；也支持整串清除标记 "__clear__"
    model: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("/api/ai-config")
def get_ai_config(authorization: Optional[str] = Header(None)):
    return _ai_public(_ai_cfg(require_user(authorization)))


@router.put("/api/ai-config")
def put_ai_config(body: AiConfigIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if body.endpoint is not None:
        cfg["endpoint"] = body.endpoint.strip()
    if body.model is not None:
        cfg["model"] = body.model.strip()
    if body.enabled is not None:
        cfg["enabled"] = bool(body.enabled)
    if body.apiKey == "__clear__":
        cfg["apiKey"] = ""
    elif body.apiKey:
        cfg["apiKey"] = secretbox.encrypt(body.apiKey.strip())   # 只存密文
    storage.save_user_json(username, AI_FILE, cfg)
    return _ai_public(cfg)


def _ai_chat(cfg: dict, messages: list, max_tokens: int = 400) -> str:
    """调用用户配置的 OpenAI 兼容接口，返回模型文本。"""
    api_key = _ai_key(cfg)          # 库里存的是密文，取出时解密
    if not cfg.get("endpoint") or not api_key or not cfg.get("model"):
        raise HTTPException(400, "AI 尚未配置完整（接口地址 / API Key / 模型）")
    url = cfg["endpoint"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    try:
        r = httpx.post(url,
                       headers={"Authorization": f"Bearer {api_key}"},
                       json={"model": cfg["model"], "messages": messages,
                             "temperature": 0.2, "max_tokens": max_tokens},
                       timeout=30)
    except Exception as e:
        raise HTTPException(502, f"无法连接 AI 接口：{e}")
    if r.status_code != 200:
        raise HTTPException(502, f"AI 接口返回 {r.status_code}：{r.text[:120]}")
    data = r.json()
    return data["choices"][0]["message"]["content"]


@router.post("/api/ai/test")
def ai_test(body: Optional[AiConfigIn] = None,
            authorization: Optional[str] = Header(None)):
    """连通性测试：可直接携带表单中尚未保存的配置（空字段回落已保存值）。"""
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if body:
        if body.endpoint:
            cfg["endpoint"] = body.endpoint.strip()
        if body.model:
            cfg["model"] = body.model.strip()
        if body.apiKey and body.apiKey != "__clear__":
            # 仅覆盖内存副本用于试连（decrypt 遇明文会原样返回），不会写回存储
            cfg["apiKey"] = body.apiKey.strip()
    _ai_chat(cfg, [{"role": "user", "content": "连接测试，只需回复 OK"}], max_tokens=8)
    return {"ok": True}


class AiBookmarkIn(BaseModel):
    name: str = ""
    url: str = ""
    desc: str = ""
    cats: list = []   # [{id, name}] 供模型选择的分类列表


def _extract_json(text: str):
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return None
    import json
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


@router.post("/api/ai/analyze-bookmark")
def ai_analyze_bookmark(body: AiBookmarkIn, authorization: Optional[str] = Header(None)):
    """AI 分析书签：推荐分类、生成一句话描述与标签。"""
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if not cfg.get("enabled"):
        raise HTTPException(400, "AI 智能未启用，请先在设置 → AI 智能中配置")
    cat_names = "、".join(c.get("name", "") for c in body.cats if c.get("name")) or "无"
    prompt = (
        "分析以下书签并返回严格 JSON（不要输出任何其他内容）：\n"
        f"名称：{body.name}\n网址：{body.url}\n已有描述：{body.desc}\n"
        f"可选分类：{cat_names}\n"
        '返回格式：{"cat": "最合适的分类名，无合适分类则为空字符串", '
        '"desc": "一句话描述（不超过20字）", '
        '"tags": ["标签1", "标签2", "标签3"]（2-4个，简短）}')
    text = _ai_chat(cfg, [{"role": "user", "content": prompt}])
    data = _extract_json(text)
    if not data:
        raise HTTPException(502, "AI 返回内容无法解析，请重试")
    # 分类名 → 分类 id（模型返回不在列表内则不采纳）
    cat_id = ""
    want = str(data.get("cat") or "").strip()
    for c in body.cats:
        if c.get("name") == want:
            cat_id = c.get("id", "")
            break
    tags = [str(t).strip() for t in (data.get("tags") or [])
            if str(t).strip()][:6]
    return {"catId": cat_id, "desc": str(data.get("desc") or "").strip()[:60],
            "tags": tags}


# ---------- 数据管理：存储引擎 / 备份 / 导出 ----------
DEFAULT_BACKUP_CFG = {"auto": False, "intervalHours": 24, "keep": 10,
                      "lastAuto": 0}


def _backup_cfg(username: str) -> dict:
    cfg = dict(DEFAULT_BACKUP_CFG)
    cfg.update(storage.user_json(username, "backup.json", {}))
    return cfg


def _require_admin(username: str):
    cfg = storage.get_config()
    if cfg["users"].get(username, {}).get("role") != "admin":
        raise HTTPException(403, "仅管理员可执行该操作")


@router.get("/api/data/stats")
def data_stats(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    stats = storage.storage_stats(username)
    backups = sorted(storage.backup_dir(username).glob("*.zip"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    stats["backupList"] = [
        {"name": p.name, "size": p.stat().st_size,
         "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime))}
        for p in backups[:20]]
    stats["backupCfg"] = _backup_cfg(username)
    stats["engine"] = storage.engine()
    return stats


# ---------- 存储引擎（文件 / SQLite / 外部数据库） ----------
class StorageIn(BaseModel):
    engine: str        # file | sqlite | db
    url: str = ""      # engine=db 时为 SQLAlchemy 连接串


def _mask_url(url: str) -> str:
    """回显连接串时隐藏密码。"""
    return re.sub(r"://([^:/@]+):[^@]+@", r"://\1:****@", url or "")


def _parse_db_url(url: str) -> dict:
    """把 SQLAlchemy 连接串拆解为表单字段（不含密码明文）。"""
    from sqlalchemy.engine import make_url
    u = make_url(url)
    drv = (u.drivername or "").lower()
    db_type = "postgresql" if drv.startswith("postgresql") else "mysql"
    return {"dbType": db_type, "host": u.host or "", "port": u.port or 0,
            "username": u.username or "", "database": u.database or "",
            "hasPassword": u.password is not None}


def _resolve_db_url(url: str) -> str:
    """密码留空且其余连接信息与已保存配置一致时，复用已保存的密码；
    否则要求显式提供密码（避免误把掩码串 / 无密串提交入库）。"""
    from sqlalchemy.engine import make_url
    try:
        u = make_url(url)
    except Exception:
        raise HTTPException(400, "数据库连接信息格式不正确")
    if u.password:
        return url
    old = storage.storage_cfg().get("url", "")
    if old:
        try:
            o = make_url(old)
            if ((o.drivername, o.host, o.port, o.username, o.database) ==
                    (u.drivername, u.host, u.port, u.username, u.database)):
                return o.render_as_string(hide_password=False)
        except Exception:
            pass
    raise HTTPException(400, "请填写数据库密码")


@router.get("/api/data/storage")
def get_storage(authorization: Optional[str] = Header(None)):
    require_user(authorization)
    st = storage.storage_cfg()
    resp = {"engine": storage.engine(),
            "url": _mask_url(st.get("url", "")),
            "sqliteFile": str(storage.SQLITE_FILE)}
    if st.get("url"):
        try:
            resp["dbCfg"] = _parse_db_url(st["url"])
        except Exception:
            pass
    return resp


class StorageTestIn(BaseModel):
    engine: str = "db"
    url: str = ""


@router.post("/api/data/storage-test")
def test_storage(body: StorageTestIn, authorization: Optional[str] = Header(None)):
    """仅测试目标数据库连接（不迁移，仅管理员）。"""
    username = require_user(authorization)
    _require_admin(username)
    try:
        url = _resolve_db_url(body.url.strip()) if body.engine == "db" else body.url.strip()
        storage.test_db_conn(url)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"连接失败：{e}")
    return {"ok": True}


@router.post("/api/data/storage")
def switch_storage(body: StorageIn, authorization: Optional[str] = Header(None)):
    """测试目标连接 → 迁移全部用户数据 → 切换引擎（仅管理员）。"""
    username = require_user(authorization)
    _require_admin(username)
    try:
        url = (_resolve_db_url(body.url.strip()) if body.engine == "db"
               else body.url.strip())
        moved = storage.migrate_storage(body.engine, url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"迁移失败：{e}")
    return {"ok": True, "engine": storage.engine(), "moved": moved}


# ---------- 备份配置（定时备份 / 保留份数） ----------
class BackupCfgIn(BaseModel):
    auto: bool = False
    intervalHours: int = 24
    keep: int = 10


@router.put("/api/data/backup-config")
def put_backup_cfg(body: BackupCfgIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = _backup_cfg(username)
    cfg["auto"] = bool(body.auto)
    cfg["intervalHours"] = min(max(int(body.intervalHours), 1), 24 * 30)
    cfg["keep"] = min(max(int(body.keep), 1), 100)
    storage.save_user_json(username, "backup.json", cfg)
    return cfg


@router.post("/api/data/backup")
def do_backup(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    path = storage.create_backup(username, "backup")
    storage.prune_backups(username, _backup_cfg(username).get("keep", 10))
    return {"ok": True, "name": path.name,
            "size": path.stat().st_size}


@router.get("/api/data/backup/{name}")
def download_backup(name: str, authorization: Optional[str] = Header(None),
                    token: Optional[str] = None):
    username = require_user(authorization, token)
    if not re.match(r"^[\w\-\.]+\.zip$", name):
        raise HTTPException(400, "非法文件名")
    path = storage.backup_dir(username) / name
    if not path.exists():
        raise HTTPException(404, "备份不存在")
    return FileResponse(str(path), filename=name)


# ---------- 浏览器扩展安装包 ----------
# 部署包根目录若放置 omnihome-extension.zip，即可在「设置 → 功能设置」下载；
# 未放置时接口如实告知，前端禁用下载按钮。
EXTENSION_ZIP = storage.ROOT / "omnihome-extension.zip"


@router.get("/api/extension/check")
def extension_check():
    """扩展安装包是否可用（随部署包分发时存在），附带包内扩展版本号。"""
    if not EXTENSION_ZIP.exists():
        return {"available": False, "size": 0, "version": ""}
    version = ""
    try:
        import zipfile as _zf
        with _zf.ZipFile(str(EXTENSION_ZIP)) as z:
            # 包内路径可能是 manifest.json 或 ./manifest.json，按后缀匹配兜底
            name = next((n for n in z.namelist()
                         if n.lstrip('./').split('/')[-1] == 'manifest.json'), None)
            if name:
                version = json.loads(z.read(name)).get("version", "")
    except Exception:
        pass   # 版本读取失败不影响可用性判断
    return {"available": True, "size": EXTENSION_ZIP.stat().st_size, "version": version}


@router.get("/api/extension.zip")
def download_extension(authorization: Optional[str] = Header(None),
                       token: Optional[str] = None):
    require_user(authorization, token)
    if not EXTENSION_ZIP.exists():
        raise HTTPException(
            404, "未找到扩展安装包：请将 omnihome-extension.zip 放到部署包根目录")
    return FileResponse(str(EXTENSION_ZIP), filename="omnihome-extension.zip")


class RestoreIn(BaseModel):
    name: str


@router.post("/api/data/restore")
def restore_backup(body: RestoreIn, authorization: Optional[str] = Header(None)):
    """用指定备份覆盖当前用户数据（备份文件本身不受影响）。"""
    username = require_user(authorization)
    if not re.match(r"^[\w\-\.]+\.zip$", body.name or ""):
        raise HTTPException(400, "非法备份名")
    try:
        count = storage.restore_backup(username, body.name)
    except FileNotFoundError:
        raise HTTPException(404, "备份不存在")
    except Exception as e:
        raise HTTPException(500, f"恢复失败：{e}")
    return {"ok": True, "restored": count}


@router.get("/api/data/export")
def export_all(authorization: Optional[str] = Header(None),
               token: Optional[str] = None):
    username = require_user(authorization, token)
    path = storage.create_backup(username, "export")
    return FileResponse(str(path), filename=f"omnihome-{username}-export.zip")


class WipeIn(BaseModel):
    password: str = ""


@router.delete("/api/data/wipe")
def wipe_data(body: WipeIn = Body(...),
              authorization: Optional[str] = Header(None)):
    """清空当前用户全部数据（保留账号与偏好）：需输入登录密码确认。"""
    username = require_user(authorization)
    u = storage.get_config()["users"].get(username)
    if not u or not verify_password(body.password, u["password"]):
        raise HTTPException(400, "登录密码不正确，无法清空数据")
    storage.wipe_user_data(username)
    return {"ok": True}
