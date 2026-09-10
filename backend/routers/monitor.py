"""万事屋 · 系统监控"""
from __future__ import annotations

import re
import hashlib
import secrets
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
from fastapi import APIRouter, Body, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import storage
import secretbox
import teams
from sessions import require_user, verify_password

router = APIRouter()
from routers.common import _require_admin

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

_CONT_LAST = {}   # container id -> {ts, cpu, sys, rx, tx}

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

