"""万事屋 · 计划 / 日历 / 保险库 / 工具 / 搜索"""
from __future__ import annotations

import re
import hashlib
import secrets
import threading
import time
import uuid
import json
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Body, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import storage
import secretbox
import teams
import translate as translate_svc
from sessions import require_user, verify_password
from routers.common import _require_admin
from routers.data import EXTENSION_ZIP, _plugin_zip_bytes

router = APIRouter()

class PlanIn(BaseModel):
    content: str

@router.get("/api/plan")
def get_plan(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    return {"content": storage.user_text(username, "plan.md", "- [ ] \n")}

@router.put("/api/plan")
def put_plan(body: PlanIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    storage.save_user_text(username, "plan.md", body.content)
    return {"ok": True}

class EventIn(BaseModel):
    date: str          # YYYY-MM-DD
    title: str
    note: str = ""

@router.get("/api/calendar")
def get_events(month: str = "", authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = storage.user_json(username, "calendar.json", [])
    if month and re.match(r"^\d{4}-\d{2}$", month):
        # 返回当月 + 相邻月需要的范围（前端直接全量也可，数据量小）
        pass
    return events

@router.post("/api/calendar")
def add_event(body: EventIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = storage.user_json(username, "calendar.json", [])
    ev = {"id": uuid.uuid4().hex[:8], "date": body.date,
          "title": body.title, "note": body.note}
    events.append(ev)
    events.sort(key=lambda e: e["date"])
    storage.save_user_json(username, "calendar.json", events)
    return ev

@router.delete("/api/calendar/{eid}")
def delete_event(eid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    events = [e for e in storage.user_json(username, "calendar.json", [])
              if e["id"] != eid]
    storage.save_user_json(username, "calendar.json", events)
    return {"ok": True}

class VaultBlob(BaseModel):
    id: str
    blob: str       # base64(AES-GCM 密文)
    meta: dict = {} # 仅存非敏感元数据（站点名），由客户端决定是否加密

class VaultSaveIn(BaseModel):
    check: Optional[str] = None   # 主密码校验密文
    salt: Optional[str] = None    # PBKDF2 盐（非敏感）
    items: Optional[dict] = None  # id -> {blob, meta}

class VaultAttemptIn(BaseModel):
    success: bool = False

class VaultFreezeCfgIn(BaseModel):
    enabled: bool

class VaultUnfreezeIn(BaseModel):
    username: str


# 保险库主密码在浏览器端校验，服务端无法直接验证；由客户端上报本次解锁结果，
# 服务端只负责持久化连续失败次数与冻结截止时间。这样刷新页面或换设备后
# 冻结状态仍然有效，避免旧版仅存在内存里的 failCount 一刷新就丢失。
VAULT_FREEZE_LIMIT = 5
VAULT_FREEZE_SECONDS = 10 * 60
VAULT_LOCK_FILE = "vault-lock.json"


def _vault_freeze_enabled(cfg: Optional[dict] = None) -> bool:
    """全局开关，缺省开启（兼容历史 config.json）。"""
    return bool((cfg or storage.get_config()).get("vaultFreezeEnabled", True))


def _vault_freeze_info(state: dict, enabled: Optional[bool] = None) -> dict:
    if enabled is None:
        enabled = _vault_freeze_enabled()
    if not isinstance(state, dict):
        state = {}
    now = int(time.time())
    failures = max(0, int(state.get("failures") or 0))
    until = int(state.get("frozenUntil") or 0)
    frozen = bool(enabled and until > now)
    return {
        "enabled": bool(enabled),
        "failures": failures if enabled else 0,
        "frozen": frozen,
        "frozenUntil": until if frozen else 0,
        "remaining": max(0, until - now) if frozen else 0,
        "lastFailedAt": int(state.get("lastFailedAt") or 0),
        "frozenAt": int(state.get("frozenAt") or 0) if frozen else 0,
        "limit": VAULT_FREEZE_LIMIT,
    }


def _clear_vault_freeze(username: str):
    storage.delete_user_file(username, VAULT_LOCK_FILE)


@router.get("/api/vault")
def get_vault(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    vault = storage.user_json(username, "vault.json",
                              {"check": None, "salt": None, "items": {}})
    vault["freeze"] = _vault_freeze_info(
        storage.user_json(username, VAULT_LOCK_FILE, {}))
    return vault


@router.get("/api/vault/freeze")
def get_vault_freeze(authorization: Optional[str] = Header(None)):
    """当前用户的冻结状态（轻量接口，锁定页轮询用）。"""
    username = require_user(authorization)
    return _vault_freeze_info(storage.user_json(username, VAULT_LOCK_FILE, {}))


@router.put("/api/vault")
def put_vault(body: VaultSaveIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    vault = storage.user_json(username, "vault.json", {"check": None, "items": {}})
    if body.check is not None:
        vault["check"] = body.check
    if body.salt is not None:
        vault["salt"] = body.salt
    if body.items is not None:
        vault["items"] = body.items
    vault["updatedAt"] = int(time.time())
    storage.save_user_json(username, "vault.json", vault)
    return {"ok": True}


@router.post("/api/vault/unlock-attempt")
def vault_unlock_attempt(body: VaultAttemptIn,
                         authorization: Optional[str] = Header(None)):
    """记录一次保险库解锁结果：成功清零，失败累计并在第 5 次冻结 10 分钟。"""
    username = require_user(authorization)
    enabled = _vault_freeze_enabled()
    state = storage.user_json(username, VAULT_LOCK_FILE, {})
    if not isinstance(state, dict):
        state = {}

    if not enabled:
        _clear_vault_freeze(username)
        return {"ok": True, **_vault_freeze_info({}, enabled=False)}

    now = int(time.time())
    until = int(state.get("frozenUntil") or 0)

    # 冻结期内继续尝试：不累加失败次数，保持原冻结截止时间
    if until > now:
        return {"ok": True, **_vault_freeze_info(state, enabled=True)}

    # 上一次冻结已到期：本次从 0 开始重新计数
    if until and until <= now:
        state = {"failures": 0}

    if body.success:
        _clear_vault_freeze(username)
        return {"ok": True, **_vault_freeze_info({}, enabled=True)}

    failures = max(0, int(state.get("failures") or 0)) + 1
    state = {
        "failures": failures,
        "lastFailedAt": now,
        "frozenUntil": now + VAULT_FREEZE_SECONDS if failures >= VAULT_FREEZE_LIMIT else 0,
    }
    if failures >= VAULT_FREEZE_LIMIT:
        state["frozenAt"] = now
    storage.save_user_json(username, VAULT_LOCK_FILE, state)
    return {"ok": True, **_vault_freeze_info(state, enabled=True)}


@router.get("/api/vault/freeze/users")
def vault_freeze_users(authorization: Optional[str] = Header(None)):
    """管理员：当前被冻结的账号列表。"""
    username = require_user(authorization)
    _require_admin(username)
    cfg = storage.get_config()
    enabled = _vault_freeze_enabled(cfg)
    out = []
    if enabled:
        for name, user in cfg.get("users", {}).items():
            info = _vault_freeze_info(
                storage.user_json(name, VAULT_LOCK_FILE, {}), enabled=True)
            if not info["frozen"]:
                continue
            out.append({
                "username": name,
                "nickname": user.get("nickname", name),
                "role": user.get("role", "member"),
                "failures": info["failures"],
                "remaining": info["remaining"],
                "frozenUntil": info["frozenUntil"],
                "lastFailedAt": info["lastFailedAt"],
            })
    out.sort(key=lambda x: x.get("frozenUntil") or 0, reverse=True)
    return {"enabled": enabled, "users": out,
            "limit": VAULT_FREEZE_LIMIT, "duration": VAULT_FREEZE_SECONDS}


@router.put("/api/vault/freeze-config")
def put_vault_freeze_config(body: VaultFreezeCfgIn,
                            authorization: Optional[str] = Header(None)):
    """管理员：开启/关闭连续输错冻结。关闭时立即清除所有冻结与失败计数。"""
    username = require_user(authorization)
    _require_admin(username)
    cfg = storage.get_config()
    cfg["vaultFreezeEnabled"] = bool(body.enabled)
    storage.save_config(cfg)
    if not body.enabled:
        for name in cfg.get("users", {}):
            _clear_vault_freeze(name)
    return {"ok": True, "enabled": cfg["vaultFreezeEnabled"]}


@router.post("/api/vault/freeze/unfreeze")
def vault_unfreeze(body: VaultUnfreezeIn,
                   authorization: Optional[str] = Header(None)):
    """管理员：解除指定账号的保险库冻结，并清零失败次数。"""
    username = require_user(authorization)
    _require_admin(username)
    cfg = storage.get_config()
    if body.username not in cfg.get("users", {}):
        raise HTTPException(404, "用户不存在")
    _clear_vault_freeze(body.username)
    return {"ok": True, "username": body.username}

@router.get("/api/tools/translate")
def translate(text: str, source: str = "zh-CN", target: str = "en",
              authorization: Optional[str] = Header(None)):
    require_user(authorization)
    try:
        out = translate_svc.translate_text(text, source, target)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"翻译服务暂不可用：{e}")
    return {"translation": out}

@router.get("/api/search/site")
def site_search(q: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    q = q.strip().lower()
    results = []
    if not q:
        return results
    for bm in _bookmarks(username):
        if q in bm.get("name", "").lower() or q in bm.get("url", "").lower():
            results.append({"type": "bookmark", "title": bm["name"],
                            "sub": bm.get("url", ""), "go": "bookmarks"})
    for item in storage.notes_index(username):
        if q in item.get("title", "").lower():
            results.append({"type": "note", "title": item["title"],
                            "sub": "笔记", "go": "notes", "id": item["id"]})
    # 笔记正文
    for item in storage.notes_index(username):
        if q in storage.note_read(username, item["id"]).lower():
            if not any(r.get("id") == item["id"] for r in results):
                results.append({"type": "note", "title": item["title"],
                                "sub": "正文命中", "go": "notes", "id": item["id"]})
    plan = storage.user_text(username, "plan.md")
    if q in plan.lower():
        for line in plan.splitlines():
            if q in line.lower():
                results.append({"type": "plan", "title": line.strip("- []x"),
                                "sub": "今日计划", "go": "dashboard"})
                break
    vault = storage.user_json(username, "vault.json", {"items": {}})
    for _, v in vault.get("items", {}).items():
        name = v.get("meta", {}).get("name", "")
        if name and q in name.lower():
            results.append({"type": "vault", "title": name,
                            "sub": "保险库条目", "go": "vault"})
    for ev in storage.user_json(username, "calendar.json", []):
        if q in ev.get("title", "").lower():
            results.append({"type": "event", "title": ev["title"],
                            "sub": f"日程 · {ev['date']}", "go": "dashboard"})
    return results[:20]

@router.get("/api/extension.zip")
def download_extension(authorization: Optional[str] = Header(None),
                       token: Optional[str] = None):
    require_user(authorization, token)
    if not EXTENSION_ZIP.exists():
        raise HTTPException(
            404, "未找到扩展安装包：请将 omnihome-extension.zip 放到部署包根目录")
    return FileResponse(
        str(EXTENSION_ZIP),
        media_type="application/zip",
        filename="omnihome-extension.zip",
        headers={"Cache-Control": "no-transform"},
    )

@router.get("/api/plugin.zip")
def download_plugin(authorization: Optional[str] = Header(None),
                    token: Optional[str] = None):
    require_user(authorization, token)
    data, version = _plugin_zip_bytes()
    if not data:
        raise HTTPException(404, "未找到 Obsidian 插件目录")
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="omnihome-sync.zip"',
            "Cache-Control": "no-transform",
        },
    )

