"""万事屋 · 会话与口令
独立模块，避免 main ↔ routes 循环导入。
会话落盘 data/sessions.json，随 data 卷持久化；访问时滑动续期。
"""
import hashlib
import hmac
import json
import secrets
import threading
import time
from typing import Optional

from fastapi import Header, HTTPException

import storage


# ---------- 口令哈希（PBKDF2-SHA256） ----------
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


# ---------- 会话（落盘，重启后仍有效） ----------
_sessions = {}  # token -> {username, expires}
_lock = threading.RLock()
_last_save = 0.0
SESSION_TTL = 7 * 24 * 3600
_SAVE_MIN_INTERVAL = 60


def _sess_path():
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
    return storage.DATA_DIR / "sessions.json"


def _purge_expired(now: Optional[float] = None):
    now = time.time() if now is None else now
    dead = [k for k, v in _sessions.items()
            if not isinstance(v, dict) or float(v.get("expires") or 0) < now]
    for k in dead:
        _sessions.pop(k, None)


def save_sessions(force: bool = False):
    global _last_save
    now = time.time()
    with _lock:
        if not force and now - _last_save < _SAVE_MIN_INTERVAL:
            return
        _purge_expired(now)
        path = _sess_path()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_sessions, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        _last_save = now


def load_sessions():
    global _sessions
    path = _sess_path()
    with _lock:
        if not path.exists():
            _sessions = {}
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _sessions = {}
            return
        now = time.time()
        if not isinstance(data, dict):
            _sessions = {}
            return
        _sessions = {}
        for k, v in data.items():
            if not isinstance(v, dict):
                continue
            try:
                exp = float(v.get("expires") or 0)
            except (TypeError, ValueError):
                continue
            user = v.get("username")
            if exp > now and isinstance(user, str) and user:
                _sessions[k] = {"username": user, "expires": exp}


load_sessions()


def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    with _lock:
        _sessions[token] = {"username": username, "expires": time.time() + SESSION_TTL}
    save_sessions(force=True)
    return token


def drop_session(token: Optional[str]):
    if token:
        with _lock:
            _sessions.pop(token, None)
        save_sessions(force=True)


def get_session_user(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    now = time.time()
    with _lock:
        s = _sessions.get(token)
        if not s:
            return None
        if float(s.get("expires") or 0) < now:
            _sessions.pop(token, None)
            expired = True
            user = None
        else:
            expired = False
            s["expires"] = now + SESSION_TTL
            user = s.get("username")
    if expired:
        save_sessions(force=True)
        return None
    if user:
        save_sessions(force=False)
    return user


def require_user(authorization: Optional[str] = Header(None),
                 token: Optional[str] = None) -> str:
    # token 优先从 Authorization 头取，其次查询参数（用于下载链接）
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    username = get_session_user(token)
    if not username:
        raise HTTPException(401, "未登录或会话已过期")
    return username


def current_user_optional(authorization: Optional[str] = Header(None)) -> Optional[str]:
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
    return get_session_user(token)
