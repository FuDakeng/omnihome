"""仪表盘监控横条：字段白名单、磁盘速率合计、存储占用未知时不报假数字。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import routers.monitor as mon  # noqa: E402
from routers.settings import SYS_BAR_ORDER, clean_sysbar_fields  # noqa: E402


def test_sysbar_fields_drop_unknown_and_keep_order():
    assert clean_sysbar_fields(["mem", "nope", "cpu", "cpu", 1]) == ["cpu", "mem"]
    assert clean_sysbar_fields([]) == []
    assert clean_sysbar_fields(None) is None
    assert clean_sysbar_fields("cpu") is None
    assert clean_sysbar_fields(list(SYS_BAR_ORDER)) == list(SYS_BAR_ORDER)


def test_sum_disk_rates_ignores_bad_values():
    assert mon._sum_disk_rates([
        {"read": 1.2, "write": 0.3},
        {"read": 0.8, "write": 1},
    ]) == (2.0, 1.3)
    assert mon._sum_disk_rates([
        {"read": None, "write": "x"},
        "bad",
        {"read": -4, "write": 0.5},
    ]) == (0.0, 0.5)
    assert mon._sum_disk_rates([]) == (0.0, 0.0)


def test_disk_percent_hides_fallback_and_out_of_range(monkeypatch):
    monkeypatch.setattr(mon, "_storage_summary", lambda root: {
        "storageFallback": True, "percent": 88,
    })
    mon._DISK_PCT_CACHE.update({"ts": 0.0, "val": 1})
    assert mon._disk_percent_for_strip() is None

    monkeypatch.setattr(mon, "_storage_summary", lambda root: {
        "storageFallback": False, "percent": 140,
    })
    mon._DISK_PCT_CACHE.update({"ts": 0.0, "val": None})
    assert mon._disk_percent_for_strip() is None

    monkeypatch.setattr(mon, "_storage_summary", lambda root: {
        "storageFallback": False, "percent": 0,
    })
    mon._DISK_PCT_CACHE.update({"ts": 0.0, "val": None})
    assert mon._disk_percent_for_strip() == 0.0

    monkeypatch.setattr(mon, "_storage_summary", lambda root: {
        "storageFallback": False, "percent": 42,
    })
    mon._DISK_PCT_CACHE.update({"ts": 0.0, "val": None})
    assert mon._disk_percent_for_strip() == 42.0


def test_dashboard_strip_markup_and_styles():
    html = (ROOT / "demo" / "views" / "dashboard.html").read_text(encoding="utf-8")
    assert 'id="sysStrip"' in html
    assert 'id="sysFieldsBtn"' in html
    assert 'class="vh-strips"' in html
    # 横条在布局按钮之前，按钮仍在最右
    assert html.find('id="sysStrip"') < html.find('id="dashEditBtn"')
    assert html.find('id="wxStrip"') < html.find('id="sysStrip"')
    css = (ROOT / "demo" / "css" / "components" / "weather.css").read_text(encoding="utf-8")
    assert ".sys-strip" in css
    assert "flex: 0 0 auto" in css
    mobile = (ROOT / "demo" / "css" / "mobile.css").read_text(encoding="utf-8")
    assert "#sysStrip" in mobile
    js = (ROOT / "demo" / "js" / "sysbar.js").read_text(encoding="utf-8")
    for key in ("cpuTemp", "diskWrite", "diskRead", "netUp", "netDown"):
        assert key in js
    assert "—" in js
