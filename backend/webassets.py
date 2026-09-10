"""组装前端入口：注入 VERSION、拼接 icons / views / overlays 片段。"""
from __future__ import annotations

import re
from pathlib import Path

ICON_MARK = "<!--ICONS-->"
VIEW_MARK = "<!--VIEWS-->"
OVERLAY_MARK = "<!--OVERLAYS-->"
VIEW_ORDER = ("dashboard", "monitor", "bookmarks", "vault", "notes", "toolbox")
OVERLAY_FILES = ("overlays-settings.html", "overlays.html")


def inject_version(html: str, version: str) -> str:
    html = html.replace("__VER__", version)
    return re.sub(r"\?v=[\w.\-]+", f"?v={version}", html)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8").rstrip() + "\n" if path.is_file() else ""


def render_index(frontend_dir: Path, version: str) -> str:
    html = _read(frontend_dir / "index.html")
    views_dir = frontend_dir / "views"
    html = html.replace(ICON_MARK, _read(views_dir / "icons.html"))
    chunks = [_read(views_dir / f"{name}.html") for name in VIEW_ORDER]
    html = html.replace(VIEW_MARK, "".join(chunks))
    overlays = "".join(_read(views_dir / name) for name in OVERLAY_FILES)
    html = html.replace(OVERLAY_MARK, overlays)
    return inject_version(html, version)
