"""系统监控：宿主磁盘/主机名口径、GPU 字段、硬件信息解析。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import routers.monitor as mon  # noqa: E402


def test_parent_device_name_keeps_nvme_namespace():
    assert mon._parent_device_name("sda2") == "sda"
    assert mon._parent_device_name("nvme0n1p7") == "nvme0n1"
    assert mon._parent_device_name("nvme1n1p2") == "nvme1n1"
    assert mon._parent_device_name("mmcblk0p1") == "mmcblk0"
    assert mon._parent_device_name("sda") == "sda"


def test_virtual_block_devices_are_not_physical_disks():
    for name in ("loop0", "ram0", "zram3", "dm-1", "md1", "md2", "sr0", "nbd0"):
        assert mon._is_physical_disk(name) is False


def test_os_release_and_cpuinfo_and_uptime():
    pretty = mon._os_release_pretty(
        'NAME="Ugreen OS"\nVERSION="1.9.0"\nPRETTY_NAME="UGOS 1.9.0"\n'
    )
    assert pretty == "UGOS 1.9.0"
    assert mon._os_release_pretty('NAME=Debian\nVERSION_ID=12\n') == "Debian 12"
    cpu = mon._cpu_model_from_cpuinfo(
        "processor\t: 0\nmodel name\t: Intel(R) Pentium(R) Gold 8505 @ 1.20GHz\n"
    )
    assert "8505" in cpu
    assert mon._cpu_model_from_cpuinfo("Hardware\t: Test Board\n") == "Test Board"
    assert mon._format_uptime(25.2 * 86400) == "25 天 4 小时"
    assert mon._format_uptime(3700) == "1 小时 1 分钟"
    assert mon._format_uptime(-1) == "—"


def test_container_without_host_does_not_report_overlay(monkeypatch):
    """容器没挂 -v /:/host:ro 时，禁止把 overlay（约 0.9T）当成整机容量。"""
    monkeypatch.setattr(mon, "_host_volumes", lambda: [])
    monkeypatch.setattr(mon, "_in_container", lambda: True)
    monkeypatch.setattr(mon, "_host_root_available", lambda: False)
    overlay = SimpleNamespace(percent=10, used=97 * 1024 ** 3, total=900 * 1024 ** 3)
    summary = mon._storage_summary(overlay)
    assert summary["scope"] == "container"
    assert summary["storageFallback"] is True
    assert summary["percent"] is None
    assert summary["usedTB"] is None
    assert summary["totalTB"] is None
    assert summary["usedBytes"] is None
    assert summary["totalBytes"] is None
    assert summary["volumes"] == []
    assert "/:/host:ro" in summary["hint"]
    assert "容器视角" in summary["hint"]


def test_bare_metal_without_host_mount_uses_local_root(monkeypatch):
    """开发机不是容器：没有 /host 时，根分区就是本机磁盘。"""
    monkeypatch.setattr(mon, "_host_volumes", lambda: [])
    monkeypatch.setattr(mon, "_in_container", lambda: False)
    monkeypatch.setattr(mon, "_host_root_available", lambda: False)
    summary = mon._storage_summary(SimpleNamespace(percent=10, used=100, total=1000))
    assert summary["scope"] == "local"
    assert summary["storageFallback"] is False
    assert summary["percent"] == 10
    assert summary["usedBytes"] == 100
    assert summary["totalBytes"] == 1000
    assert summary["volumes"] == []


def test_host_volumes_sum_without_double_counting_scope(monkeypatch):
    monkeypatch.setattr(mon, "_host_volumes", lambda: [
        {"totalBytes": 1000, "usedBytes": 300},
        {"totalBytes": 500, "usedBytes": 100},
    ])
    summary = mon._storage_summary(SimpleNamespace(percent=99, used=1, total=1))
    assert summary["scope"] == "host"
    assert summary["storageFallback"] is False
    assert summary["percent"] == 27
    assert summary["usedBytes"] == 400
    assert summary["totalBytes"] == 1500
    assert summary["hint"] == ""


def test_without_host_volumes_disk_percent_is_null(monkeypatch):
    """没挂宿主根时，物理盘占用必须是 null，不能再报 0%。"""
    monkeypatch.setattr(mon, "_host_volumes", lambda: [])
    block = mon.Path("/sys/block")
    if not block.exists() or not any(mon._is_physical_disk(p.name) for p in block.iterdir()):
        return
    disks = mon._physical_disks(SimpleNamespace(percent=3, used=1, total=10))
    assert disks
    assert all(d["percent"] is None and d["usedBytes"] is None for d in disks)
    assert all(not d["name"].startswith(("md", "zram", "loop", "dm-")) for d in disks)
    json.dumps(disks)


def test_container_without_sysfs_does_not_invent_root_disk(monkeypatch):
    monkeypatch.setattr(mon, "_host_volumes", lambda: [])
    monkeypatch.setattr(mon, "_in_container", lambda: True)
    monkeypatch.setattr(mon, "_host_root_available", lambda: False)
    real_exists = mon.Path.exists

    def exists(self):
        if self == mon.Path("/sys/block"):
            return False
        return real_exists(self)

    monkeypatch.setattr(mon.Path, "exists", exists)
    disks = mon._physical_disks(SimpleNamespace(percent=10, used=9, total=90))
    assert disks == []


def test_no_sysfs_falls_back_to_root_partition(monkeypatch):
    monkeypatch.setattr(mon, "_host_volumes", lambda: [])
    monkeypatch.setattr(mon, "_in_container", lambda: False)
    real_exists = mon.Path.exists

    def exists(self):
        if self == mon.Path("/sys/block"):
            return False
        return real_exists(self)

    monkeypatch.setattr(mon.Path, "exists", exists)
    disks = mon._physical_disks(SimpleNamespace(percent=7, used=2, total=20))
    assert disks[0]["name"] == "/"
    assert disks[0]["percent"] == 7
    assert disks[0]["mountpoint"] == "/"


def test_hostname_and_os_come_from_host_root(tmp_path, monkeypatch):
    etc = tmp_path / "etc"
    etc.mkdir()
    (etc / "hostname").write_text("JeansNAS\n", encoding="utf-8")
    (etc / "os-release").write_text('PRETTY_NAME="UGOS 1.9.0"\n', encoding="utf-8")
    monkeypatch.setattr(mon, "_HOST_ROOT", tmp_path)
    assert mon._host_hostname() == "JeansNAS"
    assert mon._host_os_name() == "UGOS 1.9.0"


def test_gpu_metrics_shape_is_json_safe():
    mon._GPU_CACHE["data"] = None
    mon._GPU_CACHE["ts"] = 0
    data = mon._gpu_metrics()
    assert set(data) >= {"available", "util", "temp", "name", "vendor", "source",
                         "freqMhz", "freqMaxMhz"}
    json.dumps(data)


def test_container_id_is_not_used_as_device_name(monkeypatch):
    assert mon._is_container_id("715fbcad427")
    assert mon._is_container_id("715fbcad427ab")
    assert mon._is_container_id("a" * 64)
    assert not mon._is_container_id("JeansNAS")
    monkeypatch.setattr(mon, "_HOST_ROOT", Path("/no/such/omnihome-host"))
    monkeypatch.setattr(mon, "_docker_host_facts", lambda: {"name": "JeansNAS", "os": "UGOS 1.9"})
    assert mon._host_hostname() == "JeansNAS"


def test_about_json_is_not_cut_by_markup_closers():
    import json
    sys.path.insert(0, str(ROOT / "backend"))
    from app_version import dumps_for_http
    raw = dumps_for_http({"note": "before </body> and </script> end"})
    assert "</body>" not in raw
    assert "</script>" not in raw
    assert json.loads(raw)["note"] == "before </body> and </script> end"
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "</body>" not in text
    assert "</script>" not in text.lower()


def test_monitor_page_exposes_hardware_card_and_filter_opens_right():
    html = (ROOT / "demo" / "views" / "monitor.html").read_text(encoding="utf-8")
    for field in ("monHwHost", "monHwCpu", "monHwGpu", "monHwOs", "monHwMem", "monHwUp"):
        assert f'id="{field}"' in html
    js = (ROOT / "demo" / "js" / "monitor.js").read_text(encoding="utf-8")
    assert 'id="monDiskPick"' in html
    assert 'class="mon-top"' in html
    assert "renderHwCard" in js
    assert "monitorVisible" in js
    assert "未检测到可监控的 GPU（NVIDIA / Intel / AMD）" in js
    assert "gpuName" in js
    assert "storageFallback" in js
    assert "未挂载宿主根" in js
    assert "所选硬盘占用" in js
    assert "fmtTb" in js
    css = (ROOT / "demo" / "css" / "components" / "monitor.css").read_text(encoding="utf-8")
    assert ".ct-filter .drop-panel" in css
    assert "left: 0" in css
    mobile = (ROOT / "demo" / "css" / "mobile.css").read_text(encoding="utf-8")
    assert ".mon-top" in css
    assert "max-width: 1280px" in css
    assert ".mon-metrics" in mobile
