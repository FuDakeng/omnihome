"""万事屋 · API 运行日志（环形缓冲 + 落盘轮转）

只记录 /api/* 的方法、路径、状态、耗时、用户名；不写请求/响应正文。
Authorization / X-API-Key / token 等密钥字段一律打码。
"""
import io
import json
import platform
import re
import threading
import time
import traceback
import zipfile
from collections import deque
from typing import Optional
from urllib.parse import parse_qsl, urlencode

import storage

_lock = threading.Lock()
_http = deque(maxlen=2000)
_exc = deque(maxlen=200)
_started = time.time()

MAX_FILE = 2 * 1024 * 1024
BACKUPS = 3
_REDACT_QS = {"token", "apikey", "api_key", "password", "key", "authorization"}
_SKIP_PATHS = {"/api/about/logs"}  # 导出自身不记，避免刷屏


def set_start(ts: float):
    global _started
    _started = ts


def _log_dir():
    p = storage.DATA_DIR / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _log_file():
    return _log_dir() / "omnihome.log"


def _rotate(path):
    if not path.exists() or path.stat().st_size < MAX_FILE:
        return
    for i in range(BACKUPS, 0, -1):
        src = path if i == 1 else path.with_name(path.name + "." + str(i - 1))
        dst = path.with_name(path.name + "." + str(i))
        if src.exists():
            try:
                src.replace(dst)
            except OSError:
                pass


def _append_file(line: str):
    path = _log_file()
    try:
        _rotate(path)
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _safe_path(path: str, query: str) -> str:
    if not query:
        return path
    parts = []
    for k, v in parse_qsl(query, keep_blank_values=True):
        if (k or "").lower() in _REDACT_QS:
            parts.append((k, "***"))
        else:
            parts.append((k, v))
    return path + (("?" + urlencode(parts)) if parts else "")


def _redact_text(s: str) -> str:
    if not s:
        return s
    s = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+", r"\1***", s)
    s = re.sub(r"(?i)(x-api-key\s*[:=]\s*)\S+", r"\1***", s)
    s = re.sub(r"(?i)((?:api[_-]?key|password|token)\s*[:=]\s*)\S+", r"\1***", s)
    return s


def user_from_headers(authorization: str = "", api_key: str = "",
                      token_qs: str = "") -> str:
    """从请求头/查询参数解析用户名（失败返回空串，不抛）。"""
    try:
        from sessions import get_session_user
    except Exception:
        get_session_user = None  # type: ignore
    tok = ""
    if authorization and authorization.lower().startswith("bearer "):
        tok = authorization[7:].strip()
    if not tok:
        tok = (token_qs or "").strip()
    if tok and get_session_user:
        try:
            u = get_session_user(tok)
            if u:
                return u
        except Exception:
            pass
    if api_key:
        try:
            ctx = storage.verify_sync_context(api_key)
            if ctx:
                return str(ctx.get("actor") or ctx.get("u") or "")
        except Exception:
            pass
    return ""


def record_http(method: str, path: str, status: int, ms: int, user: str = ""):
    raw_path = (path or "").split("?", 1)[0]
    if not raw_path.startswith("/api/") or raw_path in _SKIP_PATHS:
        return
    line = "%s  %s %s %s %dms user=%s" % (
        _now(), (method or "?").upper(), path, int(status), max(0, int(ms)),
        user or "-")
    with _lock:
        _http.append(line)
    _append_file(line)


def record_exception(method: str, path: str, user: str, tb: str):
    block = "%s  ERROR %s %s user=%s\n%s" % (
        _now(), (method or "?").upper(), path, user or "-",
        _redact_text(tb or "").rstrip())
    with _lock:
        _exc.append({"user": user or "", "text": block})
    _append_file(block)


def _line_user(line: str) -> str:
    m = re.search(r"\suser=(\S+)", line or "")
    return m.group(1) if m else ""


def _keep_line(line: str, username: str, is_admin: bool) -> bool:
    if is_admin:
        return True
    who = _line_user(line)
    return who == username


def _file_lines():
    out = []
    d = _log_dir()
    for name in ("omnihome.log.3", "omnihome.log.2", "omnihome.log.1", "omnihome.log"):
        p = d / name
        if not p.exists():
            continue
        try:
            out.extend(p.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            pass
    return out


def _http_export(username: str, is_admin: bool) -> str:
    with _lock:
        ring = list(_http)
    seen = set()
    lines = []
    for src in (_file_lines(), ring):
        for line in src:
            if line in seen:
                continue
            seen.add(line)
            if _keep_line(line, username, is_admin):
                lines.append(line)
    return "\n".join(lines) + ("\n" if lines else "")


def _exc_export(username: str, is_admin: bool) -> str:
    with _lock:
        items = list(_exc)
    blocks = []
    for it in items:
        if is_admin or (it.get("user") or "") == username:
            blocks.append(it.get("text") or "")
    file_err = []
    buf = []
    for line in _file_lines():
        if line.endswith(" ERROR") or "  ERROR " in line[:40]:
            if buf:
                file_err.append("\n".join(buf))
            buf = [line]
        elif buf and (line[:4].isdigit() is False or "  ERROR " in line[:40]
                      or line.startswith(" ")):
            if re.match(r"^\d{4}-\d{2}-\d{2} ", line) and "  ERROR " not in line[:40]:
                file_err.append("\n".join(buf))
                buf = []
            else:
                buf.append(line)
        elif buf:
            file_err.append("\n".join(buf))
            buf = []
    if buf:
        file_err.append("\n".join(buf))
    seen = set(blocks)
    for b in file_err:
        if b in seen:
            continue
        if _keep_line(b.splitlines()[0] if b else "", username, is_admin):
            blocks.append(b)
            seen.add(b)
    return ("\n\n".join(blocks) + ("\n" if blocks else ""))


def build_zip(username: str, is_admin: bool, extra_system: Optional[dict] = None) -> bytes:
    days = int((time.time() - _started) // 86400)
    hours = int((time.time() - _started) % 86400 // 3600)
    system = {
        "name": "万事屋",
        "version": __import__("app_version").VERSION,
        "stage": __import__("app_version").STAGE,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "engine": storage.engine(),
        "uptime": "%d 天 %d 小时" % (days, hours),
        "exportedAt": _now(),
        "exportedBy": username,
        "role": "admin" if is_admin else "member",
    }
    if extra_system:
        system.update(extra_system)
    sync_logs = storage.read_sync_log(username, None, storage.SYNC_LOG_MAX)
    readme = (
        "万事屋运行诊断包\n"
        "================\n"
        "system.json     版本 / 存储引擎 / 运行时长（不含密钥）\n"
        "sync-log.json   当前用户的笔记同步日志\n"
        "http.log        API 访问记录（成员仅本人；管理员为全量，密钥已打码）\n"
        "exceptions.log  未处理异常堆栈（密钥已打码）\n"
        "\n"
        "不含：笔记正文、密码箱、备份内容、API Key、登录密码。\n"
        "导出人：%s（%s）  时间：%s\n" % (
            username, system["role"], system["exportedAt"])
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", readme)
        z.writestr("system.json", json.dumps(system, ensure_ascii=False, indent=2))
        z.writestr("sync-log.json", json.dumps(sync_logs, ensure_ascii=False, indent=2))
        z.writestr("http.log", _http_export(username, is_admin) or "(暂无 API 访问记录)\n")
        z.writestr("exceptions.log", _exc_export(username, is_admin) or "(暂无未处理异常)\n")
    return buf.getvalue()
