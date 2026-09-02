"""万事屋 · 会话与口令
独立模块，避免 main ↔ routes 循环导入。
"""
import hashlib
import hmac
import secrets
import time
from typing import Optional

from fastapi import Header, HTTPException


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


# ---------- 会话（内存，重启后需重新登录） ----------
_sessions = {}  # token -> {username, expires}
SESSION_TTL = 7 * 24 * 3600


def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = {"username": username, "expires": time.time() + SESSION_TTL}
    return token


def drop_session(token: Optional[str]):
    if token:
        _sessions.pop(token, None)


def get_session_user(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    s = _sessions.get(token)
    if not s:
        return None
    if s["expires"] < time.time():
        _sessions.pop(token, None)
        return None
    return s["username"]


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
