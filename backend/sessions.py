"""万事屋 · 会话与口令

会话存 data/sessions.sqlite（WAL），多进程 worker 可共享。
启动时若存在旧版 sessions.json 则一次性导入后改名为 .bak。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
from typing import Optional

from fastapi import Header, HTTPException

import storage

SESSION_TTL = 7 * 24 * 3600
_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def hash_password(password: str, salt: Optional[bytes] = None):
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return salt.hex() + "$" + dk.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, dk_hex = stored.split("$", 1)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 bytes.fromhex(salt_hex), 120_000)
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, AttributeError):
        return False


def _db_path():
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
    return storage.DATA_DIR / "sessions.sqlite"


def _connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    path = str(_db_path())
    if conn is not None and getattr(_local, "path", None) == path:
        return conn
    conn = sqlite3.connect(path, timeout=30, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions ("
        "token TEXT PRIMARY KEY, username TEXT NOT NULL, expires REAL NOT NULL)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires)"
    )
    _local.conn = conn
    _local.path = path
    return conn


def _migrate_json():
    src = storage.DATA_DIR / "sessions.json"
    if not src.exists():
        return
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    now = time.time()
    conn = _connect()
    if isinstance(data, dict):
        for token, rec in data.items():
            if not isinstance(rec, dict):
                continue
            user = rec.get("username")
            try:
                exp = float(rec.get("expires") or 0)
            except (TypeError, ValueError):
                continue
            if isinstance(user, str) and user and exp > now:
                conn.execute(
                    "INSERT OR REPLACE INTO sessions(token, username, expires) "
                    "VALUES (?,?,?)", (token, user, exp))
    bak = src.with_suffix(".json.bak")
    try:
        src.replace(bak)
    except OSError:
        pass


def _ensure():
    global _initialized
    if _initialized:
        _connect()
        return
    with _init_lock:
        _connect()
        if not _initialized:
            _migrate_json()
            _initialized = True


def save_sessions(force: bool = False):
    """兼容旧测试/调用：sqlite 每次写入已落盘，此处为 no-op。"""
    return


def load_sessions():
    """兼容旧调用：确保库已初始化。"""
    _ensure()


class _SessionCache:
    """兼容旧测试：clear() 丢掉线程连接缓存，下次从 sqlite 再读。"""

    def clear(self):
        conn = getattr(_local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        _local.conn = None
        _local.path = None


_sessions = _SessionCache()


def create_session(username: str) -> str:
    _ensure()
    token = secrets.token_urlsafe(32)
    exp = time.time() + SESSION_TTL
    _connect().execute(
        "INSERT OR REPLACE INTO sessions(token, username, expires) VALUES (?,?,?)",
        (token, username, exp),
    )
    return token


def drop_session(token: Optional[str]):
    if not token:
        return
    _ensure()
    _connect().execute("DELETE FROM sessions WHERE token = ?", (token,))


def get_session_user(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    _ensure()
    now = time.time()
    conn = _connect()
    row = conn.execute(
        "SELECT username, expires FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    if not row:
        return None
    user, exp = row
    if float(exp or 0) < now:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        return None
    conn.execute(
        "UPDATE sessions SET expires = ? WHERE token = ?",
        (now + SESSION_TTL, token),
    )
    return user


def require_user(authorization: Optional[str] = Header(None),
                 token: Optional[str] = None) -> str:
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    username = get_session_user(token)
    if not username:
        raise HTTPException(401, "未登录或会话已过期")
    return username


def current_user_optional(authorization: Optional[str] = Header(None)) -> Optional[str]:
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
    return get_session_user(token)


load_sessions()
