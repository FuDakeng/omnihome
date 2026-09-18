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


def test_dashboard_widget_layout_flex():
    """同行可前后互换；拉高只作用于本卡；内容随卡片长宽铺开。"""
    js = (ROOT / "demo" / "js" / "dashboard.js").read_text(encoding="utf-8")
    assert "sameRow" in js
    assert "has-h" in js
    assert "classList.add('dragging')" in js
    assert "beginSort" in js
    assert "onSortMove" in js
    assert "dragstart" not in js
    css = (ROOT / "demo" / "css" / "components" / "pages.css").read_text(encoding="utf-8")
    assert "align-items: start" in css
    assert "#dashGrid [data-widget].has-h" in css
    assert "min-height: var(--dash-h" not in css
    assert "position: fixed" in css
    assert "dash-sorting" in css
    assert "left: -9999px" not in css
    html = (ROOT / "demo" / "views" / "dashboard.html").read_text(encoding="utf-8")
    assert "dash-spark-svg" in html


def test_dashboard_edit_tools_not_clipped():
    """编辑布局时拖拽/收纳胶囊贴在卡片上沿，不能被 .editor / 灵感速记 overflow 裁掉。"""
    import re
    css = (ROOT / "demo" / "css" / "components" / "pages.css").read_text(encoding="utf-8")
    notes = (ROOT / "demo" / "css" / "components" / "notes.css").read_text(encoding="utf-8")
    mobile = (ROOT / "demo" / "css" / "mobile.css").read_text(encoding="utf-8")
    html = (ROOT / "demo" / "views" / "dashboard.html").read_text(encoding="utf-8")
    js = (ROOT / "demo" / "js" / "dashboard.js").read_text(encoding="utf-8")
    assert "dash-tools" in js
    assert 'data-widget="quicknote"' in html
    assert 'editor editor-inline' in html
    assert re.search(r"\.editor\{[^}]*overflow:\s*hidden", notes)
    assert re.search(r'\[data-widget="quicknote"\]\{[^}]*overflow:\s*hidden', css)
    assert re.search(
        r"#dashGrid\.editing \[data-widget\]\{[^}]*overflow:\s*visible",
        css,
    )
    assert "padding-top: 18px" in css
    assert "padding-right: 76px" in css
    assert ".dash-tools{" in css
    assert "top: -13px" in css
    assert "z-index: 8" in css
    assert "#dashGrid.editing [data-widget] > .card-head" in css
    assert ".dash-tools .icon-btn-xs" in mobile
    assert "width: 44px" in mobile.split(".dash-tools .icon-btn-xs", 1)[1][:80]


def test_vault_categories_and_preview():
    """保险库左分类右卡片；分类/凭据可多选拖拽；预览同时展示地址账号密码；同站可多账号。"""
    js = (ROOT / "demo" / "js" / "vault.js").read_text(encoding="utf-8")
    html = (ROOT / "demo" / "views" / "vault.html").read_text(encoding="utf-8")
    overlay = (ROOT / "demo" / "views" / "overlays.html").read_text(encoding="utf-8")
    css = (ROOT / "demo" / "css" / "components" / "widgets.css").read_text(encoding="utf-8")
    mobile = (ROOT / "demo" / "css" / "mobile.css").read_text(encoding="utf-8")
    pages = (ROOT / "demo" / "css" / "components" / "pages.css").read_text(encoding="utf-8")
    assert 'id="vaultCats"' in html
    assert 'id="vaultSort"' in html
    assert 'id="vaultBatch"' in html
    assert "vault-layout" in html
    assert "bm-layout" in html
    assert 'id="viCat"' in overlay
    assert "同一网站可保存多个账号" in overlay
    assert "data-v-cat-add" in js
    assert "data-v-cat-edit" in js
    assert "data-v-cat-del" in js
    assert "data-v-cat-sel" in js
    assert "data-v-sel" in js
    assert "writeCheck" in js
    assert "enc({ v: 1, cats" in js
    assert "dropSelToCat" in js
    assert "persistCardOrder" in js
    assert "persistCatOrder" in js
    assert "sameSiteN" in js
    assert "previewHtml" in js
    assert "setPreview" in js
    assert "'地址'" in js and "'账号'" in js and "'密码'" in js
    assert 'data-v-act="show"' in js
    assert "title=\"预览\"" in js
    assert "按加入时间" in html
    assert "按更新时间" in html
    assert "按凭据名称" in html
    assert ".v-preview" in css
    assert ".v-card.is-open .v-preview" in css
    assert ".vault-cat-list" in css
    assert ".bm-layout{" in pages
    assert ".vault-cat-list" in mobile
    assert "v-preview .icon-btn-xs" in mobile
    assert "个账号" in js
    assert "eventHit" in js
    assert "toggleSel(card.dataset.vId)" in js


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
