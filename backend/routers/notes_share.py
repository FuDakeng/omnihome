"""万事屋 · 笔记分享"""
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
from sessions import require_user, verify_password
import io as _io
import zipfile as _zipfile

router = APIRouter()
from routers.notes_lib import *  # noqa: F401,F403
from routers.notes_lib import (
    _shares_load, _shares_save, _share_gc, _share_public_list, _share_hash,
    _share_index_put, _share_index_del, _share_same_scope, _require_share,
    _enforce_share_login, _share_scope_notes, _share_scope_folders, _resolve_share,
    _find_note, _require_vault_edit, _note_to_md, _safe_fs_name, _gc_trash,
    _ensure_folder,
)

class ShareIn(BaseModel):
    kind: str = "note"          # note | folder
    noteId: str = ""
    folder: str = ""
    vault: str = ""
    expireDays: int = 7         # 0 = 十年
    canEdit: bool = False
    requireLogin: bool = False  # True = 本站已登录用户才能打开链接

@router.get("/api/notes/shares")
def list_shares(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    return {"shares": _share_public_list(username)}

@router.post("/api/notes/shares")
def create_share(body: ShareIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    kind = (body.kind or "note").strip()
    if kind not in ("note", "folder"):
        raise HTTPException(400, "分享类型无效")
    days = max(0, min(3650, int(body.expireDays)))
    expire_at = int(time.time()) + (3650 if days == 0 else days) * 86400
    name = ""
    note_id, folder, vault = "", "", body.vault or _active_vault_id(username)
    if kind == "note":
        note_id = (body.noteId or "").strip()
        idx = storage.notes_index(username)
        hit = next((n for n in idx if n.get("id") == note_id and not n.get("deleted")), None)
        if not hit:
            raise HTTPException(404, "笔记不存在")
        name = hit.get("title") or "未命名笔记"
        folder = hit.get("folder") or ""
        vault = _infer_note_vault(hit)
    else:
        folder = (body.folder or "").strip().strip("/")
        name = folder or "仓库根目录"
        if not _vault_by_id(username, vault):
            raise HTTPException(404, "笔记仓库不存在")
    raw = "s_" + secrets.token_urlsafe(18)
    sid = uuid.uuid4().hex[:10]
    h = _share_hash(raw)
    rec = {"id": sid, "hash": h, "kind": kind, "noteId": note_id, "folder": folder,
           "vault": vault, "canEdit": bool(body.canEdit), "canView": True,
           "requireLogin": bool(body.requireLogin),
           "expireAt": expire_at, "created": int(time.time()), "name": name,
           "prefix": raw[:8], "token": raw}
    items = _share_gc(username)
    items.append(rec)
    _shares_save(username, items)
    _share_index_put(h, username, sid)
    origin = ""
    return {"ok": True, "id": sid, "token": raw, "expireAt": expire_at,
            "canEdit": rec["canEdit"], "requireLogin": rec["requireLogin"],
            "name": name}

@router.delete("/api/notes/shares/{sid}")
def revoke_share(sid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    items = _share_gc(username)
    hit = next((x for x in items if x.get("id") == sid), None)
    if not hit:
        raise HTTPException(404, "分享不存在")
    keep = []
    for x in items:
        if x.get("id") == sid or _share_same_scope(x, hit):
            if x.get("hash"):
                _share_index_del(x["hash"])
            continue
        keep.append(x)
    _shares_save(username, keep)
    return {"ok": True}

class SharePatchIn(BaseModel):
    expireDays: Optional[int] = None
    canEdit: Optional[bool] = None
    requireLogin: Optional[bool] = None

@router.put("/api/notes/shares/{sid}")
def update_share(sid: str, body: SharePatchIn, authorization: Optional[str] = Header(None)):
    """更新已有分享的权限 / 有效期，不更换链接。"""
    username = require_user(authorization)
    items = _share_gc(username)
    rec = next((x for x in items if x.get("id") == sid), None)
    if not rec:
        raise HTTPException(404, "分享不存在")
    if body.canEdit is not None:
        rec["canEdit"] = bool(body.canEdit)
    if body.requireLogin is not None:
        rec["requireLogin"] = bool(body.requireLogin)
    if body.expireDays is not None:
        days = max(0, min(3650, int(body.expireDays)))
        rec["expireAt"] = int(time.time()) + (3650 if days == 0 else days) * 86400
    _shares_save(username, items)
    return {"ok": True, "id": sid, "canEdit": bool(rec.get("canEdit")),
            "requireLogin": bool(rec.get("requireLogin")),
            "expireAt": int(rec.get("expireAt") or 0),
            "token": rec.get("token") or ""}

@router.get("/api/share/{token}")
def share_get(token: str, authorization: Optional[str] = Header(None)):
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization)
    notes = _share_scope_notes(username, rec)
    items = [{"id": n["id"], "title": n.get("title") or "未命名笔记",
              "folder": n.get("folder") or "", "updated": int(n.get("updated") or 0)}
             for n in notes]
    folders = _share_scope_folders(username, rec)
    return {"ok": True, "kind": rec.get("kind"), "name": rec.get("name") or "",
            "canEdit": bool(rec.get("canEdit")), "canView": True,
            "requireLogin": bool(rec.get("requireLogin")),
            "expireAt": int(rec.get("expireAt") or 0), "notes": items,
            "folders": folders, "folder": rec.get("folder") or ""}

@router.get("/api/share/{token}/notes/{nid}")
def share_get_note(token: str, nid: str, authorization: Optional[str] = Header(None)):
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization)
    notes = _share_scope_notes(username, rec)
    hit = next((n for n in notes if n["id"] == nid), None)
    if not hit:
        raise HTTPException(404, "不在此分享范围内")
    editable = bool(rec.get("canEdit")) and not hit.get("readonly") and not hit.get("pinned")
    return {"id": nid, "title": hit.get("title") or "", "folder": hit.get("folder") or "",
            "content": storage.note_read(username, nid),
            "updated": int(hit.get("updated") or 0), "canEdit": editable}

@router.get("/api/share/{token}/notes/{nid}/export")
def share_export_note(token: str, nid: str, authorization: Optional[str] = Header(None),
                      access: Optional[str] = None):
    """公开分享：下载当前笔记为 .md（无需 Bearer；需登录的分享可带 access 会话）。"""
    from urllib.parse import quote as _quote
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization, access)
    notes = _share_scope_notes(username, rec)
    hit = next((n for n in notes if n["id"] == nid), None)
    if not hit:
        raise HTTPException(404, "不在此分享范围内")
    content = storage.note_read(username, nid) or ""
    data = _note_to_md(hit, content)
    fname = _safe_fs_name(hit.get("title") or nid) + ".md"
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "note.md"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=data,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )

@router.get("/api/share/{token}/export")
def share_export_all(token: str, authorization: Optional[str] = Header(None),
                     access: Optional[str] = None):
    """公开分享：范围内全部笔记打包 zip。"""
    from urllib.parse import quote as _quote
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization, access)
    picked = _share_scope_notes(username, rec)
    if not picked:
        raise HTTPException(404, "没有可下载的笔记")
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        used = set()
        for m in picked:
            folder = (m.get("folder") or "").strip("/")
            parts = [_safe_fs_name(p) for p in folder.split("/") if p] if folder else []
            arc = ("/".join(parts + [_safe_fs_name(m.get("title") or m["id"]) + ".md"])) if parts \
                else (_safe_fs_name(m.get("title") or m["id"]) + ".md")
            base = arc
            n = 2
            while arc in used:
                stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                arc = (f"{stem}-{n}.{ext}" if ext else f"{base}-{n}")
                n += 1
            used.add(arc)
            content = storage.note_read(username, m["id"]) or ""
            zf.writestr(arc, _note_to_md(m, content))
    buf.seek(0)
    fname = _safe_fs_name(rec.get("name") or "share") + ".zip"
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "share.zip"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )

class ShareNoteIn(BaseModel):
    content: Optional[str] = None
    title: Optional[str] = None

@router.put("/api/share/{token}/notes/{nid}")
def share_put_note(token: str, nid: str, body: ShareNoteIn,
                   authorization: Optional[str] = Header(None)):
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization)
    if not rec.get("canEdit"):
        raise HTTPException(403, "此分享仅可查看")
    notes = _share_scope_notes(username, rec)
    hit = next((n for n in notes if n["id"] == nid), None)
    if not hit:
        raise HTTPException(404, "不在此分享范围内")
    if hit.get("readonly") or hit.get("pinned"):
        raise HTTPException(403, "该笔记不可编辑")
    if body.content is not None:
        old = storage.note_read(username, nid, "")
        if old != body.content:
            storage.note_rev_snapshot(username, nid, old, hit.get("title") or "", "web")
        storage.note_write(username, nid, body.content)
    idx = storage.notes_index(username)
    for item in idx:
        if item["id"] == nid:
            item["updated"] = int(time.time())
            if body.title is not None:
                item["title"] = body.title
            break
    storage.save_notes_index(username, idx)
    return {"ok": True}

@router.get("/api/share/{token}/assets/{name}")
def share_get_asset(token: str, name: str, authorization: Optional[str] = Header(None),
                    access: Optional[str] = None):
    username, rec = _require_share(token)
    _enforce_share_login(rec, authorization, access)
    if not _ASSET_NAME.match(name):
        raise HTTPException(400, "非法附件名")
    raw = storage.asset_read(username, name)
    if raw is None:
        raise HTTPException(404, "附件不存在")
    try:
        meta = json.loads(raw)
        body = base64.b64decode(meta["d"])
    except Exception:
        raise HTTPException(500, "附件数据损坏")
    return Response(content=body, media_type=meta.get("t", "image/png"),
                    headers={"Cache-Control": "public, max-age=3600"})

