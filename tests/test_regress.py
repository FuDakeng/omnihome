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
    assert 'id="phoneNav"' not in html
    assert 'phone-more' not in html
    assert 'class="sidebar"' in html
    assert 'id="collapseBtn"' in html
    assert "css/mobile.css" in html
    assert 'id="i-menu"' in html
    assert "__VER__" not in html
    assert "<!--VIEWS-->" not in html
    assert "<!--ICONS-->" not in html
    assert "<!--OVERLAYS-->" not in html


def test_dashboard_translate_passgen_widgets():
    """仪表盘去掉工具箱卡片；翻译 / 强密码可添加，且工具箱页仍保留完整组件。"""
    dash = (ROOT / "demo" / "views" / "dashboard.html").read_text(encoding="utf-8")
    assert 'data-widget="toolbox"' not in dash
    assert 'data-widget="translate"' in dash
    assert 'data-widget="passgen"' in dash
    assert 'data-tool="translate"' in dash
    assert 'data-tool="passgen"' in dash

    tb = (ROOT / "demo" / "views" / "toolbox.html").read_text(encoding="utf-8")
    assert 'data-tool="translate"' in tb
    assert 'data-tool="passgen"' in tb
    assert 'id="tool-json"' in tb

    js = (ROOT / "demo" / "js" / "dashboard.js").read_text(encoding="utf-8")
    assert "translate:" in js
    assert "passgen:" in js
    assert "toolbox:" not in js
    assert "OPT_IN" in js

    settings = (ROOT / "backend" / "routers" / "settings.py").read_text(encoding="utf-8")
    block = settings.split("DEFAULT_WIDGETS", 1)[1].split("]", 1)[0]
    assert '"translate"' in block
    assert '"passgen"' in block
    assert '"toolbox"' not in block


def test_appearance_density_and_motion_wired():
    """密度 / 动效开关必须真正改 html dataset，且有对应 CSS；外观页结构完整。"""
    html = (ROOT / "demo" / "views" / "overlays-settings.html").read_text(encoding="utf-8")
    assert 'id="densitySeg"' in html
    assert 'id="motionSwitch"' in html
    assert "品牌主色" in html
    motion_idx = html.index('id="motionSwitch"')
    accent_idx = html.index("品牌主色")
    chip_idx = html.index("一个色相值全站换肤")
    assert motion_idx < accent_idx < chip_idx

    theme = (ROOT / "demo" / "css" / "theme.css").read_text(encoding="utf-8")
    layout = (ROOT / "demo" / "css" / "layout.css").read_text(encoding="utf-8")
    compact_block = theme.split('html[data-compact="on"]', 1)[1][:400]
    motion_block = layout.split('html[data-motion="off"]', 1)[1][:500]
    assert "--om-space-5:" in compact_block
    assert "animation-duration" in motion_block

    settings_js = (ROOT / "demo" / "js" / "settings.js").read_text(encoding="utf-8")
    assert "previewAppearance" in settings_js
    app_js = (ROOT / "demo" / "js" / "app.js").read_text(encoding="utf-8")
    assert "dataset.compact" in app_js
    assert "dataset.motion" in app_js
    assert "om_layout_compact" in app_js


def test_kb_drag_state_uses_module_sets():
    """v0.2.52 ESM 拆分后裸 selNotes 会 ReferenceError，拖到回收站失效。"""
    import re
    text = (ROOT / "demo" / "js" / "notes" / "bind-tree.js").read_text(encoding="utf-8")
    assert "[...S.selNotes]" in text
    assert "[...S.selFolders]" in text
    assert "[...S.selAssets]" in text
    assert "[...selNotes]" not in text
    assert "[...selFolders]" not in text
    assert "[...selAssets]" not in text
    css = (ROOT / "demo" / "css" / "components" / "pages.css").read_text(encoding="utf-8")
    assert re.search(r"#aboutChangelog\{[^}]*overflow-y:\s*auto", css, re.S)


def test_demo_js_modules_parse():
    """node --check 不按 ESM 解析，会漏掉 `{ S.folders: fl }` 这类模块语法错误。"""
    js_root = ROOT / "demo" / "js"
    bad = []
    for path in sorted(js_root.rglob("*.js")):
        if "vendor" in path.parts:
            continue
        r = subprocess.run(
            ["node", "--input-type=module", "--check"],
            input=path.read_text(encoding="utf-8"),
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            bad.append(f"{path.relative_to(ROOT)}: {(r.stderr or r.stdout).strip()}")
    if bad:
        pytest.fail("JS 模块无法解析:\n" + "\n".join(bad[:20]))



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


def test_translate_script():
    r = subprocess.run(
        [sys.executable, str(BACKEND / "_translate_test.py")],
        cwd=str(BACKEND),
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        pytest.fail(r.stdout[-2000:] + "\n" + r.stderr[-2000:])
