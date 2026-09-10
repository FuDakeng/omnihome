"""万事屋 · 笔记仓库 / 团队仓库"""
from __future__ import annotations

import time
import uuid
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import storage
import teams
from sessions import require_user

router = APIRouter()
from routers.notes_lib import *  # noqa: F401,F403
from routers.notes_lib import (
    VAULT_DEFAULT, VAULT_SYSTEM, _load_vaults, _save_vaults,
    _vault_by_id, _ensure_vaults, _merged_notes_payload, _is_builtin_folder,
    _folder_claimed, _folder_unclaim, _infer_note_vault, _add_member_projection,
    _drop_member_projection, _refresh_team_projections, _team_ctx,
    _share_gc, _share_index_del, _shares_save,
)

class VaultIn(BaseModel):
    name: str = ""
    vault: str = ""

@router.get("/api/notes/vaults")
def list_vaults(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    payload = _merged_notes_payload(username)
    return {"vaults": payload["vaults"], "current": payload["currentVault"],
            "folderVault": payload["folderVault"]}

@router.post("/api/notes/vaults")
def create_vault(body: VaultIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    name = (body.name or "").strip() or "未命名仓库"
    if len(name) > 40:
        raise HTTPException(400, "仓库名称过长")
    data = _ensure_vaults(username)
    vid = uuid.uuid4().hex[:8]
    data["items"].append({"id": vid, "name": name, "kind": "user",
                          "created": int(time.time())})
    _save_vaults(username, data)
    return {"ok": True, "id": vid, "name": name}

@router.put("/api/notes/vaults/select")
def set_current_vault(body: VaultIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    vid = (body.vault or "").strip()
    _refresh_team_projections(username)
    if not _vault_by_id(username, vid):
        raise HTTPException(404, "笔记仓库不存在")
    prefs = storage.get_prefs(username) or {}
    prefs["activeVault"] = vid
    storage.save_prefs(username, prefs)
    return {"ok": True, "current": vid}

class TeamJoinIn(BaseModel):
    token: str = ""

class TeamMemberIn(BaseModel):
    canEdit: Optional[bool] = None

@router.post("/api/notes/vaults/join")
def join_team_vault(body: TeamJoinIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    hit = teams.index_get(body.token)
    if not hit:
        raise HTTPException(404, "邀请码无效或已失效")
    owner, vid = hit
    rec = _vault_by_id(owner, vid)
    if not rec or rec.get("kind") != "team":
        raise HTTPException(404, "团队仓库不存在或已解散")
    if owner == username:
        return {"ok": True, "id": vid, "name": rec.get("name"), "self": True}
    members = list(rec.get("members") or [])
    if not any(m.get("u") == username for m in members):
        members.append({"u": username, "canEdit": False, "joined": int(time.time())})
        rec["members"] = members
        data = _load_vaults(owner)
        for x in data["items"]:
            if x.get("id") == vid:
                x["members"] = members
        _save_vaults(owner, data)
    rec = _vault_by_id(owner, vid)
    _add_member_projection(username, owner, rec)
    prefs = storage.get_prefs(username) or {}
    prefs["activeVault"] = vid
    storage.save_prefs(username, prefs)
    return {"ok": True, "id": vid, "name": rec.get("name") or "",
            "canEdit": bool(next((m for m in rec.get("members") or [] if m.get("u") == username), {}).get("canEdit"))}

@router.post("/api/notes/vaults/{vid}/team")
def convert_vault_to_team(vid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    data = _ensure_vaults(username)
    hit = next((x for x in data["items"] if x["id"] == vid), None)
    if not hit:
        raise HTTPException(404, "笔记仓库不存在")
    if hit.get("projection"):
        raise HTTPException(403, "不能转换他人的仓库")
    if hit.get("kind") != "user":
        if hit.get("kind") == "team":
            raw = hit.get("invite") or ""
            if not raw:
                raw = teams.new_invite()
                hit["invite"] = raw
                hit["inviteHash"] = teams.invite_hash(raw)
                teams.index_put(raw, username, vid)
                _save_vaults(username, data)
            return {"ok": True, "id": vid, "token": raw, "kind": "team"}
        raise HTTPException(400, "仅自建仓库可转换为团队仓库")
    raw = teams.new_invite()
    hit["kind"] = "team"
    hit["owner"] = username
    hit["invite"] = raw
    hit["inviteHash"] = teams.invite_hash(raw)
    hit["members"] = []
    teams.index_put(raw, username, vid)
    _save_vaults(username, data)
    prefs = storage.get_prefs(username) or {}
    prefs["activeVault"] = vid
    storage.save_prefs(username, prefs)
    return {"ok": True, "id": vid, "token": raw, "kind": "team", "name": hit.get("name")}

@router.delete("/api/notes/vaults/{vid}/team")
def convert_vault_from_team(vid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    data = _ensure_vaults(username)
    hit = next((x for x in data["items"] if x["id"] == vid), None)
    if not hit:
        raise HTTPException(404, "笔记仓库不存在")
    if hit.get("kind") != "team" or hit.get("projection"):
        raise HTTPException(403, "仅创建人可将团队仓库转回普通仓库")
    for m in list(hit.get("members") or []):
        u = m.get("u")
        if u:
            _drop_member_projection(u, vid)
            storage.revoke_sync_key(username, vid, actor=u)
    teams.index_del_raw(hit.get("invite") or "")
    teams.index_del_vault(username, vid)
    hit["kind"] = "user"
    hit.pop("invite", None)
    hit.pop("inviteHash", None)
    hit.pop("members", None)
    hit.pop("owner", None)
    _save_vaults(username, data)
    return {"ok": True, "id": vid, "kind": "user"}

@router.get("/api/notes/vaults/{vid}/team")
def team_vault_detail(vid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    ctx = _team_ctx(username, vid)
    rec = ctx["rec"]
    members = [{"u": m.get("u"), "canEdit": bool(m.get("canEdit")),
                "joined": int(m.get("joined") or 0)} for m in (rec.get("members") or [])]
    out = {"ok": True, "id": vid, "name": rec.get("name") or "", "kind": rec.get("kind"),
           "owner": rec.get("owner") or ctx["store"], "isOwner": ctx["is_owner"],
           "canEdit": ctx["can_edit"], "members": members}
    if ctx["is_owner"]:
        out["token"] = rec.get("invite") or ""
    return out

@router.post("/api/notes/vaults/{vid}/invite")
def reset_team_invite(vid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    ctx = _team_ctx(username, vid)
    if not ctx["is_owner"]:
        raise HTTPException(403, "仅创建人可重置邀请")
    rec = ctx["rec"]
    teams.index_del_raw(rec.get("invite") or "")
    raw = teams.new_invite()
    rec["invite"] = raw
    rec["inviteHash"] = teams.invite_hash(raw)
    data = _load_vaults(ctx["store"])
    for x in data["items"]:
        if x.get("id") == vid:
            x["invite"] = raw
            x["inviteHash"] = rec["inviteHash"]
    _save_vaults(ctx["store"], data)
    teams.index_put(raw, ctx["store"], vid)
    return {"ok": True, "token": raw}

@router.post("/api/notes/vaults/{vid}/leave")
def leave_team_vault(vid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    ctx = _team_ctx(username, vid)
    if ctx["is_owner"]:
        raise HTTPException(400, "创建人请先将仓库转回普通仓库或删除仓库")
    rec = ctx["rec"]
    rec["members"] = [m for m in (rec.get("members") or []) if m.get("u") != username]
    data = _load_vaults(ctx["store"])
    for x in data["items"]:
        if x.get("id") == vid:
            x["members"] = rec["members"]
    _save_vaults(ctx["store"], data)
    _drop_member_projection(username, vid)
    storage.revoke_sync_key(ctx["store"], vid, actor=username)
    return {"ok": True}

@router.put("/api/notes/vaults/{vid}/members/{user}")
def update_team_member(vid: str, user: str, body: TeamMemberIn,
                       authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    ctx = _team_ctx(username, vid)
    if not ctx["is_owner"]:
        raise HTTPException(403, "仅创建人可管理成员")
    rec = ctx["rec"]
    mem = next((m for m in (rec.get("members") or []) if m.get("u") == user), None)
    if not mem:
        raise HTTPException(404, "成员不存在")
    if body.canEdit is not None:
        mem["canEdit"] = bool(body.canEdit)
        if not mem["canEdit"]:
            storage.revoke_sync_key(ctx["store"], vid, actor=user)
    data = _load_vaults(ctx["store"])
    for x in data["items"]:
        if x.get("id") == vid:
            x["members"] = rec["members"]
    _save_vaults(ctx["store"], data)
    _add_member_projection(user, ctx["store"], rec)
    return {"ok": True, "u": user, "canEdit": bool(mem.get("canEdit"))}

@router.delete("/api/notes/vaults/{vid}/members/{user}")
def remove_team_member(vid: str, user: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    ctx = _team_ctx(username, vid)
    if not ctx["is_owner"]:
        raise HTTPException(403, "仅创建人可移出成员")
    rec = ctx["rec"]
    rec["members"] = [m for m in (rec.get("members") or []) if m.get("u") != user]
    data = _load_vaults(ctx["store"])
    for x in data["items"]:
        if x.get("id") == vid:
            x["members"] = rec["members"]
    _save_vaults(ctx["store"], data)
    _drop_member_projection(user, vid)
    storage.revoke_sync_key(ctx["store"], vid, actor=user)
    return {"ok": True}

@router.put("/api/notes/vaults/{vid}")
def update_vault(vid: str, body: VaultIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    data = _ensure_vaults(username)
    hit = next((x for x in data["items"] if x["id"] == vid), None)
    if not hit:
        raise HTTPException(404, "笔记仓库不存在")
    if hit.get("projection"):
        raise HTTPException(403, "不能重命名他人的团队仓库")
    if hit.get("kind") == "system":
        raise HTTPException(403, "系统内置仓库不可重命名")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "仓库名称不能为空")
    hit["name"] = name[:40]
    _save_vaults(username, data)
    return {"ok": True, "id": vid, "name": hit["name"]}

@router.delete("/api/notes/vaults/{vid}")
def delete_vault(vid: str, authorization: Optional[str] = Header(None)):
    """删除用户自建仓库：其中笔记永久删除（不进回收站），所属文件夹一并移除。"""
    username = require_user(authorization)
    if vid in (VAULT_DEFAULT, VAULT_SYSTEM):
        raise HTTPException(403, "默认仓库与系统内置仓库不可删除")
    data = _ensure_vaults(username)
    hit = next((x for x in data["items"] if x["id"] == vid), None)
    if not hit:
        raise HTTPException(404, "笔记仓库不存在")
    if hit.get("projection"):
        raise HTTPException(403, "不能删除他人的团队仓库")
    if hit.get("kind") == "team":
        for m in list(hit.get("members") or []):
            u = m.get("u")
            if u:
                _drop_member_projection(u, vid)
                storage.revoke_sync_key(username, vid, actor=u)
        teams.index_del_vault(username, vid)
        teams.index_del_raw(hit.get("invite") or "")
        storage.revoke_sync_key(username, vid)
    fv = dict(data.get("folderVault") or {})
    drop_folders = set()
    for k in list(fv.keys()):
        if _is_builtin_folder(k):
            continue
        if not _folder_claimed({"folderVault": fv}, k, vid):
            continue
        _folder_unclaim(fv, k, vid)
        if fv.get(k) is None:
            drop_folders.add(k)
    folder_names = storage.user_json(username, "notes/folders.json", [])
    norm_folders = []
    for f in folder_names:
        name = f.get("name") if isinstance(f, dict) else str(f or "")
        if name:
            norm_folders.append(name)
            if name not in drop_folders and _folder_claimed(data, name, vid) and not _is_builtin_folder(name):
                if fv.get(name) is None:
                    drop_folders.add(name)
    idx = storage.notes_index(username)
    gone_ids, kept = set(), []
    for n in idx:
        if _infer_note_vault(n) == vid:
            gone_ids.add(n.get("id"))
            try:
                storage.note_delete(username, n["id"])
            except Exception:
                pass
            continue
        kept.append(n)
    storage.save_notes_index(username, kept)
    storage.save_user_json(username, "notes/folders.json",
                           [f for f in norm_folders if f not in drop_folders])
    for k in list(fv.keys()):
        if k in drop_folders:
            fv.pop(k, None)
    data["folderVault"] = fv
    data["items"] = [x for x in data["items"] if x["id"] != vid]
    _save_vaults(username, data)
    storage.revoke_sync_key(username, vid)
    items = _share_gc(username)
    alive = []
    for x in items:
        drop = ((x.get("vault") or "") == vid
                or (x.get("noteId") or "") in gone_ids
                or (x.get("kind") == "folder" and (x.get("folder") or "") in drop_folders))
        if drop:
            if x.get("hash"):
                _share_index_del(x["hash"])
            continue
        alive.append(x)
    _shares_save(username, alive)
    prefs = storage.get_prefs(username) or {}
    if prefs.get("activeVault") == vid:
        prefs["activeVault"] = VAULT_DEFAULT
        storage.save_prefs(username, prefs)
    return {"ok": True}
