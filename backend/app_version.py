"""万事屋 · 版本与更新日志
版本号唯一来源：打包、镜像构建、/api/about 均读取这里的 VERSION。
每次发版请同步更新 VERSION 与仓库根目录 CHANGELOG.md（新版本置顶）。
"""
from pathlib import Path

VERSION = "0.3.3"
STAGE = "手机导航"

_CHANGELOG_FILE = Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def _parse_changelog(text: str) -> list:
    entries = []
    cur = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            if cur:
                entries.append(cur)
            head = line[3:].strip()
            if "—" in head:
                ver, date = [x.strip() for x in head.split("—", 1)]
            elif " - " in head:
                ver, date = [x.strip() for x in head.split(" - ", 1)]
            else:
                ver, date = head, ""
            cur = {"version": ver, "date": date, "items": []}
        elif line.startswith("- ") and cur is not None:
            cur["items"].append(line[2:].strip())
    if cur:
        entries.append(cur)
    return entries


def load_changelog() -> list:
    try:
        return _parse_changelog(_CHANGELOG_FILE.read_text(encoding="utf-8"))
    except OSError:
        return [{"version": VERSION, "date": "", "items": []}]


CHANGELOG = load_changelog()
