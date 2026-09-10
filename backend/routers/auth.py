"""万事屋 · 认证与账号"""
from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

import storage
from sessions import (hash_password, verify_password, create_session, drop_session,
                      require_user, current_user_optional)

router = APIRouter()
LINK_EXPIRE_DAYS = 30

# ---------- 数据模型 ----------
class RegisterIn(BaseModel):
    username: str
    password: str
    nickname: str = ""


class LoginIn(BaseModel):
    username: str
    password: str


class PasswordChangeIn(BaseModel):
    oldPassword: str
    newPassword: str


class RegisterCfgIn(BaseModel):
    allowRegister: bool


class AvatarIn(BaseModel):
    data: str = ""       # dataURL（base64）；与 remove 二选一
    remove: bool = False


class LinkIn(BaseModel):
    username: str
    password: str


class SwitchIn(BaseModel):
    username: str
    password: str = ""   # 已绑定且未过期时免密；否则必填


# ---------- 认证路由 ----------
@router.get("/api/auth/first")
def auth_first():
    """系统是否已有用户（无用户时允许注册，注册即管理员），
    及是否开放新用户注册（管理员可在设置中开关）。"""
    cfg = storage.get_config()
    return {"hasUsers": bool(cfg["users"]),
            "allowRegister": bool(cfg.get("allowRegister"))}


@router.put("/api/auth/register-config")
def put_register_config(body: RegisterCfgIn,
                        authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    if cfg["users"].get(username, {}).get("role") != "admin":
        raise HTTPException(403, "仅管理员可修改注册开关")
    cfg["allowRegister"] = body.allowRegister
    storage.save_config(cfg)
    return {"ok": True, "allowRegister": body.allowRegister}


@router.post("/api/auth/register")
def register(body: RegisterIn):
    cfg = storage.get_config()
    if cfg["users"] and not cfg.get("allowRegister"):
        raise HTTPException(403, "未开放注册，请联系管理员添加账号")
    if cfg["users"] and not storage.valid_username(body.username):
        raise HTTPException(400, "用户名格式不正确")
    if not storage.valid_username(body.username):
        raise HTTPException(400, "用户名仅支持字母、数字、中文、下划线（1-32 位）")
    if body.username in cfg["users"]:
        raise HTTPException(409, "用户名已存在")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    role = "admin" if not cfg["users"] else "member"
    cfg["users"][body.username] = {
        "password": hash_password(body.password),
        "nickname": body.nickname or body.username,
        "email": "",
        "role": role,
        "createdAt": time.strftime("%Y-%m-%d %H:%M"),
    }
    storage.save_config(cfg)
    storage.ensure_user_dir(body.username)
    storage.save_prefs(body.username, storage.DEFAULT_PREFS)
    token = create_session(body.username)
    return {"token": token, "user": _public_user(body.username, cfg)}


@router.post("/api/auth/login")
def login(body: LoginIn, request: Request):
    cfg = storage.get_config()
    u = cfg["users"].get(body.username)
    if not u or not verify_password(body.password, u["password"]):
        raise HTTPException(401, "用户名或密码错误")
    _record_login(cfg, body.username, request)
    token = create_session(body.username)
    return {"token": token, "user": _public_user(body.username, cfg)}


# ---------- 登录记录（设备 / 位置 / 时间，真实采集） ----------
def _ua_label(ua: str) -> str:
    """从 User-Agent 提取可读的设备标识（系统 + 浏览器）。"""
    ua = ua or ""
    if "iPhone" in ua or "iPad" in ua:
        osn = "iOS"
    elif "Android" in ua:
        osn = "Android"
    elif "Mac OS X" in ua or "macOS" in ua:
        osn = "Mac"
    elif "Windows" in ua:
        osn = "Windows"
    elif "Linux" in ua:
        osn = "Linux"
    else:
        osn = "未知设备"
    if "Edg" in ua:
        br = "Edge"
    elif "Firefox" in ua:
        br = "Firefox"
    elif "Chrome" in ua:
        br = "Chrome"
    elif "Safari" in ua:
        br = "Safari"
    else:
        br = "浏览器"
    return f"{osn} · {br}"


def _ip_label(ip: str) -> str:
    """自托管场景无地理位置服务，按 IP 段给出准确且不外泄的描述。"""
    ip = (ip or "").strip()
    if ip in ("127.0.0.1", "::1", "localhost"):
        return "本机"
    if ip.startswith(("192.168.", "10.")) or ip.startswith("172.1") \
            or ip.startswith("fc") or ip.startswith("fd"):
        return "局域网"
    return ip or "未知"


def _record_login(cfg: dict, username: str, request: Request):
    """每次登录追加一条真实记录（最近 10 条），并同步保存。"""
    u = cfg["users"].get(username)
    if u is None:
        return
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() \
        or (request.client.host if request.client else "")
    rec = {"ts": int(time.time()),
           "device": _ua_label(request.headers.get("user-agent", "")),
           "ip": ip, "place": _ip_label(ip)}
    logins = [x for x in u.get("logins") or [] if isinstance(x, dict)]
    u["logins"] = ([rec] + logins)[:10]
    storage.save_config(cfg)


@router.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        drop_session(authorization[7:])
    return {"ok": True}


def _public_user(username: str, cfg: dict) -> dict:
    u = cfg["users"][username]
    return {"username": username, "nickname": u.get("nickname", username),
            "email": u.get("email", ""), "role": u.get("role", "member"),
            "avatar": u.get("avatar", ""),
            "pwdChangedAt": u.get("pwdChangedAt", ""),
            "createdAt": u.get("createdAt", ""),
            # 监控开关随用户对象下发：登录 / 注册 / 切换 / 会话恢复四条路径统一生效，
            # 避免管理员登录后要刷新页面才看得到系统监控入口
            "monitorEnabled": bool(cfg.get("monitorEnabled"))}


@router.get("/api/auth/session")
def session(authorization: Optional[str] = Header(None)):
    username = current_user_optional(authorization)
    if not username:
        return {"user": None}
    cfg = storage.get_config()
    if username not in cfg["users"]:
        return {"user": None}
    return {"user": _public_user(username, cfg),
            "monitorEnabled": bool(cfg.get("monitorEnabled"))}


# ---------- 账号管理（设置中心 · 用户与账号） ----------
@router.put("/api/auth/profile")
def update_profile(nickname: str = "",
                   user: str = None, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    cfg["users"][username]["nickname"] = nickname or username
    storage.save_config(cfg)
    return {"user": _public_user(username, cfg)}


@router.put("/api/auth/avatar")
def update_avatar(body: AvatarIn, authorization: Optional[str] = Header(None)):
    """更换 / 移除头像（base64 dataURL，限 200KB 内，前端已压缩）。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    u = cfg["users"][username]
    if body.remove:
        u.pop("avatar", None)
    else:
        if not body.data.startswith("data:image/"):
            raise HTTPException(400, "头像格式不正确（需 PNG / JPG）")
        if len(body.data) > 200 * 1024:
            raise HTTPException(400, "头像过大，请使用更小的图片")
        u["avatar"] = body.data
    storage.save_config(cfg)
    return {"user": _public_user(username, cfg)}


@router.get("/api/auth/logins")
def list_logins(authorization: Optional[str] = Header(None)):
    """当前用户的登录记录（最近 10 条，含当前会话标识）。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    return {"logins": cfg["users"][username].get("logins") or []}


@router.delete("/api/auth/logins/{ts}")
def remove_login(ts: int, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    u = cfg["users"][username]
    before = len(u.get("logins") or [])
    u["logins"] = [x for x in u.get("logins") or []
                   if not (isinstance(x, dict) and x.get("ts") == ts)]
    if len(u["logins"]) == before:
        raise HTTPException(404, "登录记录不存在")
    storage.save_config(cfg)
    return {"ok": True}


@router.put("/api/auth/password")
def change_password(body: PasswordChangeIn,
                    authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    u = cfg["users"][username]
    if not verify_password(body.oldPassword, u["password"]):
        raise HTTPException(400, "原密码不正确")
    if len(body.newPassword) < 6:
        raise HTTPException(400, "新密码至少 6 位")
    u["password"] = hash_password(body.newPassword)
    u["pwdChangedAt"] = time.strftime("%Y-%m-%d %H:%M")
    storage.save_config(cfg)
    return {"ok": True, "pwdChangedAt": u["pwdChangedAt"]}


@router.get("/api/auth/users")
def list_users(authorization: Optional[str] = Header(None)):
    """管理员：全部账号；普通用户：自己 + 已绑定的账号。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    me = cfg["users"][username]
    out = []
    if me.get("role") == "admin":
        for name, u in cfg["users"].items():
            out.append({"username": name, "nickname": u.get("nickname", name),
                        "role": u.get("role", "member"), "bound": False,
                        "createdAt": u.get("createdAt", "")})
        return out
    out.append({"username": username, "nickname": me.get("nickname", username),
                "role": me.get("role", "member"), "bound": False,
                "createdAt": me.get("createdAt", "")})
    for name in (me.get("links") or {}):
        u = cfg["users"].get(name)
        if not u:
            continue
        out.append({"username": name, "nickname": u.get("nickname", name),
                    "role": u.get("role", "member"), "bound": True,
                    "createdAt": u.get("createdAt", "")})
    return out


# ---------- 账号绑定与切换（验证成功后双向绑定，免密切换） ----------
def _links_of(cfg: dict, username: str) -> list:
    """当前用户的绑定列表（含过期状态，按最近切换排序）。"""
    me = cfg["users"].get(username) or {}
    now = time.time()
    out = []
    for name, ts in (me.get("links") or {}).items():
        u = cfg["users"].get(name)
        if not u:
            continue
        out.append({"username": name, "nickname": u.get("nickname", name),
                    "avatar": u.get("avatar", ""),
                    "lastSwitch": time.strftime("%Y-%m-%d %H:%M",
                                                time.localtime(ts)) if ts else "",
                    "expired": bool(ts) and (now - ts) > LINK_EXPIRE_DAYS * 86400})
    out.sort(key=lambda x: x["lastSwitch"], reverse=True)
    return out


def _touch_link(cfg: dict, a: str, b: str):
    """双向绑定 / 刷新双向的最近切换时间。"""
    now = time.time()
    for x, y in ((a, b), (b, a)):
        if x not in cfg["users"] or y not in cfg["users"]:
            continue
        links = cfg["users"][x].setdefault("links", {})
        links[y] = now


@router.get("/api/auth/links")
def list_links(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    return {"links": _links_of(cfg, username), "expireDays": LINK_EXPIRE_DAYS}


@router.post("/api/auth/switch")
def switch_user(body: SwitchIn, authorization: Optional[str] = Header(None),
                request: Request = None):
    """切换到目标账号：已绑定且未过期免密；否则验证目标密码，
    验证成功后双向绑定（首次绑定即从此处发生）。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    target = cfg["users"].get(body.username)
    if not target:
        raise HTTPException(404, "用户不存在")
    if body.username == username:
        raise HTTPException(400, "已在当前账号")
    links = cfg["users"][username].get("links") or {}
    ts = links.get(body.username)
    fresh = bool(ts) and (time.time() - ts) <= LINK_EXPIRE_DAYS * 86400
    if not fresh:
        if not body.password or not verify_password(body.password,
                                                    target["password"]):
            raise HTTPException(
                401, "绑定已过期或未绑定，请输入该账号的密码验证")
    _touch_link(cfg, username, body.username)
    _record_login(cfg, body.username, request)
    storage.save_config(cfg)
    token = create_session(body.username)
    return {"token": token, "user": _public_user(body.username, cfg),
            "linked": True}


@router.delete("/api/auth/link/{name}")
def unlink_user(name: str, authorization: Optional[str] = Header(None)):
    """解绑：双向移除绑定关系。"""
    username = require_user(authorization)
    cfg = storage.get_config()
    removed = False
    for x, y in ((username, name), (name, username)):
        links = cfg["users"].get(x, {}).get("links")
        if links and y in links:
            del links[y]
            removed = True
    if not removed:
        raise HTTPException(404, "未绑定该账号")
    storage.save_config(cfg)
    return {"ok": True}


@router.post("/api/auth/users")
def add_user(body: RegisterIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    if cfg["users"][username].get("role") != "admin":
        raise HTTPException(403, "仅管理员可添加用户")
    if not storage.valid_username(body.username) or body.username in cfg["users"]:
        raise HTTPException(400, "用户名不可用")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    cfg["users"][body.username] = {
        "password": hash_password(body.password),
        "nickname": body.nickname or body.username,
        "email": "", "role": "member",
        "createdAt": time.strftime("%Y-%m-%d %H:%M"),
    }
    storage.save_config(cfg)
    storage.ensure_user_dir(body.username)
    storage.save_prefs(body.username, storage.DEFAULT_PREFS)
    return {"ok": True}


@router.delete("/api/auth/users/{name}")
def remove_user(name: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = storage.get_config()
    if cfg["users"][username].get("role") != "admin":
        raise HTTPException(403, "仅管理员可删除用户")
    if name == username:
        raise HTTPException(400, "不能删除自己")
    if name not in cfg["users"]:
        raise HTTPException(404, "用户不存在")
    del cfg["users"][name]
    storage.save_config(cfg)
    return {"ok": True}


