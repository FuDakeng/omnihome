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

@router.get("/api/vault")
def get_vault(authorization: Optional[str] = Header(None)):
    return storage.user_json(require_user(authorization), "vault.json",
                             {"check": None, "items": {}})

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
    return FileResponse(str(EXTENSION_ZIP), filename="omnihome-extension.zip")

@router.get("/api/plugin.zip")
def download_plugin(authorization: Optional[str] = Header(None),
                    token: Optional[str] = None):
    require_user(authorization, token)
    data, version = _plugin_zip_bytes()
    if not data:
        raise HTTPException(404, "未找到 Obsidian 插件目录")
    from fastapi.responses import StreamingResponse
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition":
                             'attachment; filename="omnihome-sync.zip"'})

