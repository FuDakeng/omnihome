"""万事屋 · Obsidian 同步"""
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
    VAULT_DEFAULT, VAULT_SYSTEM,
    require_sync_user, require_sync_ctx, _sync_require_member_edit,
    _guard_sync_put, _guard_sync_delete, _validate_sync_path, _split_sync_path,
    _resolve_sync_path, _sync_path_index, _note_to_path, _in_sync_scope,
    _ensure_folder, _parse_md, _note_to_md, _gc_trash, _vault_by_id,
    _vault_sync_enabled, _require_vault_edit, _clip_sync, _diff_summary,
    _log_vault_note, _sync_apply_note, _safe_fs_name,
    _load_vaults, _save_vaults, _active_vault_id, _team_ctx, _ensure_vaults,
    _ASSET_NAME, _ASSET_MEDIA, ASSET_MAX,
)

_SYNC_BUILTIN_ROOTS = ("每日计划", "灵感速记")   # 内置文件夹，不参与同步

class SyncKeyIn(BaseModel):
    vault: str = ""

@router.post("/api/sync/apikey")
def sync_apikey_create(body: Optional[SyncKeyIn] = Body(default=None),
                       vault: str = Query(""),
                       authorization: Optional[str] = Header(None)):
    """生成 / 重置指定仓库的同步 API Key；明文仅此一次返回。系统内置仓库禁止。
    仓库 ID 同时接受 JSON body 与 ?vault= 查询参数（查询优先于空 body 默认值），
    避免 body 丢失时误签发到默认仓库。"""
    username = require_user(authorization)
    raw_vid = ((body.vault if body else "") or vault or "").strip() or VAULT_DEFAULT
    tctx = _team_ctx(username, raw_vid)
    vid = tctx["vid"]
    if tctx["rec"].get("kind") == "system" or vid == VAULT_SYSTEM:
        raise HTTPException(400, "系统内置仓库不可创建同步令牌")
    if tctx["is_owner"]:
        if not _vault_sync_enabled(username, vid):
            raise HTTPException(403, "请先开启此仓库的 Obsidian 同步")
        store, actor = username, username
    else:
        if not tctx["can_edit"]:
            raise HTTPException(403, "只读成员不能同步此团队仓库")
        if not _vault_sync_enabled(tctx["store"], vid):
            raise HTTPException(403, "创建人尚未开启此仓库的 Obsidian 同步")
        store, actor = tctx["store"], username
    try:
        raw = storage.gen_sync_key(store, vid, actor=actor)
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_sync_log(store, {"vault": vid, "source": "web",
                                    "msg": "生成 / 重置同步令牌" + (("（成员 " + actor + "）") if actor != store else "")})
    vname = (tctx["rec"] or {}).get("name") or ""
    return {"ok": True, "apiKey": raw, "vault": vid, "vaultName": vname,
            "prefix": raw[:12]}

@router.get("/api/sync/apikey")
def sync_apikey_info(vault: str = VAULT_DEFAULT,
                     authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    info = storage.sync_key_info(username, vault or VAULT_DEFAULT)
    info["keys"] = storage.list_sync_keys(username)
    info["vaultSync"] = _vault_sync_enabled(username, vault or VAULT_DEFAULT)
    info["obsidianSync"] = info["vaultSync"]
    return info

@router.delete("/api/sync/apikey")
def sync_apikey_revoke(vault: str = "",
                       authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    vid = vault or None
    # 只吊销当前登录用户自己持有的钥，不波及团队仓其他成员
    storage.revoke_sync_key(username, vid, actor=username)
    storage.append_sync_log(username, {"vault": vault or "", "source": "web",
                                    "msg": "吊销同步令牌" + (("（" + vault + "）") if vault else "（全部）")})
    return {"ok": True}

class SyncVaultEnabledIn(BaseModel):
    vault: str = ""
    enabled: bool = False

@router.put("/api/sync/enabled")
def sync_vault_set_enabled(body: SyncVaultEnabledIn,
                           authorization: Optional[str] = Header(None)):
    """按笔记仓库独立开关同步。关闭后令牌立即失效但不吊销，重开后可继续使用。"""
    username = require_user(authorization)
    tctx = _team_ctx(username, body.vault)
    vid = tctx["vid"]
    rec = tctx["rec"] or {}
    if rec.get("kind") == "system" or vid == VAULT_SYSTEM:
        raise HTTPException(400, "系统内置仓库不可开启同步")
    if not tctx["is_owner"]:
        raise HTTPException(403, "仅创建人可开关此仓库的同步")
    data = _ensure_vaults(tctx["store"])
    hit = next((x for x in data["items"] if x["id"] == vid), None)
    if not hit:
        raise HTTPException(404, "笔记仓库不存在")
    hit["syncEnabled"] = bool(body.enabled)
    _save_vaults(tctx["store"], data)
    return {"ok": True, "vault": vid, "enabled": bool(hit["syncEnabled"])}

@router.get("/api/sync/hello")
def sync_hello(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """插件握手：返回万事屋版本、绑定仓库名，并记录一次连接日志。"""
    import app_version
    ctx = require_sync_ctx(x_api_key)
    username, vault_id = ctx["u"], ctx["vault"]
    vmeta = _vault_by_id(username, vault_id) or {}
    actor = ctx.get("actor") or ctx["u"]
    return {"ok": True, "name": "万事屋", "version": app_version.VERSION,
            "stage": app_version.STAGE, "vault": vault_id,
            "vaultName": vmeta.get("name") or "", "pluginMin": "0.0.6",
            "isOwner": actor == username}

@router.get("/api/sync/log")
def sync_log_get(vault: str = "", limit: int = 80,
                 authorization: Optional[str] = Header(None),
                 x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    if x_api_key:
        ctx = require_sync_ctx(x_api_key)
        username, vid = ctx["u"], (vault or ctx["vault"])
    else:
        username = require_user(authorization)
        vid = vault or ""
        if vid:
            try:
                tctx = _team_ctx(username, vid)
                username, vid = tctx["store"], tctx["vid"]
            except HTTPException:
                pass
    return {"logs": storage.read_sync_log(username, vid or None, limit)}

class SyncLogIn(BaseModel):
    msg: str = ""
    level: str = "info"
    vault: str = ""
    kind: str = ""
    title: str = ""
    summary: str = ""
    path: str = ""
    fromEnd: str = ""
    toEnd: str = ""

@router.post("/api/sync/log")
def sync_log_post(body: SyncLogIn,
                  x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    ctx = require_sync_ctx(x_api_key)
    storage.append_sync_log(ctx["u"], {
        "vault": body.vault or ctx["vault"], "source": "obsidian",
        "level": body.level or "info", "msg": body.msg,
        "kind": body.kind, "title": body.title, "summary": body.summary,
        "path": body.path,
        "from": body.fromEnd, "to": body.toEnd,
    })
    return {"ok": True}

@router.get("/api/inbox")
def inbox_list(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    items = teams.inbox_list(username)
    return {"items": items, "unread": sum(1 for x in items if not x.get("read"))}

class InboxPatchIn(BaseModel):
    read: Optional[bool] = None
    action: Optional[str] = None

@router.put("/api/inbox/{iid}")
def inbox_patch(iid: str, body: InboxPatchIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    rec = teams.inbox_get(username, iid)
    if not rec:
        raise HTTPException(404, "通知不存在")
    if body.read is not None:
        rec = teams.inbox_patch(username, iid, read=bool(body.read))
    if body.action in ("approve", "deny") and rec.get("type") == "sync-approval":
        try:
            teams.approval_decide(username, rec.get("ref") or "", body.action == "approve")
        except PermissionError:
            raise HTTPException(403, "无权审批")
        rec = teams.inbox_patch(username, iid, read=True,
                                action=body.action)
    return {"ok": True, "item": rec}

class SyncApprovalIn(BaseModel):
    kind: str = ""
    vault: str = ""
    paths: list = []

@router.post("/api/sync/approvals")
def sync_approval_create(body: SyncApprovalIn,
                         x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    ctx = require_sync_ctx(x_api_key)
    _sync_require_member_edit(ctx)
    actor = ctx.get("actor") or ctx["u"]
    owner = ctx["u"]
    vid = body.vault or ctx["vault"]
    if actor == owner:
        return {"ok": True, "pending": False, "skipped": True, "reason": "owner"}
    rec = _vault_by_id(owner, vid)
    if not rec or rec.get("kind") != "team":
        return {"ok": True, "pending": False, "skipped": True, "reason": "not-team"}
    kind = (body.kind or "").strip()
    if kind not in ("bulk-delete", "overwrite"):
        raise HTTPException(400, "审批类型无效")
    rec = teams.approval_create(owner, actor, vid, kind, body.paths or [])
    return {"ok": True, "pending": True, "id": rec["id"], "status": "pending"}

@router.get("/api/sync/approvals/{aid}")
def sync_approval_get(aid: str,
                      x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
                      authorization: Optional[str] = Header(None)):
    rec = teams.approval_get(aid)
    if not rec:
        raise HTTPException(404, "审批不存在")
    if x_api_key:
        ctx = require_sync_ctx(x_api_key)
        actor = ctx.get("actor") or ctx["u"]
        if actor not in (rec.get("actor"), rec.get("owner")):
            raise HTTPException(403, "无权查看")
    else:
        username = require_user(authorization)
        if username not in (rec.get("actor"), rec.get("owner")):
            raise HTTPException(403, "无权查看")
    return {"ok": True, "id": rec["id"], "status": rec.get("status"),
            "kind": rec.get("kind"), "ticket": rec.get("ticket") or "",
            "ticketExpires": int(rec.get("ticketExpires") or 0)}

@router.get("/api/sync/list")
def sync_list(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """递归列出同步范围内的全部笔记：[{path, mtime}]。
    mtime = note.updated * 1000（毫秒），供客户端 LWW 对账。
    刻意不返回 size：本接口被客户端每 5-10s 轮询，读全部正文会压垮数据库；
    size 属信息性字段，可由 GET /api/sync/file 的 content 长度得出。"""
    ctx = require_sync_ctx(x_api_key)
    username, vault_id = ctx["u"], ctx["vault"]
    by_path, _ = _sync_path_index(username, vault_id)
    files = [{"path": p, "mtime": int(m.get("updated") or 0) * 1000}
             for p, m in by_path.items()]
    vmeta = _vault_by_id(username, vault_id) or {}
    return {"files": files, "vault": vault_id, "vaultName": vmeta.get("name") or ""}

@router.get("/api/sync/file")
def sync_get_file(path: str, x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """按相对路径读取单篇笔记的完整 Markdown（标题作 H1，与浏览器端 noteToMd 一致）。"""
    ctx = require_sync_ctx(x_api_key)
    username, vault_id = ctx["u"], ctx["vault"]
    norm = _validate_sync_path(path)
    meta = _resolve_sync_path(username, norm, vault_id)
    if not meta:
        raise HTTPException(404, "文件不存在")
    content = storage.note_read(username, meta["id"], "")
    md = _note_to_md(meta, content)          # .md 字节（标题 H1 + 正文）
    # 正文以 base64 下发：明文里的 <script>/<svg>/<?xml 等会被中间内容安全网关/WAF
    # 当成 XSS 特征篡改（甚至 hex 化）响应体，令客户端 JSON 解析崩坏；base64 使其不透明。
    return {"path": norm, "contentB64": base64.b64encode(md).decode("ascii"),
            "mtime": int(meta.get("updated") or 0) * 1000}

class SyncFileIn(BaseModel):
    path: str
    content: str = ""                    # 旧客户端明文正文（回退用）
    contentB64: Optional[str] = None     # 新客户端 base64 正文（优先；规避中间网关/WAF 篡改）
    clientMtime: Optional[int] = None    # 客户端本地文件 mtime（毫秒），用于 LWW
    knownRemoteMtime: Optional[int] = None  # 客户端上次同步时记下的站点 mtime；未变则连续本地保存应落地

@router.post("/api/sync/file")
def sync_put_file(body: SyncFileIn,
                  x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
                  x_sync_approval: Optional[str] = Header(None, alias="X-Sync-Approval")):
    """写入 / 更新一篇笔记。命中现有 path 则按 LWW 决定是否覆盖；未命中则新建。
    LWW（2 秒内站点优先）：仅当客户端文件明显更新（clientMtime > 站点 mtime + 2000）
    才覆盖站点；否则站点胜，拒绝覆盖（applied=False）并返回站点 mtime，客户端应改拉取。
    例外：若客户端带上 knownRemoteMtime 且站点 mtime 未超过该值，说明服务端自上次同步后
    并无独立变更（常见于 Obsidian 连续按键保存），连续本地推送直接落地，避免回拉旧正文。"""
    ctx = require_sync_ctx(x_api_key)
    username, vault_id = ctx["u"], ctx["vault"]
    client_mtime = int(body.clientMtime or 0)
    _guard_sync_put(ctx, client_mtime, x_sync_approval)
    norm = _validate_sync_path(body.path)
    folder, fname = _split_sync_path(norm)
    # 正文优先取 contentB64（base64 传输规避中间网关对 <script>/<svg> 等特征的篡改），
    # 回退明文 content（兼容旧客户端）。
    if body.contentB64:
        try:
            text = base64.b64decode(body.contentB64).decode("utf-8", "replace")
        except Exception:
            raise HTTPException(400, "contentB64 不是合法的 base64")
    else:
        text = body.content
    title, body_md = _parse_md(text.encode("utf-8"), fname)
    meta = _resolve_sync_path(username, norm, vault_id)
    client_mtime = int(body.clientMtime or 0)
    known_rm = int(body.knownRemoteMtime or 0)

    if meta:
        site_mtime = int(meta.get("updated") or 0) * 1000
        site_unchanged = known_rm > 0 and site_mtime <= known_rm
        if (not site_unchanged) and client_mtime <= site_mtime + 2000:
            return {"path": norm, "mtime": site_mtime, "id": meta["id"],
                    "applied": False, "reason": "site-wins"}
        out = _sync_apply_note(username, meta["id"], folder, title, body_md,
                               site_mtime, norm, vault_id)
        if out.get("applied") and not out.get("unchanged"):
            _log_vault_note(username, vault_id, kind="edit",
                            title=out.get("title") or title or fname,
                            summary=out.get("summary") or "内容已更新", path=norm)
        return out

    # 未命中 -> 新建（先逐级补齐文件夹，否则笔记在目录树中不可见）
    if folder:
        _ensure_folder(username, folder, vault_id)
    nid = uuid.uuid4().hex[:8]
    now = int(time.time())
    stem = fname[:-3] if fname.lower().endswith(".md") else fname
    note_title = title or stem or "未命名笔记"
    idx = storage.notes_index(username)
    idx.insert(0, {"id": nid, "title": note_title,
                   "tags": [], "folder": folder, "vault": vault_id,
                   "pinned": False, "updated": now})
    storage.save_notes_index(username, idx)
    storage.note_write(username, nid, body_md)
    first = (body_md or "").strip().splitlines()
    snippet = _clip_sync(first[0] if first else "空白笔记", 48)
    _log_vault_note(username, vault_id, kind="add", title=note_title,
                    summary="新建笔记，开头「%s」" % snippet, path=norm)
    return {"path": norm, "mtime": now * 1000, "id": nid, "applied": True}

class SyncRenameIn(BaseModel):
    oldPath: str
    newPath: str

@router.put("/api/sync/file/rename")
def sync_rename_file(body: SyncRenameIn,
                     x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """重命名 / 移动一篇笔记：按 newPath 更新其 folder 与 title（正文不变）。"""
    ctx = require_sync_ctx(x_api_key)
    _sync_require_member_edit(ctx)
    username, vault_id = ctx["u"], ctx["vault"]
    old = _validate_sync_path(body.oldPath)
    new = _validate_sync_path(body.newPath)
    meta = _resolve_sync_path(username, old, vault_id)
    if not meta:
        raise HTTPException(404, "源文件不存在")
    new_folder, new_fname = _split_sync_path(new)
    if new_folder:
        _ensure_folder(username, new_folder, vault_id)
    new_title = new_fname[:-3] if new_fname.lower().endswith(".md") else new_fname
    idx = storage.notes_index(username)
    now = int(time.time())
    for it in idx:
        if it.get("id") == meta["id"]:
            it["folder"] = new_folder
            it["title"] = new_title or it.get("title") or "未命名笔记"
            it["updated"] = now
            break
    storage.save_notes_index(username, idx)
    _log_vault_note(username, vault_id, kind="edit",
                    title=new_title or (meta.get("title") or ""),
                    summary="路径「%s」→「%s」" % (_clip_sync(old, 36), _clip_sync(new, 36)),
                    path=new)
    return {"ok": True, "path": new, "id": meta["id"], "mtime": now * 1000}

@router.delete("/api/sync/file")
def sync_delete_file(path: str,
                     x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
                     x_sync_approval: Optional[str] = Header(None, alias="X-Sync-Approval")):
    """删除一篇笔记：软删进回收站（与 Web 端删除一致，可在门户恢复），不物理删正文。"""
    ctx = require_sync_ctx(x_api_key)
    username, vault_id = ctx["u"], ctx["vault"]
    norm = _validate_sync_path(path)
    _guard_sync_delete(ctx, norm, x_sync_approval)
    meta = _resolve_sync_path(username, norm, vault_id)
    if not meta:
        raise HTTPException(404, "文件不存在")
    idx = storage.notes_index(username)
    now = int(time.time())
    for it in idx:
        if it.get("id") == meta["id"]:
            it["deleted"] = now
            it["deleted_title"] = it.get("title") or ""
            break
    storage.save_notes_index(username, idx)
    _log_vault_note(username, vault_id, kind="delete",
                    title=(meta.get("title") or Path(norm).stem or "未命名笔记"),
                    summary="删除笔记「%s」" % _clip_sync(meta.get("title") or norm, 48),
                    path=norm)
    return {"ok": True, "softDeleted": True}

def _validate_sync_asset_name(name: str) -> str:
    raw = (name or "").replace("\\", "/").strip()
    if not raw or "/" in raw or raw.startswith(".") or ".." in raw:
        raise HTTPException(400, "非法附件名")
    if not _ASSET_NAME.match(raw):
        raise HTTPException(400, "不支持的附件类型")
    return raw

def _asset_payload_meta(raw):
    try:
        meta = json.loads(raw)
        d = meta.get("d", "")
        pad = 2 if d.endswith("==") else (1 if d.endswith("=") else 0)
        size = len(d) * 3 // 4 - pad
        return meta, size
    except Exception:
        return None, 0

def _sync_asset_stored_name(filename: str, data: bytes) -> str:
    ext = Path(filename or "").suffix.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    if ext not in _ASSET_MEDIA:
        raise HTTPException(400, "仅支持 png/jpg/gif/webp/svg/pdf/mp3/mp4/webm/wav/zip")
    stem = re.sub(r"[^\w\u4e00-\u9fff-]", "_", Path(filename or "").stem)[:24]
    digest = hashlib.sha256(data).hexdigest()[:6]
    return (stem or "file") + "-" + digest + ext

class SyncAssetIn(BaseModel):
    filename: str
    dataB64: str
    mime: Optional[str] = None

@router.get("/api/sync/assets")
def sync_list_assets(x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """列出当前用户全部可同步附件（供客户端补齐引用文件）。"""
    username = require_sync_user(x_api_key)
    out = []
    for name in storage.asset_list(username):
        if not _ASSET_NAME.match(name):
            continue
        raw = storage.asset_read(username, name)
        if raw is None:
            continue
        meta, size = _asset_payload_meta(raw)
        if not meta:
            continue
        out.append({"name": name, "type": meta.get("t", ""),
                    "size": size, "mtime": int(meta.get("ts") or 0) * 1000})
    return {"assets": out}

@router.get("/api/sync/asset")
def sync_get_asset(name: str, x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """按附件名读取二进制（base64），供 Obsidian 落成本地文件。"""
    username = require_sync_user(x_api_key)
    name = _validate_sync_asset_name(name)
    raw = storage.asset_read(username, name)
    if raw is None:
        raise HTTPException(404, "附件不存在")
    meta, _size = _asset_payload_meta(raw)
    if not meta or "d" not in meta:
        raise HTTPException(500, "附件数据损坏")
    return {"name": name, "dataB64": meta["d"], "type": meta.get("t", ""),
            "mtime": int(meta.get("ts") or 0) * 1000}

@router.post("/api/sync/asset")
def sync_put_asset(body: SyncAssetIn,
                   x_api_key: Optional[str] = Header(None, alias="X-API-Key")):
    """上传笔记引用的附件。同内容哈希同名，重复推送幂等。"""
    username = require_sync_user(x_api_key)
    try:
        data = base64.b64decode(body.dataB64)
    except Exception:
        raise HTTPException(400, "dataB64 不是合法的 base64")
    if not data:
        raise HTTPException(400, "附件内容为空")
    if len(data) > ASSET_MAX:
        raise HTTPException(400, "附件过大（上限 5MB）")
    name = _sync_asset_stored_name(body.filename or "", data)
    mime = _ASSET_MEDIA.get(Path(name).suffix.lower(), body.mime or "application/octet-stream")
    existing = storage.asset_read(username, name)
    now = int(time.time())
    if existing:
        meta, _ = _asset_payload_meta(existing)
        if meta and meta.get("d") == base64.b64encode(data).decode():
            return {"name": name, "mtime": int(meta.get("ts") or 0) * 1000, "unchanged": True}
    payload = json.dumps({"t": mime, "d": base64.b64encode(data).decode(), "ts": now})
    storage.asset_write(username, name, payload)
    return {"name": name, "mtime": now * 1000, "unchanged": False}

