"""万事屋 · 系统监控"""
from __future__ import annotations

import re
import os
import stat
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
    root_disk = psutil.disk_usage("/")
    _host_net = _host_net_totals()
    if _host_net is None:                    # 没挂宿主根时退回容器自己的网卡
        _n = psutil.net_io_counters()
        _host_net = (_n.bytes_recv, _n.bytes_sent)
    net_down_bytes, net_up_bytes = _host_net
    summary = _storage_summary(root_disk)
    cpu_temp, disk_temp = _sensor_temps()
    boot_ts = psutil.boot_time()
    boot = datetime_from_ts(boot_ts)
    gpu = _gpu_metrics()
    return {
        "host": _host_hostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "osName": _host_os_name(),
        "cpu": round(cpu),
        "cpuCount": psutil.cpu_count(logical=True),
        "cpuName": _cpu_name(),
        "temp": cpu_temp,
        "diskTemp": disk_temp,
        "gpuName": (gpu.get("name") or "") if gpu.get("available") else "",
        "gpuAvailable": bool(gpu.get("available")),
        "mem": round(mem.percent),
        "memUsedGB": round(mem.used / 1073741824, 1),
        "memTotalGB": round(mem.total / 1073741824, 1),
        "disk": summary["percent"],
        "diskUsedTB": summary["usedTB"],
        "diskTotalTB": summary["totalTB"],
        # scope=host 表示数据来自宿主真实文件系统；container=没挂宿主根，退回容器视角
        "storageScope": summary["scope"],
        "diskVolumes": summary["volumes"],
        # 网络：算出真正的速率（MB/s），不是累计字节。
        # 累计字节 / 1024² 会随启动时间无限增长，曾被前端错误标注为 "MB/s"。
        # 现在跨请求用 module-level 状态机保存上一次快照，按 dt 求速率。
        "netUpMbps": round(_net_rate('up', net_up_bytes), 2),
        "netDownMbps": round(_net_rate('down', net_down_bytes), 2),
        "disks": _physical_disks(root_disk),
        "bootTime": boot,
        "uptime": _format_uptime(time.time() - boot_ts),
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

# ---------------------------------------------------------------------------
# 宿主信息采集（修复：监控面板把「容器视角」当成了整机真相）
#
# 本模块跑在容器里，直接用 psutil 读到的全是容器自己的：
#   · psutil.disk_usage("/")   → 容器 overlay（落在 Docker data-root 那个阵列上），
#                                于是总览只剩 0.9T，真正出数据的 RAID1 阵列根本不出现
#   · psutil.disk_partitions() → 只有容器自己的挂载（/etc/hosts 之类），
#                                宿主 /volume1、/volume2 一个都看不见 → 每块盘 used=0 / 0%
#   · psutil.net_io_counters() → 只有容器自己的网卡（netns 隔离）
# 容器里唯一没被隔离的是 /sys（块设备不随 mount namespace 隔离），
# 所以「盘的数量/型号/裸容量」能从 /sys/block 正确读出；挂载点与使用率必须借助
# 只读挂载的宿主根：
#     docker run ... -v /:/host:ro        （见 omnihome_git_upgrade.sh 的 RUN_ARGS）
# 拿不到宿主根时不再谎报 0%，而是把 usedBytes/percent 置 None，前端显示「—」。
# ---------------------------------------------------------------------------

_HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))
_HOST_SKIP_MOUNTS = {"dev", "run", "tmp", "sys", "proc"}


def _host_root_available() -> bool:
    """宿主根是否按只读方式挂进来了（运行参数里加 -v /:/host:ro）。"""
    try:
        return _HOST_ROOT.is_dir() and (_HOST_ROOT / "etc").is_dir()
    except OSError:
        return False


def _is_physical_disk(name: str) -> bool:
    """真盘判定：/sys/block/<n>/device 存在。

    真盘（sda / nvme0n1 / mmcblk0 …）有 device 链接指向硬件；md1、dm-0、zram0、
    loop0、ram0 都没有 —— 比枚举驱动名通用。旧实现只排除 loop/ram/dm-，
    于是 md1/md2/zram0-3 也被当成物理盘，4 块盘显示成 10 块。
    """
    if name.startswith(("loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd")):
        return False
    entry = Path("/sys/block") / name
    try:
        if not entry.exists() or (entry / "partition").exists():
            return False
        return (entry / "device").exists()
    except OSError:
        return False


def _physical_disk_names() -> set:
    """本机所有物理硬盘名（sda / nvme0n1 / mmcblk0 …）。"""
    sb = Path("/sys/block")
    if not sb.exists():
        return set()
    return {e.name for e in sb.iterdir() if _is_physical_disk(e.name)}


def _device_name_of(dev_id: int) -> str:
    """st_dev → 块设备名（sda2 / dm-0 / md1 …）。"""
    maj, minr = os.major(dev_id), os.minor(dev_id)
    link = Path("/sys/dev/block/%d:%d" % (maj, minr))
    try:
        if link.exists():
            return link.resolve().name
    except OSError:
        pass
    return "%d:%d" % (maj, minr)


def _parent_device_name(name: str) -> str:
    """分区名 → 父设备名：sda2→sda、nvme0n1p7→nvme0n1、mmcblk0p1→mmcblk0。

    不能直接用 ^(.*?)(\\d+)$ 这种懒惰正则：nvme0n1p7 会被切成 "nvme0n1p"
    （`p` 不是数字但会被留在前缀里），于是 NVMe 盘上的分区永远找不到父盘 ——
    这也是旧实现里 nvme 盘占用一直显示 0 的原因之一。必须显式吃掉 p 分隔符。
    """
    m = __import__("re").match(r"^(.*?)p?(\d+)$", name)
    return m.group(1) if m else name


def _resolve_physical_disks(name: str, depth: int = 0) -> set:
    """沿 sysfs 的 slaves 链回溯到物理盘。

    dm-1 → md2 → nvme1n1p2 → nvme1n1（RAID / LVM / 加密一层层剥到真盘）
    sda2 → sda
    """
    if depth > 4 or not name:
        return set()
    entry = Path("/sys/class/block") / name
    try:
        if not entry.exists():
            return set()
        slaves = entry / "slaves"
        if slaves.exists():
            subs = [s.name for s in slaves.iterdir()]
            if subs:
                out = set()
                for s in subs:
                    out |= _resolve_physical_disks(s, depth + 1)
                return out
        if (entry / "partition").exists():
            parent = _parent_device_name(name)
            return _resolve_physical_disks(parent, depth + 1) if parent != name else set()
    except OSError:
        return set()
    return {name} if _is_physical_disk(name) else set()


def _host_volumes() -> list:
    """宿主真实文件系统明细。

    容器内 /proc/mounts 是容器自己的，读不到宿主挂载表，所以改成
    「扫描只读挂载的宿主根顶层 + 用 st_dev 判断哪些是真挂载点」。
    同一设备被挂载多次（UGOS 上 /volume1 与 /home 同源）合并成一条，
    mountpoints 里列出全部挂载点，避免容量被重复累加。
    """
    if not _host_root_available():
        return []
    try:
        base_dev = os.stat(_HOST_ROOT).st_dev
    except OSError:
        return []
    vols = {}
    for entry in sorted(_HOST_ROOT.iterdir()):
        try:
            st = os.stat(entry, follow_symlinks=False)
        except OSError:
            continue
        if not stat.S_ISDIR(st.st_mode) or st.st_dev == base_dev:
            continue
        if entry.name in _HOST_SKIP_MOUNTS:
            continue
        if os.major(st.st_dev) == 0:            # tmpfs / devtmpfs 等虚拟文件系统
            continue
        devname = _device_name_of(st.st_dev)
        disks = sorted(_resolve_physical_disks(devname))
        if not disks:                            # 不落在物理盘上（overlay 叠层、nfs 共享…）
            continue
        try:
            sv = os.statvfs(entry)
        except OSError:
            continue
        total = sv.f_blocks * sv.f_frsize
        if total <= 0:
            continue
        used = total - sv.f_bfree * sv.f_frsize
        free = sv.f_bavail * sv.f_frsize
        if devname in vols:
            vols[devname]["mountpoints"].append("/" + entry.name)
            continue
        vols[devname] = {
            "mountpoint": "/" + entry.name,
            "mountpoints": ["/" + entry.name],
            "device": devname,
            "disks": disks,
            "totalBytes": total,
            "usedBytes": used,
            "freeBytes": free,
            "percent": round(used / total * 100) if total else 0,
        }
    return list(vols.values())


def _storage_summary(root_disk) -> dict:
    """总览存储：宿主所有真实卷合计；拿不到宿主信息才退回容器自身（并标 scope）。"""
    vols = _host_volumes()
    if vols:
        total = sum(v["totalBytes"] for v in vols)
        used = sum(v["usedBytes"] for v in vols)
        return {
            "scope": "host",
            "percent": round(used / total * 100) if total else 0,
            "usedTB": round(used / 1099511627776, 1),
            "totalTB": round(total / 1099511627776, 1),
            "volumes": vols,
        }
    return {
        "scope": "container",
        "percent": round(root_disk.percent),
        "usedTB": round(root_disk.used / 1099511627776, 1),
        "totalTB": round(root_disk.total / 1099511627776, 1),
        "volumes": [],
    }


def _physical_disks(root_disk=None) -> list:
    """每块物理硬盘的容量与占用。

    占用由「这块盘承载的宿主文件系统」汇总得出（sda+sdb 组成 RAID1 → 两块盘都显示
    该阵列的 33%）；拿不到宿主信息时不谎报 0%，usedBytes/percent 留 None。
    返回 [{name, device, model, sizeBytes, usedBytes, totalBytes, percent, mountpoint?,
          volumes: [{mountpoint, percent, usedBytes, totalBytes, device}]}]
    """
    disks = []
    sb = Path("/sys/block")
    vols = _host_volumes()
    if sb.exists():
        for entry in sorted(sb.iterdir(), key=lambda p: p.name):
            name = entry.name
            if not _is_physical_disk(name):
                continue
            try:
                size_bytes = int((entry / "size").read_text().strip()) * 512
            except (OSError, ValueError):
                continue
            model = ""
            try:
                m = (entry / "device" / "model").read_text().strip()
                if m:
                    model = m
            except OSError:
                pass
            related = [v for v in vols if name in v.get("disks", [])]
            item = {
                "name": name, "device": "/dev/" + name, "model": model,
                "sizeBytes": size_bytes,
                "volumes": [{
                    "mountpoint": v["mountpoint"], "mountpoints": v["mountpoints"],
                    "percent": v["percent"], "usedBytes": v["usedBytes"],
                    "totalBytes": v["totalBytes"], "device": v["device"],
                } for v in related],
            }
            if related:
                total = sum(v["totalBytes"] for v in related)
                used = sum(v["usedBytes"] for v in related)
                item.update({
                    "mountpoint": related[0]["mountpoint"],
                    "totalBytes": total,
                    "usedBytes": used,
                    "percent": round(used / total * 100) if total else 0,
                })
            else:
                item.update({"mountpoint": None, "totalBytes": size_bytes,
                             "usedBytes": None, "percent": None})
            disks.append(item)
    # 兜底：非 Linux（开发机 macOS）没有 /sys/block，退回容器根分区，界面不至于空
    if not disks and root_disk is not None:
        disks.append({
            "name": "/", "device": "/", "model": "",
            "sizeBytes": root_disk.total,
            "usedBytes": root_disk.used,
            "totalBytes": root_disk.total,
            "percent": round(root_disk.percent),
            "mountpoint": "/",
        })
    return disks


def _is_container_id(name: str) -> bool:
    """容器主机名通常是一段十六进制（如 715fbcad427），不能当成设备名。"""
    return bool(re.fullmatch(r"[0-9a-fA-F]{8,64}", (name or "").strip()))


_DOCKER_HOST_CACHE = {"ts": 0.0, "name": "", "os": ""}


def _docker_host_facts() -> dict:
    """通过 Docker 守护进程读取宿主主机名和操作系统。

    容器里的 /etc/hostname 是容器 ID。docker.sock 上的 /info
    由宿主机上的 dockerd 回答，Name / OperatingSystem 才是这台 NAS。
    """
    now = time.time()
    if _DOCKER_HOST_CACHE["ts"] and now - _DOCKER_HOST_CACHE["ts"] < 60:
        return _DOCKER_HOST_CACHE
    name = os_name = ""
    try:
        import docker
        client = docker.from_env(timeout=2)
        info = client.info() or {}
        name = (info.get("Name") or "").strip()
        os_name = (info.get("OperatingSystem") or "").strip()
    except Exception:
        name = os_name = ""
    _DOCKER_HOST_CACHE.update({"ts": now, "name": name, "os": os_name})
    return _DOCKER_HOST_CACHE


def _host_hostname() -> str:
    """宿主主机名。不要回落到容器 ID。"""
    import platform
    host_file = _HOST_ROOT / "etc" / "hostname"
    try:
        val = host_file.read_text().strip()
        if val:
            return val
    except OSError:
        pass
    docker_name = (_docker_host_facts().get("name") or "").strip()
    if docker_name and not _is_container_id(docker_name):
        return docker_name
    for cand in (Path("/etc/hostname"),):
        try:
            val = cand.read_text().strip()
        except OSError:
            continue
        if val and not _is_container_id(val):
            return val
    node = (platform.node() or "").strip()
    if node and not _is_container_id(node):
        return node
    return docker_name or "nas"


def _os_release_pretty(text: str) -> str:
    """从 os-release 文本取出「名称 + 版本」（优先 PRETTY_NAME）。"""
    info = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        info[key.strip()] = val.strip().strip('"').strip("'")
    pretty = info.get("PRETTY_NAME") or ""
    if pretty:
        return pretty
    name = info.get("NAME") or ""
    ver = info.get("VERSION") or info.get("VERSION_ID") or ""
    return (name + (" " + ver if ver else "")).strip()


def _host_os_name() -> str:
    """操作系统名称及版本。

    容器里的 /etc/os-release 是镜像发行版，不能当成这台机器的系统。
    优先读只读挂载的宿主 /host/etc/os-release；开发机没有 /host 时才读本机文件。
    """
    import platform
    host_file = _HOST_ROOT / "etc" / "os-release"
    try:
        pretty = _os_release_pretty(host_file.read_text(errors="replace"))
        if pretty:
            return pretty
    except OSError:
        pass
    # /.dockerenv 存在说明当前是容器：没挂宿主根时不要把镜像系统报成宿主机系统
    if not Path("/.dockerenv").exists():
        try:
            pretty = _os_release_pretty(Path("/etc/os-release").read_text(errors="replace"))
            if pretty:
                return pretty
        except OSError:
            pass
    docker_os = (_docker_host_facts().get("os") or "").strip()
    if docker_os:
        return docker_os
    return f"{platform.system()} {platform.release()}".strip() or "—"


def _cpu_model_from_cpuinfo(text: str) -> str:
    """从 /proc/cpuinfo 取 CPU 型号（x86 的 model name，ARM 的 Hardware）。"""
    hardware = ""
    for line in (text or "").splitlines():
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        key, val = key.strip().lower(), val.strip()
        if key == "model name" and val:
            return val
        if key == "hardware" and val:
            hardware = val
    return hardware


def _cpu_name() -> str:
    """CPU 型号。容器内 /proc/cpuinfo 仍是宿主 CPU（cpuinfo 不随命名空间隔离）。"""
    import platform
    try:
        name = _cpu_model_from_cpuinfo(Path("/proc/cpuinfo").read_text(errors="replace"))
        if name:
            return name
    except OSError:
        pass
    return (platform.processor() or "").strip() or "—"


def _format_uptime(seconds: float) -> str:
    """把秒数格式化成「N 天 N 小时」。"""
    if seconds is None or seconds < 0:
        return "—"
    total = int(seconds)
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days} 天 {hours} 小时"
    if hours:
        return f"{hours} 小时 {minutes} 分钟"
    return f"{minutes} 分钟"


def _host_net_totals():
    """宿主网卡累计 (下行字节, 上行字节)；拿不到返回 None。

    容器内 psutil.net_io_counters() 只统计容器自己的网卡（netns 隔离）。
    宿主网络统计在宿主 PID 1 的 /proc/<pid>/net/dev，需只读挂载宿主根；
    拿不到就返回 None，由调用方退回 psutil。
    """
    try:
        text = (_HOST_ROOT / "proc" / "1" / "net" / "dev").read_text()
    except OSError:
        return None
    rx = tx = 0
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        if iface.strip() == "lo":
            continue
        cols = rest.split()
        if len(cols) >= 9:
            try:
                rx += int(cols[0])
                tx += int(cols[8])
            except ValueError:
                continue
    return (rx, tx) if (rx or tx) else None

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

def _drm_cards() -> list:
    """列出 DRM 显卡（card0/card1…，跳过 card0-HDMI-A-1 这类连接器节点）。

    返回 [{card, vendor, device, driver, path}]，vendor 形如 0x8086(Intel)/0x10de(NVIDIA)/0x1002(AMD)。
    """
    cards = []
    base = Path("/sys/class/drm")
    if not base.exists():
        return cards
    for c in sorted(base.glob("card[0-9]*")):
        if "-" in c.name:                      # 连接器（HDMI/DP）节点，不是显卡本体
            continue
        dev = c / "device"

        def _rd(name):
            try:
                return (dev / name).read_text().strip()
            except OSError:
                return ""

        driver = ""
        try:
            driver = (dev / "driver").resolve().name
        except OSError:
            pass
        cards.append({"card": c.name, "vendor": _rd("vendor"), "device": _rd("device"),
                      "driver": driver, "path": c})
    return cards


def _i915_pmu_type():
    try:
        return int((Path("/sys/bus/event_source/devices/i915/type")).read_text().strip())
    except (OSError, ValueError):
        return None


def _pmu_event_config(name: str):
    """从 sysfs 读事件的 config 值。

    必须按文件读，不能硬编码：i915 的取值不规则
    （rcs0-busy=0x0、bcs0-busy=0x1000、actual-frequency=0x100000…），
    猜错只会得到 EINVAL（实测踩过）。
    """
    f = Path("/sys/bus/event_source/devices/i915/events") / name
    try:
        for part in f.read_text().strip().split(","):
            k, _, v = part.partition("=")
            if k.strip() == "config":
                return int(v, 0)
    except (OSError, ValueError):
        return None
    return None


def _perf_event_open(ev_type: int, config: int) -> int:
    """perf_event_open 系统调用（只依赖标准库的 ctypes）。"""
    import ctypes
    import ctypes.util
    libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)

    class _Attr(ctypes.Structure):
        _fields_ = [("type", ctypes.c_uint), ("size", ctypes.c_uint),
                    ("config", ctypes.c_ulonglong),
                    ("sample_period", ctypes.c_ulonglong),
                    ("sample_type", ctypes.c_ulonglong),
                    ("read_format", ctypes.c_ulonglong),
                    ("flags", ctypes.c_ulonglong),
                    ("wakeup_events", ctypes.c_uint), ("bp_type", ctypes.c_uint),
                    ("bp_addr", ctypes.c_ulonglong), ("bp_len", ctypes.c_ulonglong)]
    a = _Attr()
    a.type = ev_type
    a.size = ctypes.sizeof(_Attr)
    a.config = config
    a.read_format = 0x1 | 0x2                  # TOTAL_TIME_ENABLED | TOTAL_TIME_RUNNING
    nr = 298 if os.uname().machine in ("x86_64", "amd64") else 241
    fd = libc.syscall(nr, ctypes.byref(a), 0, -1, -1, 0)
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return fd


_GPU_PMU_PREV = {}          # {engine: (ts, count, enabled, running)}
_GPU_PMU_FDS = {}           # 常开的 perf fd，避免每次请求重复打开
_GPU_RC6_PREV = {}          # {"ts":…, "ms":…}


def _intel_gpu_util_pmu() -> Optional[dict]:
    """用 i915 PMU 的引擎忙计数算真实利用率（与 intel_gpu_top 同源）。

    需要容器的 capabilities（实测：默认权限 EPERM；--cap-add SYS_ADMIN 可通过权限检查，
    --cap-add PERFMON 仍被拒）。任何一步失败都返回 None，由调用方降级。
    取各引擎里最忙的那个作为「GPU 利用率」。
    """
    import struct
    ev_type = _i915_pmu_type()
    if not ev_type:
        return None
    engines = ("rcs0-busy", "bcs0-busy", "vcs0-busy", "vecs0-busy")
    now = time.time()
    for name in engines:
        if name in _GPU_PMU_FDS:
            continue
        cfg = _pmu_event_config(name)
        if cfg is None:
            return None
        try:
            _GPU_PMU_FDS[name] = _perf_event_open(ev_type, cfg)
        except OSError:
            _GPU_PMU_FDS.clear()
            return None
    busiest = 0.0
    for name in engines:
        fd = _GPU_PMU_FDS.get(name)
        if fd is None:
            continue
        try:
            buf = os.read(fd, 24)
        except OSError:
            continue
        if len(buf) < 24:
            continue
        count, enabled, running = struct.unpack("<QQQ", buf[:24])
        prev = _GPU_PMU_PREV.get(name)
        _GPU_PMU_PREV[name] = (now, count, enabled, running)
        if not prev:
            continue
        dt = now - prev[0]
        dc, de, dr = count - prev[1], enabled - prev[2], running - prev[3]
        if dt <= 0.5 or dr <= 0 or de <= 0 or dc < 0:
            continue                            # 首次采样/时间太短/计数器回绕
        busy_ns = dc * (de / dr)                # 按实际运行时间换算，避免被抢占时低估
        busy_pct = max(0.0, min(100.0, busy_ns / (dt * 1e9) * 100.0))
        busiest = max(busiest, busy_pct)
    return {"util": round(busiest), "source": "i915-pmu"}


def _intel_gpu_util_rc6() -> Optional[dict]:
    """降级方案：用 RC6 空闲驻留反推「GPU 活动占比」= 100 - RC6%。

    只需 /sys/class/drm 可读（默认权限即可，实测可通过）。
    它不等于引擎利用率，但对「显卡有没有在干活」是可靠的，且总能拿到。
    """
    p = Path("/sys/class/drm/card0/power/rc6_residency_ms")
    try:
        ms = int(p.read_text().strip())
    except (OSError, ValueError):
        return None
    now = time.time()
    prev = _GPU_RC6_PREV.get("v")
    _GPU_RC6_PREV["v"] = (now, ms)
    if not prev:
        return None
    dt_ms = (now - prev[0]) * 1000.0
    d_ms = ms - prev[1]
    if dt_ms <= 500 or d_ms < 0:
        return None
    idle_pct = max(0.0, min(100.0, d_ms / dt_ms * 100.0))
    return {"util": round(100.0 - idle_pct), "source": "i915-rc6"}


def _intel_gpu_freq() -> dict:
    """GT 频率（当前/上限/最低），并给出「频率占位」作为最后的兜底利用率。"""
    out = {"freqMhz": None, "freqMaxMhz": None, "util": None}
    base = Path("/sys/class/drm/card0")

    def _num(name):
        try:
            return int((base / name).read_text().strip())
        except (OSError, ValueError):
            return None

    act, rp0, rpn = _num("gt_act_freq_mhz"), _num("gt_RP0_freq_mhz"), _num("gt_RPn_freq_mhz")
    out["freqMhz"], out["freqMaxMhz"] = act, rp0
    if act is not None and rp0:
        lo = rpn if (rpn and rpn < rp0) else 0
        pct = (act - lo) / max(1, (rp0 - lo)) * 100.0
        out["util"] = round(max(0.0, min(100.0, pct)))
    return out


def _gpu_metrics():
    """GPU 指标（结果缓存 2 秒）。

    依次尝试：NVIDIA(nvidia-smi) → Intel 核显(i915 PMU → RC6 活动占比 → GT 频率)
    → AMD(预留)。找不到可用数据源时 available=false，前端显示「未检测到可监控的 GPU」。
    返回 {available, util, temp, name, vendor, source, freqMhz, freqMaxMhz}
    """
    import shutil
    import subprocess
    now = time.time()
    if _GPU_CACHE["data"] is not None and now - _GPU_CACHE["ts"] < 2:
        return _GPU_CACHE["data"]

    data = {"available": False, "util": None, "temp": None, "name": "",
            "vendor": "", "source": None, "freqMhz": None, "freqMaxMhz": None}

    # ---- 1) NVIDIA：有 nvidia-smi 就用它（原有逻辑保留）----
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
                    data.update({"available": True, "util": int(float(parts[0])),
                                 "temp": int(float(parts[1])), "vendor": "nvidia",
                                 "source": "nvidia-smi",
                                 "name": parts[2] if len(parts) > 2 else "NVIDIA GPU"})
                    _GPU_CACHE.update({"ts": now, "data": data})
                    return data
        except Exception:
            pass

    # ---- 2) Intel 核显（i915）----
    for card in _drm_cards():
        if card.get("vendor") != "0x8086":
            continue
        util = _intel_gpu_util_pmu() or _intel_gpu_util_rc6()
        freq = _intel_gpu_freq()
        if util is None and freq["util"] is not None:
            util = {"util": freq["util"], "source": "i915-freq"}
        temp = None
        try:
            for hw in sorted((card["path"] / "device" / "hwmon").glob("hwmon*")):
                t = hw / "temp1_input"
                if t.exists():
                    temp = round(int(t.read_text().strip()) / 1000)
                    break
        except OSError:
            temp = None
        data.update({
            "available": True,
            "util": util["util"] if util else None,
            "temp": temp,
            "vendor": "intel",
            "source": util["source"] if util else None,
            "name": "Intel 核显（%s）" % (card.get("driver") or "i915"),
            "freqMhz": freq["freqMhz"],
            "freqMaxMhz": freq["freqMaxMhz"],
        })
        _GPU_CACHE.update({"ts": now, "data": data})
        return data

    # ---- 3) AMD（amdgpu 的 gpu_busy_percent，预留；本机无此卡）----
    for card in _drm_cards():
        if card.get("vendor") != "0x1002":
            continue
        busy = card["path"] / "device" / "gpu_busy_percent"
        try:
            util = int(busy.read_text().strip())
        except (OSError, ValueError):
            continue
        data.update({"available": True, "util": util, "vendor": "amd",
                     "source": "amdgpu-sysfs", "name": "AMD GPU（amdgpu）"})
        _GPU_CACHE.update({"ts": now, "data": data})
        return data

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
    _host_net = _host_net_totals()
    if _host_net is None:                    # 没挂宿主根时退回容器自己的网卡
        _n = psutil.net_io_counters()
        _host_net = (_n.bytes_recv, _n.bytes_sent)
    net_recv, net_sent = _host_net
    net_down = net_up = 0.0
    if prev["ts"] and dt > 0.5:
        net_down = max(net_recv - prev["net"][0], 0) / dt / 1048576
        net_up = max(net_sent - prev["net"][1], 0) / dt / 1048576
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
        "net": (net_recv, net_sent),
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

