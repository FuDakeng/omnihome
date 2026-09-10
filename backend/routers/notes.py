"""万事屋 · 知识库"""
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

router = APIRouter()
from routers.notes_lib import *  # noqa: F401,F403
from routers.notes_lib import (
    PINNED_TITLES, PLAN_FOLDER, QUICK_FOLDER, VAULT_DEFAULT, VAULT_SYSTEM,
    _require_vault_edit, _load_vaults, _save_vaults, _vault_by_id,
    _ensure_vaults, _active_vault_id, _vault_public, _merged_notes_payload,
    _ensure_pinned, _gc_trash, _find_note, _ensure_folder, _is_junk_path,
    _safe_fs_name, _note_to_md, _parse_md, _create_imported_note,
    _folder_vault, _folder_claimed, _folder_claim, _folder_unclaim,
    _folders_in_vault, _infer_note_vault, _is_builtin_folder,
    _add_member_projection, _drop_member_projection, _refresh_team_projections,
    _rename_quick, _team_ctx, _vault_sync_enabled,
    _ASSET_NAME, _ASSET_MEDIA, _ASSET_TYPES, ASSET_MAX,
)

class NoteMetaIn(BaseModel):
    title: str
    tags: list = []
    folder: str = ""
    vault: str = ""

@router.get("/api/notes")
def list_notes(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    _ensure_pinned(username)
    _ensure_vaults(username)
    _gc_trash(username)
    return _merged_notes_payload(username)

@router.post("/api/notes")
def create_note(body: NoteMetaIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    note_id = uuid.uuid4().hex[:8]
    pinned = body.title in PINNED_TITLES
    folder = "" if pinned else (body.folder or "")
    if pinned or _is_builtin_folder(folder):
        vid, store = VAULT_SYSTEM, username
    else:
        vid = body.vault or _active_vault_id(username)
        ctx = _require_vault_edit(username, vid)
        store, vid = ctx["store"], ctx["vid"]
        if vid == VAULT_SYSTEM:
            raise HTTPException(400, "系统内置仓库只能在「每日计划」「灵感速记」中创建笔记")
    idx = storage.notes_index(store)
    idx.insert(0, {"id": note_id, "title": body.title or "未命名笔记",
                   "tags": body.tags,
                   "folder": folder,
                   "vault": vid,
                   "pinned": pinned,
                   "updated": int(time.time())})
    storage.save_notes_index(store, idx)
    storage.note_write(store, note_id, "")
    return idx[0]

class FolderIn(BaseModel):
    name: str
    vault: str = ""

@router.post("/api/notes/folders")
def add_folder(body: FolderIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    name = (body.name or "").strip().strip("/")
    if not name:
        raise HTTPException(400, "文件夹名称不能为空")
    if any(not seg.strip() for seg in name.split("/")):
        raise HTTPException(400, "文件夹路径不合法")
    vid = VAULT_SYSTEM if _is_builtin_folder(name) else (body.vault or _active_vault_id(username))
    if not _is_builtin_folder(name):
        ctx = _require_vault_edit(username, vid)
        store, vid = ctx["store"], ctx["vid"]
        if vid == VAULT_SYSTEM:
            raise HTTPException(400, "系统内置仓库只能使用内置文件夹")
    else:
        store = username
    folders = storage.user_json(store, "notes/folders.json", [])
    names = [f.get("name") if isinstance(f, dict) else str(f or "") for f in folders]
    data = _load_vaults(store)
    if name in names and _folder_claimed(data, name, vid):
        raise HTTPException(400, "文件夹已存在")
    # 多级路径：逐级补齐缺失的上级文件夹（A/B/C → A、A/B 依次存在）
    cur = ""
    fv = dict(data.get("folderVault") or {})
    for seg in name.split("/"):
        cur = seg if not cur else cur + "/" + seg
        if cur not in names:
            folders.append(cur)
            names.append(cur)
        _folder_claim(fv, cur, vid)
    storage.save_user_json(store, "notes/folders.json", folders)
    data["folderVault"] = fv
    _save_vaults(store, data)
    return {"ok": True, "name": name, "vault": vid}

class FoldersIn(BaseModel):
    folders: list = []

@router.put("/api/notes/folders")
def replace_folders(body: FoldersIn, authorization: Optional[str] = Header(None)):
    """整体保存文件夹列表（拖拽移动/排序后的新顺序），逐级补齐缺失父级并保留内置文件夹。"""
    username = require_user(authorization)
    seen, cleaned = set(), []
    for raw in body.folders:
        name = str(raw or "").strip().strip("/")
        if not name or name in seen:
            continue
        if any(not seg.strip() for seg in name.split("/")):
            continue
        seen.add(name)
        cleaned.append(name)
    out = []
    for name in cleaned:
        cur = ""
        for seg in name.split("/"):
            cur = seg if not cur else cur + "/" + seg
            if cur not in out:
                out.append(cur)
    if PLAN_FOLDER not in out:
        out.insert(0, PLAN_FOLDER)
    if QUICK_FOLDER not in out:
        out.append(QUICK_FOLDER)
    ctx = _require_vault_edit(username, _active_vault_id(username))
    store, vid = ctx["store"], ctx["vid"]
    if store == username:
        storage.save_user_json(username, "notes/folders.json", out)
        return {"ok": True, "folders": out}
    odata = _load_vaults(store)
    ofolders = storage.user_json(store, "notes/folders.json", [])
    keep = [f for f in ofolders if not _folder_claimed(odata, f, vid)]
    seen = set(keep)
    team_in = []
    for name in out:
        if name in (PLAN_FOLDER, QUICK_FOLDER):
            continue
        if name in seen:
            continue
        team_in.append(name)
        seen.add(name)
    final = keep + team_in
    if PLAN_FOLDER not in final:
        final.insert(0, PLAN_FOLDER)
    if QUICK_FOLDER not in final:
        final.append(QUICK_FOLDER)
    storage.save_user_json(store, "notes/folders.json", final)
    fv = dict(odata.get("folderVault") or {})
    for name in team_in:
        _folder_claim(fv, name, vid)
    odata["folderVault"] = fv
    _save_vaults(store, odata)
    return {"ok": True, "folders": final}

@router.delete("/api/notes/folders/{name:path}")
def delete_folder(name: str, authorization: Optional[str] = Header(None)):
    """删除文件夹：子树内所有笔记一并软删进回收站（可恢复），文件夹从列表移除（v0.2.25）。"""
    username = require_user(authorization)
    if name == PLAN_FOLDER:
        raise HTTPException(403, "「每日计划」为系统内置文件夹，不可删除")
    ctx = _require_vault_edit(username, _active_vault_id(username))
    store, vid = ctx["store"], ctx["vid"]
    folders = storage.user_json(store, "notes/folders.json", [])
    data = _load_vaults(store)
    if name not in folders or not _folder_claimed(data, name, vid):
        raise HTTPException(404, "文件夹不存在")
    prefix = name + "/"
    removed = {name} | {f for f in folders if f.startswith(prefix) and _folder_claimed(data, f, vid)}
    idx = storage.notes_index(store)
    now = int(time.time())
    trashed = 0
    for item in idx:
        f = item.get("folder") or ""
        # 只回收本仓库在该路径下的笔记，其它仓库同名文件夹不受影响
        if (f == name or f.startswith(prefix)) and _infer_note_vault(item) == vid:
            if not item.get("pinned"):
                item["deleted"] = now
                item["deleted_title"] = item.get("title") or ""
                trashed += 1
            else:
                item["folder"] = ""   # 常驻笔记不进回收站，归位根目录
    storage.save_notes_index(store, idx)
    fv = dict(data.get("folderVault") or {})
    for r in removed:
        _folder_unclaim(fv, r, vid)
    folders = [f for f in folders if f not in removed or fv.get(f) is not None]
    storage.save_user_json(store, "notes/folders.json", folders)
    data["folderVault"] = fv
    _save_vaults(store, data)
    return {"ok": True, "trashed": trashed}


@router.get("/api/notes/assets")
def list_assets(authorization: Optional[str] = Header(None)):
    """附件分区清单：.md 插图/上传的附件自动归档于此（随备份迁移）。"""
    username = require_user(authorization)
    out = []
    for name in storage.asset_list(username):
        if not _ASSET_NAME.match(name):
            continue
        raw = storage.asset_read(username, name)
        if raw is None:
            continue
        try:
            meta = json.loads(raw)
        except Exception:
            continue
        d = meta.get("d", "")
        pad = 2 if d.endswith("==") else (1 if d.endswith("=") else 0)
        out.append({"name": name, "type": meta.get("t", ""),
                    "size": len(d) * 3 // 4 - pad, "ts": meta.get("ts", 0)})
    out.sort(key=lambda a: a.get("ts") or 0, reverse=True)
    return {"assets": out}

@router.post("/api/notes/assets")
def upload_asset(file: UploadFile = File(...),
                 authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    data = file.file.read()
    if not data:
        raise HTTPException(400, "图片内容为空")
    if len(data) > ASSET_MAX:
        raise HTTPException(400, "图片过大（上限 5MB）")
    ext = _ASSET_TYPES.get((file.content_type or "").lower(), "")
    if not ext:
        ext = Path(file.filename or "").suffix.lower()
        if ext == ".jpeg":
            ext = ".jpg"
    if ext not in _ASSET_MEDIA:
        raise HTTPException(400, "仅支持 png/jpg/gif/webp/svg 图片")
    # 保留原文件名便于附件分区辨识，短随机后缀防重名
    stem = re.sub(r"[^\w\u4e00-\u9fff-]", "_", Path(file.filename or "").stem)[:24]
    name = (stem or uuid.uuid4().hex[:8]) + "-" + uuid.uuid4().hex[:6] + ext
    payload = json.dumps({"t": _ASSET_MEDIA[ext],
                          "d": base64.b64encode(data).decode(),
                          "ts": int(time.time())})
    storage.asset_write(username, name, payload)
    return {"name": name, "url": "/api/notes/assets/" + name}

@router.get("/api/notes/assets/{name}")
def get_asset(name: str, authorization: Optional[str] = Header(None),
              token: Optional[str] = None):
    username = require_user(authorization, token)
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
                    headers={"Cache-Control": "public, max-age=86400"})

@router.delete("/api/notes/assets/{name}")
def delete_asset(name: str, authorization: Optional[str] = Header(None),
                 token: Optional[str] = None):
    """删除附件。引用该附件的笔记中的 markdown 图片链接会自然变裂图，删除前请确认。"""
    username = require_user(authorization, token)
    if not _ASSET_NAME.match(name):
        raise HTTPException(400, "非法附件名")
    if storage.asset_read(username, name) is None:
        raise HTTPException(404, "附件不存在")
    storage.asset_delete(username, name)
    return {"ok": True}

import io as _io
import zipfile as _zipfile

_JUNK_BASENAMES = {".DS_Store", "Thumbs.db", "desktop.ini", "._.trashes"}

@router.get("/api/notes/folder/export")
def export_folder_notes(path: str = "", authorization: Optional[str] = Header(None),
                        token: Optional[str] = None):
    """指定文件夹（含全部子文件夹）的笔记打包 zip；目录结构相对于所选文件夹。
    供文件夹 ⋯ 菜单「导出文件夹」使用（<a> 下载，支持 token 查询参数）。"""
    from urllib.parse import quote as _quote
    username = require_user(authorization, token)
    path = (path or "").strip().strip("/")
    if not path:
        raise HTTPException(400, "文件夹路径不能为空")
    idx = storage.notes_index(username)
    prefix = path + "/"
    picked = [m for m in idx
              if not m.get("pinned") and (m.get("folder") == path or (m.get("folder") or "").startswith(prefix))]
    if not picked:
        raise HTTPException(404, "该文件夹下没有笔记")
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        used = set()
        for m in picked:
            folder = (m.get("folder") or "").strip("/")
            rel = folder[len(path):].strip("/")            # 相对所选文件夹的子路径
            parts = [_safe_fs_name(p) for p in rel.split("/") if p] if rel else []
            arc = "/".join(parts + [_safe_fs_name(m.get("title") or m["id"]) + ".md"]) if parts \
                else (_safe_fs_name(m.get("title") or m["id"]) + ".md")
            base = arc; n = 2
            while arc in used:
                stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                arc = (f"{stem}-{n}.{ext}" if ext else f"{base}-{n}")
                n += 1
            used.add(arc)
            content = storage.note_read(username, m["id"]) or ""
            zf.writestr(arc, _note_to_md(m, content))
    buf.seek(0)
    fname = _safe_fs_name(path.rsplit("/", 1)[-1]) + ".zip"
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "folder.zip"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )

@router.get("/api/notes/{nid}/export")
def export_note_md(nid: str, authorization: Optional[str] = Header(None),
                   token: Optional[str] = None):
    """单条笔记下载为 .md 文件；含 Content-Disposition 触发浏览器另存。
    浏览器 <a> 下载带不了 Authorization 头，必须支持 token 查询参数（否则 401 变 JSON 下载）。"""
    from urllib.parse import quote as _quote
    username = require_user(authorization, token)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    meta = next((m for m in idx if m["id"] == nid), None)
    if not meta:
        raise HTTPException(404, "笔记不存在")
    content = storage.note_read(username, nid) or ""
    data = _note_to_md(meta, content)
    fname = _safe_fs_name(meta.get("title") or nid) + ".md"
    # 双形式 filename：ASCII 兜底 + RFC 5987 UTF-8（中文/空格都能正确解析）
    ascii_fname = fname.encode("ascii", errors="replace").decode("ascii") or "note.md"
    utf8_fname = _quote(fname, safe="")
    return Response(
        content=data,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition":
                 f"attachment; filename=\"{ascii_fname}\"; filename*=UTF-8''{utf8_fname}",
                 "X-Content-Type-Options": "nosniff"},
    )

@router.get("/api/notes/all")
def export_all_notes(authorization: Optional[str] = Header(None),
                     token: Optional[str] = None):
    """全部笔记打包为 zip：按 folder 还原目录结构，文件名 = 标题.md。同样支持 token 查询参数供 <a> 下载。"""
    username = require_user(authorization, token)
    idx = storage.notes_index(username)
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        used = set()                                     # 防路径冲突
        for m in idx:
            if m.get("pinned") and not m.get("folder"):
                # 固定笔记（无文件夹）放根
                arc = _safe_fs_name(m.get("title") or m["id"]) + ".md"
            else:
                folder = (m.get("folder") or "").strip("/")
                parts = [_safe_fs_name(p) for p in folder.split("/") if p] if folder else []
                arc = ("/".join(parts + [_safe_fs_name(m.get("title") or m["id"]) + ".md"])) if parts \
                    else (_safe_fs_name(m.get("title") or m["id"]) + ".md")
            # 同名冲突时加短后缀
            base = arc; n = 2
            while arc in used:
                stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                arc = (f"{stem}-{n}.{ext}" if ext else f"{base}-{n}")
                n += 1
            used.add(arc)
            content = storage.note_read(username, m["id"]) or ""
            zf.writestr(arc, _note_to_md(m, content))
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="omnihome-notes.zip"',
                 "X-Content-Type-Options": "nosniff"},
    )

@router.post("/api/notes/import-md")
async def import_md(file: UploadFile = File(...),
                   authorization: Optional[str] = Header(None)):
    """导入 Markdown：
       - 单个 .md 文件 → 在「我的笔记」根目录创建一篇笔记
       - .zip 文件 → 按 zip 内的目录结构还原文件夹，逐级补齐，标题取自文件名"""
    import zipfile as _zf
    username = require_user(authorization)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    name = (file.filename or "").lower()
    # ---- 单文件 ----
    if name.endswith(".md") or file.content_type in ("text/markdown", "text/x-markdown"):
        title, content = _parse_md(raw, file.filename or "未命名笔记.md")
        return _create_imported_note(username, title, content, "")
    # ---- zip ----
    if not (name.endswith(".zip") or file.content_type in ("application/zip", "application/x-zip-compressed")):
        raise HTTPException(400, "仅支持 .md 或 .zip")
    try:
        zf = _zf.ZipFile(_io.BytesIO(raw))
        names = zf.namelist()
    except Exception as e:
        raise HTTPException(400, f"zip 解析失败：{e}")
    # 防 Zip Slip
    for n in names:
        if n.startswith("/") or ".." in n.replace("\\", "/").split("/"):
            raise HTTPException(400, f"非法路径：{n}")
    created, skipped = 0, 0
    for n in names:
        if n.endswith("/"):
            continue                                       # 目录条目
        if not n.lower().endswith(".md"):
            skipped += 1
            continue
        if _is_junk_path(n):
            # macOS 资源垃圾（._xxx、__MACOSX/…）和 Windows 缩略图——过滤掉
            skipped += 1
            continue
        path = n.replace("\\", "/").strip("/")
        # 关键：根目录下的 .md 文件（无 /）应视为 folder="" 而不是把整段路径当文件夹
        if "/" in path:
            folder, fname = path.rsplit("/", 1)
        else:
            folder, fname = "", path
        # 还原嵌套文件夹（顺序补齐父级）
        for depth in range(1, folder.count("/") + 2):
            sub = "/".join(folder.split("/")[:depth])
            if sub:
                _ensure_folder(username, sub)
        raw_md = zf.read(n)
        title, content = _parse_md(raw_md, fname)
        _create_imported_note(username, title, content, folder)
        created += 1
    return {"ok": True, "imported": created, "skipped": skipped}

class ImportedFilesIn(BaseModel):
    """前端拖拽 .md 文件 / 文件夹：每条带相对路径（如 '项目规划/前端/笔记.md'）。"""
    files: list = []              # [{path, content}, ...]

@router.post("/api/notes/import-files")
def import_files(body: ImportedFilesIn, authorization: Optional[str] = Header(None)):
    """从前端拖拽目录 / 多文件批量导入：path 视为 zip 内的相对路径，逐级补齐父文件夹。"""
    username = require_user(authorization)
    created, skipped = 0, 0
    for item in (body.files or []):
        path = (item.get("path") if isinstance(item, dict) else None) or ""
        content = (item.get("content") if isinstance(item, dict) else None) or ""
        if not path.lower().endswith(".md"):
            skipped += 1; continue
        if _is_junk_path(path):
            skipped += 1; continue
        norm = path.replace("\\", "/").strip("/")
        if not norm:
            skipped += 1; continue
        if "/" in norm:
            folder, fname = norm.rsplit("/", 1)
        else:
            folder, fname = "", norm
        for depth in range(1, folder.count("/") + 2):
            sub = "/".join(folder.split("/")[:depth])
            if sub:
                _ensure_folder(username, sub)
        raw_bytes = content.encode("utf-8") if isinstance(content, str) else content
        title, body_md = _parse_md(raw_bytes, fname)
        _create_imported_note(username, title, body_md, folder)
        created += 1
    return {"ok": True, "imported": created, "skipped": skipped}

@router.post("/api/notes/cleanup-junk")
def cleanup_junk_notes(authorization: Optional[str] = Header(None)):
    """清理 macOS zip 资源垃圾：标题以 ._ 开头的笔记、__MACOSX 文件夹（含嵌套）及其内笔记。
       一键修复 v0.2.6 之前没过滤导入导致的整树乱码。"""
    username = require_user(authorization)
    idx = storage.notes_index(username)
    folders = storage.user_json(username, "notes/folders.json", [])

    # 1. 找出垃圾文件夹（含嵌套）
    junk_folders = {f for f in folders if _is_junk_path(f)}
    kept_folders = [f for f in folders if f not in junk_folders]

    # 2. 笔记：标题 ._ 开头 / 在垃圾文件夹内 → 都删
    kept_notes = []
    deleted_notes = 0
    for n in idx:
        title_junk = n.get("title", "").startswith("._") or _is_junk_path(n.get("title", ""))
        in_junk_folder = n.get("folder", "") in junk_folders
        if title_junk or in_junk_folder:
            try:
                storage.note_delete(username, n["id"])
            except Exception:
                pass
            deleted_notes += 1
        else:
            kept_notes.append(n)

    storage.save_notes_index(username, kept_notes)
    storage.save_user_json(username, "notes/folders.json", kept_folders)

    return {"ok": True, "deleted_notes": deleted_notes,
            "deleted_folders": len(folders) - len(kept_folders)}

@router.get("/api/notes/trash")
def list_trash(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    _gc_trash(username)
    idx = storage.notes_index(username)
    items = [n for n in idx if n.get("deleted")]
    items.sort(key=lambda x: x.get("deleted") or 0, reverse=True)
    return {"notes": items, "vaults": _load_vaults(username)["items"],
            "trashDays": int((storage.get_prefs(username) or {}).get("trashDays", 30) or 0)}

@router.delete("/api/notes/trash/{nid}")
def trash_purge_one(nid: str, authorization: Optional[str] = Header(None)):
    """永久删除一篇回收站笔记（连 .md 文件一并清除，无法恢复）。"""
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    hit = next((i for i in idx if i["id"] == nid), None)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    storage.note_delete(username, nid)
    idx[:] = [i for i in idx if i["id"] != nid]
    storage.save_notes_index(username, idx)
    return {"ok": True}

@router.post("/api/notes/trash/purge-all")
def trash_purge_all(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    idx = storage.notes_index(username)
    purged = 0
    alive = []
    for n in idx:
        if n.get("deleted"):
            try: storage.note_delete(username, n["id"])
            except Exception: pass
            purged += 1
        else:
            alive.append(n)
    storage.save_notes_index(username, alive)
    return {"ok": True, "purged": purged}

@router.post("/api/notes/{nid}/restore")
def restore_note(nid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    idx = storage.notes_index(username)
    hit = next((i for i in idx if i["id"] == nid), None)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    if not hit.get("deleted"):
        return {"ok": True, "restored": False}
    hit.pop("deleted", None)
    hit.pop("deleted_title", None)
    hit["updated"] = int(time.time())
    # 原文件夹可能已随删除一起移除：恢复时自动补注册，否则笔记在目录树不可见
    fp = (hit.get("folder") or "").strip("/")
    if fp:
        folders = storage.user_json(username, "notes/folders.json", [])
        if fp not in folders:
            cur = ""
            for seg in fp.split("/"):
                cur = seg if not cur else cur + "/" + seg
                if cur not in folders:
                    folders.append(cur)
            storage.save_user_json(username, "notes/folders.json", folders)
    storage.save_notes_index(username, idx)
    return {"ok": True, "restored": True}

@router.get("/api/notes/{nid}")
def get_note(nid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, _idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    return {"id": nid, "content": storage.note_read(store, nid),
            "title": hit.get("title") or "", "folder": hit.get("folder") or "",
            "updated": int(hit.get("updated") or 0),
            "readonly": bool(hit.get("readonly")),
            "vault": _infer_note_vault(hit)}

class NoteContentIn(BaseModel):
    content: Optional[str] = None
    title: Optional[str] = None
    tags: Optional[list] = None
    folder: Optional[str] = None
    vault: Optional[str] = None
    readonly: Optional[bool] = None

@router.put("/api/notes/{nid}")
def save_note(nid: str, body: NoteContentIn,
              authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    _require_vault_edit(username, _infer_note_vault(hit))
    if body.content is not None:
        old = storage.note_read(store, nid, "")
        if old != body.content:
            storage.note_rev_snapshot(store, nid, old, hit.get("title") or "", "web")
        storage.note_write(store, nid, body.content)
    for item in idx:
        if item["id"] == nid:
            item["updated"] = int(time.time())
            if body.title is not None:
                item["title"] = body.title
                if body.title in PINNED_TITLES:
                    item["pinned"] = True
                    item["folder"] = ""
                    item["vault"] = VAULT_SYSTEM
            if body.tags is not None:
                item["tags"] = body.tags
            if body.folder is not None and not item.get("pinned"):
                item["folder"] = body.folder
            if body.vault is not None and not item.get("pinned"):
                if body.vault == VAULT_SYSTEM:
                    raise HTTPException(400, "不能把普通笔记移入系统内置仓库")
                ctx = _require_vault_edit(username, body.vault)
                item["vault"] = ctx["vid"]
            if body.readonly is not None:
                item["readonly"] = bool(body.readonly)
    idx.sort(key=lambda x: x["updated"], reverse=True)
    storage.save_notes_index(store, idx)
    return {"ok": True}

@router.delete("/api/notes/{nid}")
def delete_note(nid: str, authorization: Optional[str] = Header(None)):
    """v0.2.15 改为软删除：常驻笔记保持原行为（直接删除，会被 _ensure_pinned 重建），
       用户笔记进回收站（设 deleted 时间戳，不动 .md 文件），可在设置/侧栏恢复或永久删。"""
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    _require_vault_edit(username, _infer_note_vault(hit))
    if hit.get("pinned"):
        storage.note_delete(store, nid)
        idx[:] = [i for i in idx if i["id"] != nid]
        storage.save_notes_index(store, idx)
        return {"ok": True, "softDeleted": False}
    hit["deleted"] = int(time.time())
    hit["deleted_title"] = hit.get("title") or ""
    storage.save_notes_index(store, idx)
    return {"ok": True, "softDeleted": True}

@router.get("/api/notes/{nid}/revisions")
def note_revisions_list(nid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, _idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    return {"ok": True, "id": nid, "revisions": storage.note_revs_meta(store, nid)}

@router.get("/api/notes/{nid}/revisions/{rev}")
def note_revision_get(nid: str, rev: int,
                      authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, _idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    rec = storage.note_rev_get(store, nid, rev)
    if not rec:
        raise HTTPException(404, "该版本不存在")
    current = storage.note_read(store, nid, "")
    return {"ok": True, "id": nid, "current": current,
            "rev": rec.get("rev"), "ts": rec.get("ts"),
            "source": rec.get("source") or "web",
            "title": rec.get("title") or "",
            "content": rec.get("content") or ""}

@router.post("/api/notes/{nid}/revisions/{rev}/restore")
def note_revision_restore(nid: str, rev: int,
                          authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    if not storage.note_key(username, nid):
        raise HTTPException(400, "非法笔记 ID")
    store, hit, idx = _find_note(username, nid)
    if not hit:
        raise HTTPException(404, "笔记不存在")
    _require_vault_edit(username, _infer_note_vault(hit))
    rec = storage.note_rev_get(store, nid, rev)
    if not rec:
        raise HTTPException(404, "该版本不存在")
    cur = storage.note_read(store, nid, "")
    body = rec.get("content") or ""
    if cur != body:
        storage.note_rev_snapshot(store, nid, cur, hit.get("title") or "", "web",
                                  force=True)
        storage.note_write(store, nid, body)
    now = int(time.time())
    for item in idx:
        if item["id"] == nid:
            item["updated"] = now
            break
    idx.sort(key=lambda x: x["updated"], reverse=True)
    storage.save_notes_index(store, idx)
    return {"ok": True, "id": nid, "rev": rec.get("rev"), "content": body,
            "updated": now}

