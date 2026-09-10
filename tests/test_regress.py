"""pytest 门禁：默认同步回归 + 版本/前端组装契约。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def test_changelog_and_version():
    sys.path.insert(0, str(BACKEND))
    import app_version
    assert app_version.VERSION
    assert app_version.CHANGELOG
    assert app_version.CHANGELOG[0]["version"] == app_version.VERSION


def test_render_index_injects_version():
    sys.path.insert(0, str(BACKEND))
    import app_version
    from webassets import render_index
    html = render_index(ROOT / "demo", app_version.VERSION)
    assert f"?v={app_version.VERSION}" in html
    assert 'data-view="dashboard"' in html
    assert 'type="module"' in html
    assert "js/boot.js" in html
    assert "js/vendor/qrcode.min.js" in html
    assert "jsdelivr" not in html
    assert 'id="i-logo"' in html
    assert 'id="phoneNav"' in html
    assert "css/mobile.css" in html
    assert 'id="i-menu"' in html
    assert "__VER__" not in html
    assert "<!--VIEWS-->" not in html
    assert "<!--ICONS-->" not in html
    assert "<!--OVERLAYS-->" not in html


def test_sync_regress_file_and_sqlite():
    r = subprocess.run(
        [sys.executable, str(BACKEND / "_sync_regress.py")],
        cwd=str(BACKEND),
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        pytest.fail(r.stdout[-2000:] + "\n" + r.stderr[-2000:])


def test_secretbox_script():
    r = subprocess.run(
        [sys.executable, str(BACKEND / "_secretbox_test.py")],
        cwd=str(BACKEND),
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        pytest.fail(r.stdout[-2000:] + "\n" + r.stderr[-2000:])
