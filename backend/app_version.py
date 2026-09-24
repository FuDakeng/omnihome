"""万事屋 · 版本与更新日志
版本号唯一来源：打包、镜像构建、/api/about 均读取这里的 VERSION。
每次发版请同步更新 VERSION 与仓库根目录 CHANGELOG.md（新版本置顶）。
"""
import json
from pathlib import Path

VERSION = "0.3.18"
STAGE = "编辑器"

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


def dumps_for_http(data) -> str:
    """JSON 正文里不出现原始的 `</`。

    部分 NAS 会在响应里搜索 `</body>` / `</script>` 并插入备案 HTML。
    更新日志一旦写出这两个字，`/api/about` 的 JSON 会被截断，
    前端就读不到版本号（显示 vundefined），更新弹窗也不会出现。
    `</` 写成 `<\\/` 后，标准 JSON 解析仍还原成 `</`。
    """
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
