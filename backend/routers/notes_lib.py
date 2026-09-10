"""万事屋 · 笔记/同步共享逻辑（无 HTTP 路由）"""
from __future__ import annotations

import re
import hashlib
import secrets
import time
import uuid
import json
from pathlib import Path
from typing import Optional

from fastapi import Header, HTTPException
from pydantic import BaseModel

import storage
import teams
from sessions import require_user, current_user_optional

PINNED_TITLES = ("生词本",)

PLAN_FOLDER = "每日计划"   # 系统内置文件夹：首次拉取自动创建，不可删除（今日计划按月归档其中）

QUICK_FOLDER = "灵感速记"  # 仪表盘「灵感速记」专属文件夹：删除后拉取时自动重建（旧名「速记」自动迁移）

VAULT_DEFAULT = storage.VAULT_DEFAULT

VAULT_SYSTEM = storage.VAULT_SYSTEM

_ASSET_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
                "image/webp": ".webp", "image/svg+xml": ".svg"}
_ASSET_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
                ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
                ".webm": "video/webm", ".wav": "audio/wav", ".zip": "application/zip"}
_ASSET_NAME = re.compile(
    r"^[\w.\u4e00-\u9fff\-]+\.(?:png|jpe?g|gif|webp|svg|pdf|mp3|mp4|webm|wav|zip)$", re.I)
ASSET_MAX = 5 * 1024 * 1024

_JUNK_BASENAMES = {".DS_Store", "Thumbs.db", "desktop.ini", "._.trashes"}

def _is_builtin_folder(name: str) -> bool:
    root = (name or "").split("/")[0]
    return root in (PLAN_FOLDER, QUICK_FOLDER)

def _infer_note_vault(n: dict) -> str:
    """常驻与内置文件夹笔记永远属于系统内置仓库；其余尊重已写入的 vault。"""
    if (n or {}).get("pinned") or _is_builtin_folder((n or {}).get("folder") or ""):
        return VAULT_SYSTEM
    vid = (n or {}).get("vault") or ""
    return vid or VAULT_DEFAULT

def _load_vaults(username: str) -> dict:
    """读取并归一化仓库清单。保证默认仓 + 系统内置仓存在。"""
    raw = storage.user_json(username, "notes/vaults.json", {})
    if isinstance(raw, list):
        raw = {"items": raw, "folderVault": {}}
    if not isinstance(raw, dict):
        raw = {}
    items = [x for x in (raw.get("items") or []) if isinstance(x, dict) and x.get("id")]
    by_id = {x["id"]: x for x in items}
    now = int(time.time())
    if VAULT_DEFAULT not in by_id:
        items.insert(0, {"id": VAULT_DEFAULT, "name": "默认仓库", "kind": "default",
                         "created": now})
    else:
        by_id[VAULT_DEFAULT]["kind"] = "default"
    if VAULT_SYSTEM not in by_id:
        items.append({"id": VAULT_SYSTEM, "name": "系统内置", "kind": "system",
                      "created": now})
    else:
        by_id[VAULT_SYSTEM]["kind"] = "system"
        if not (by_id[VAULT_SYSTEM].get("name") or "").strip():
            by_id[VAULT_SYSTEM]["name"] = "系统内置"
    # 保序去重
    seen, out = set(), []
    for it in items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append(it)
    fv = raw.get("folderVault") if isinstance(raw.get("folderVault"), dict) else {}
    return {"items": out, "folderVault": fv}

def _save_vaults(username: str, data: dict):
    storage.save_user_json(username, "notes/vaults.json", data)

def _vault_by_id(username: str, vid: str):
    data = _load_vaults(username)
    return next((x for x in data["items"] if x["id"] == vid), None)

def _ensure_vaults(username: str):
    """幂等：创建两个系统仓库、给旧笔记/文件夹打上 vault 归属。"""
    data = _load_vaults(username)
    fv = dict(data.get("folderVault") or {})
    folders = storage.user_json(username, "notes/folders.json", [])
    idx = storage.notes_index(username)
    changed_n = False
    for n in idx:
        vid = _infer_note_vault(n)
        if n.get("vault") != vid:
            n["vault"] = vid
            changed_n = True
        f = n.get("folder") or ""
        if f:
            cur = ""
            for seg in f.split("/"):
                cur = seg if not cur else cur + "/" + seg
                _folder_claim(fv, cur, vid)
    for f in folders:
        name = f.get("name") if isinstance(f, dict) else str(f or "")
        if not name:
            continue
        if name not in fv:
            fv[name] = VAULT_SYSTEM if _is_builtin_folder(name) else VAULT_DEFAULT
    data["folderVault"] = fv
    _save_vaults(username, data)
    if changed_n:
        storage.save_notes_index(username, idx)
    return data

def _folder_vault(data: dict, name: str, prefer: str = "") -> str:
    """文件夹所属仓库。同一路径可属于多个仓库（值为 id 列表）。"""
    fv = data.get("folderVault") or {}
    cur = fv.get(name)
    if isinstance(cur, list):
        ids = [x for x in cur if x]
        if prefer and prefer in ids:
            return prefer
        return ids[0] if ids else (
            VAULT_SYSTEM if _is_builtin_folder(name) else VAULT_DEFAULT)
    if cur:
        return cur
    return VAULT_SYSTEM if _is_builtin_folder(name) else VAULT_DEFAULT

def _folder_claimed(data: dict, name: str, vid: str) -> bool:
    fv = data.get("folderVault") or {}
    cur = fv.get(name)
    if isinstance(cur, list):
        return vid in cur
    if cur:
        return cur == vid
    return (VAULT_SYSTEM if _is_builtin_folder(name) else VAULT_DEFAULT) == vid

def _folder_claim(fv: dict, name: str, vid: str):
    """把文件夹路径登记到指定仓库；已属其它仓库时并存，不抢占。"""
    if not name or not vid:
        return
    cur = fv.get(name)
    if cur is None:
        fv[name] = vid
        return
    if isinstance(cur, list):
        if vid not in cur:
            cur.append(vid)
        return
    if cur == vid:
        return
    fv[name] = [cur, vid]

def _folder_unclaim(fv: dict, name: str, vid: str):
    cur = fv.get(name)
    if isinstance(cur, list):
        nxt = [x for x in cur if x != vid]
        if not nxt:
            fv.pop(name, None)
        elif len(nxt) == 1:
            fv[name] = nxt[0]
        else:
            fv[name] = nxt
    elif cur == vid:
        fv.pop(name, None)

def _folders_in_vault(username: str, vid: str) -> list:
    data = _load_vaults(username)
    folders = storage.user_json(username, "notes/folders.json", [])
    names = []
    for f in folders:
        name = f.get("name") if isinstance(f, dict) else str(f or "")
        if name and _folder_claimed(data, name, vid):
            names.append(name)
    return names

def _active_vault_id(username: str) -> str:
    prefs = storage.get_prefs(username) or {}
    vid = prefs.get("activeVault") or VAULT_DEFAULT
    if not _vault_by_id(username, vid):
        return VAULT_DEFAULT
    return vid

def _vault_public(v: dict, username: str) -> dict:
    owner = v.get("owner") or (username if v.get("kind") == "team" else "")
    out = {"id": v.get("id"), "name": v.get("name") or "", "kind": v.get("kind") or "user",
           "owner": owner if v.get("kind") == "team" else ""}
    if v.get("kind") == "team":
        if v.get("projection"):
            out["isOwner"] = False
            out["canEdit"] = bool(v.get("canEdit"))
            out["memberCount"] = 0
        else:
            members = v.get("members") or []
            out["isOwner"] = True
            out["canEdit"] = True
            out["memberCount"] = len(members)
            out["owner"] = v.get("owner") or username
    else:
        out["isOwner"] = True
        out["canEdit"] = True
    out["syncEnabled"] = _vault_sync_enabled(username, v.get("id") or "")
    return out

def _team_ctx(username: str, vid: str = ""):
    """解析仓库访问：store=笔记所在账号，can_edit/is_owner。"""
    vid = (vid or "").strip() or _active_vault_id(username)
    local = _vault_by_id(username, vid)
    if not local:
        raise HTTPException(404, "笔记仓库不存在")
    if local.get("kind") == "team" and local.get("projection") and local.get("owner"):
        owner = local.get("owner")
        rec = _vault_by_id(owner, vid)
        if not rec or rec.get("kind") != "team":
            raise HTTPException(404, "团队仓库不存在或已解散")
        mem = next((m for m in (rec.get("members") or []) if m.get("u") == username), None)
        if not mem:
            raise HTTPException(403, "你已不在此团队仓库")
        return {"store": owner, "rec": rec, "can_edit": bool(mem.get("canEdit")),
                "is_owner": False, "vid": vid, "local": local}
    if local.get("kind") == "team":
        if not local.get("owner"):
            local["owner"] = username
        return {"store": username, "rec": local, "can_edit": True,
                "is_owner": True, "vid": vid, "local": local}
    return {"store": username, "rec": local, "can_edit": True,
            "is_owner": True, "vid": vid, "local": local}

def _vault_sync_enabled(username: str, vid: str) -> bool:
    """当前仓库是否允许 Obsidian 同步。关闭后令牌仍保留但不予放行。
    未写过 syncEnabled 时兼容旧数据：已有创建人令牌或曾开过全局开关则视为开启。"""
    vid = (vid or "").strip() or VAULT_DEFAULT
    if vid == VAULT_SYSTEM:
        return False
    try:
        tctx = _team_ctx(username, vid)
    except HTTPException:
        rec = _vault_by_id(username, vid) or {}
        store = username
    else:
        rec = tctx["rec"] or {}
        store = tctx["store"]
        vid = tctx["vid"]
    if rec.get("kind") == "system":
        return False
    if "syncEnabled" in rec:
        return bool(rec.get("syncEnabled"))
    if storage.owner_has_sync_key(store, vid):
        return True
    return bool((storage.get_prefs(store) or {}).get("obsidianSync"))

def _require_vault_edit(username: str, vid: str = ""):
    ctx = _team_ctx(username, vid)
    if not ctx["can_edit"]:
        raise HTTPException(403, "此团队仓库为只读")
    return ctx

def _find_note(username: str, nid: str):
    idx = storage.notes_index(username)
    hit = next((n for n in idx if n.get("id") == nid), None)
    if hit:
        return username, hit, idx
    for v in _load_vaults(username)["items"]:
        if not v.get("projection") or not v.get("owner"):
            continue
        owner = v.get("owner")
        oidx = storage.notes_index(owner)
        ohit = next((n for n in oidx if n.get("id") == nid), None)
        if ohit and _infer_note_vault(ohit) == v.get("id"):
            return owner, ohit, oidx
    return None, None, None

def _add_member_projection(member: str, owner: str, rec: dict):
    data = _ensure_vaults(member)
    items = data["items"]
    vid = rec.get("id")
    mem = next((m for m in (rec.get("members") or []) if m.get("u") == member), None)
    stub = {"id": vid, "name": rec.get("name") or "团队仓库", "kind": "team",
            "owner": owner, "projection": True,
            "canEdit": bool(mem and mem.get("canEdit"))}
    found = next((x for x in items if x.get("id") == vid), None)
    if found:
        found.update(stub)
    else:
        items.append(stub)
    _save_vaults(member, data)

def _drop_member_projection(member: str, vid: str):
    data = _load_vaults(member)
    data["items"] = [x for x in data["items"] if x.get("id") != vid]
    if _active_vault_id(member) == vid:
        prefs = storage.get_prefs(member) or {}
        prefs["activeVault"] = VAULT_DEFAULT
        storage.save_prefs(member, prefs)
    _save_vaults(member, data)

def _refresh_team_projections(username: str):
    data = _ensure_vaults(username)
    keep = []
    changed = False
    for v in data["items"]:
        if not v.get("projection"):
            keep.append(v)
            continue
        owner, vid = v.get("owner"), v.get("id")
        rec = _vault_by_id(owner, vid) if owner else None
        if not rec or rec.get("kind") != "team":
            changed = True
            continue
        mem = next((m for m in (rec.get("members") or []) if m.get("u") == username), None)
        if not mem:
            changed = True
            continue
        v["name"] = rec.get("name") or v.get("name")
        v["canEdit"] = bool(mem.get("canEdit"))
        keep.append(v)
    if len(keep) != len(data["items"]):
        changed = True
    data["items"] = keep
    if changed:
        _save_vaults(username, data)
    return data

def _merged_notes_payload(username: str):
    data = _refresh_team_projections(username)
    idx = storage.notes_index(username)
    active = [n for n in idx if not n.get("deleted")]
    trash_count = sum(1 for n in idx if n.get("deleted"))
    folders = storage.user_json(username, "notes/folders.json", [])
    folder_names = [f.get("name") if isinstance(f, dict) else str(f or "") for f in folders]
    folder_names = [x for x in folder_names if x]
    fv = dict(data.get("folderVault") or {})
    vaults_out = []
    for v in data["items"]:
        vaults_out.append(_vault_public(v, username))
        if v.get("projection") and v.get("owner"):
            owner = v["owner"]
            vid = v["id"]
            for n in storage.notes_index(owner):
                if n.get("deleted"):
                    continue
                if _infer_note_vault(n) != vid:
                    continue
                active.append(n)
            odata = _load_vaults(owner)
            ofolders = storage.user_json(owner, "notes/folders.json", [])
            for f in ofolders:
                name = f.get("name") if isinstance(f, dict) else str(f or "")
                if name and _folder_claimed(odata, name, vid) and name not in folder_names:
                    folder_names.append(name)
                    _folder_claim(fv, name, vid)
    for n in active:
        f = (n.get("folder") or "").strip("/")
        if not f:
            continue
        vid_n = _infer_note_vault(n)
        cur = ""
        for seg in f.split("/"):
            cur = seg if not cur else cur + "/" + seg
            if cur not in folder_names:
                folder_names.append(cur)
            _folder_claim(fv, cur, vid_n)
    return {"notes": active, "folders": folder_names, "folderVault": fv,
            "vaults": vaults_out, "currentVault": _active_vault_id(username),
            "shares": _share_public_list(username), "trashCount": trash_count}

def _rename_quick(old: str, new: str):
    """文件夹改名工具：旧路径 → 新路径（含子路径）。"""
    def _ren(f):
        if f == old:
            return new
        if f.startswith(old + "/"):
            return new + f[len(old):]
        return f
    return _ren

def _share_hash(raw: str) -> str:
    return hashlib.sha256(("note-share:" + (raw or "")).encode("utf-8")).hexdigest()

def _shares_load(username: str) -> list:
    items = storage.user_json(username, "notes/shares.json", [])
    return items if isinstance(items, list) else []

def _shares_save(username: str, items: list):
    storage.save_user_json(username, "notes/shares.json", items)

def _share_index_put(raw_hash: str, username: str, sid: str):
    cfg = storage.get_config()
    idxm = dict(cfg.get("noteShareIndex") or {})
    idxm[raw_hash] = {"u": username, "id": sid}
    cfg["noteShareIndex"] = idxm
    storage.save_config(cfg)

def _share_index_del(raw_hash: str):
    cfg = storage.get_config()
    idxm = dict(cfg.get("noteShareIndex") or {})
    idxm.pop(raw_hash, None)
    cfg["noteShareIndex"] = idxm
    storage.save_config(cfg)

def _share_gc(username: str) -> list:
    now = int(time.time())
    items, alive = _shares_load(username), []
    for x in items:
        exp = int(x.get("expireAt") or 0)
        if exp and exp <= now:
            h = x.get("hash") or ""
            if h:
                _share_index_del(h)
            continue
        alive.append(x)
    if len(alive) != len(items):
        _shares_save(username, alive)
    return alive

def _share_public_list(username: str) -> list:
    out = []
    for x in _share_gc(username):
        out.append({"id": x.get("id"), "kind": x.get("kind"),
                    "noteId": x.get("noteId") or "", "folder": x.get("folder") or "",
                    "vault": x.get("vault") or "", "canEdit": bool(x.get("canEdit")),
                    "requireLogin": bool(x.get("requireLogin")),
                    "expireAt": int(x.get("expireAt") or 0),
                    "name": x.get("name") or "",
                    "token": x.get("token") or ""})
    return out

def _share_scope_folders(username: str, rec: dict) -> list:
    """分享范围内的文件夹路径（含空文件夹），供侧栏按层级展示。"""
    if rec.get("kind") != "folder":
        return []
    root = (rec.get("folder") or "").strip("/")
    vault = rec.get("vault") or ""
    names = set()
    data = _load_vaults(username)
    folders = storage.user_json(username, "notes/folders.json", [])
    for f in folders:
        name = f.get("name") if isinstance(f, dict) else str(f or "")
        if not name:
            continue
        if root:
            if name == root or name.startswith(root + "/"):
                names.add(name)
        elif _folder_claimed(data, name, vault):
            names.add(name)
    for n in _share_scope_notes(username, rec):
        f = (n.get("folder") or "").strip("/")
        if not f:
            continue
        if root and not (f == root or f.startswith(root + "/")):
            continue
        cur = ""
        for seg in f.split("/"):
            cur = seg if not cur else cur + "/" + seg
            if not root or cur == root or cur.startswith(root + "/"):
                names.add(cur)
    return sorted(names)

def _resolve_share(raw: str):
    raw = (raw or "").strip()
    if not raw:
        return None
    hit = (storage.get_config().get("noteShareIndex") or {}).get(_share_hash(raw))
    if not hit:
        return None
    username, sid = hit.get("u"), hit.get("id")
    if not username or not sid:
        return None
    rec = next((x for x in _share_gc(username) if x.get("id") == sid), None)
    if not rec:
        return None
    return username, rec

def _share_scope_notes(username: str, rec: dict) -> list:
    idx = storage.notes_index(username)
    if rec.get("kind") == "note":
        nid = rec.get("noteId")
        return [n for n in idx if n.get("id") == nid and not n.get("deleted")]
    folder = rec.get("folder") or ""
    vault = rec.get("vault") or ""
    out = []
    for n in idx:
        if n.get("deleted"):
            continue
        if vault and _infer_note_vault(n) != vault:
            continue
        f = n.get("folder") or ""
        if folder == "":
            if _infer_note_vault(n) == vault:
                out.append(n)
        elif f == folder or f.startswith(folder + "/"):
            out.append(n)
    return out

def _ensure_pinned(username: str):
    """常驻笔记缺失时自动创建（删除后再次拉取即重建）；并确保「每日计划」「灵感速记」文件夹存在。"""
    idx = storage.notes_index(username)
    changed = False
    for title in PINNED_TITLES:
        hit = next((i for i in idx if i.get("title") == title), None)
        if hit:
            if not hit.get("pinned"):
                hit["pinned"] = True
                changed = True
            continue
        note_id = uuid.uuid4().hex[:8]
        idx.insert(0, {"id": note_id, "title": title, "tags": [],
                       "pinned": True, "folder": "", "vault": VAULT_SYSTEM,
                       "updated": int(time.time())})
        seed = "# 生词本\n\n从「每日单词」收藏的词汇会自动追加到这里。\n"
        storage.note_write(username, note_id, seed)
        changed = True
    if changed:
        storage.save_notes_index(username, idx)
    folders = storage.user_json(username, "notes/folders.json", [])
    changed_f = False
    # 旧版兼容：「速记」文件夹整体改名为「灵感速记」（含子路径与笔记归属）
    if "速记" in folders or any(f.startswith("速记/") for f in folders):
        ren = _rename_quick("速记", QUICK_FOLDER)
        # 改名后可能与已存在的「灵感速记」及其子路径撞名，保序去重再落库；
        # 否则重复名会撞 bm_note_folders 主键 (username, name)，每次拉取都 500。
        _seen, _merged = set(), []
        for _f in (ren(x) for x in folders):
            if _f not in _seen:
                _seen.add(_f)
                _merged.append(_f)
        folders = _merged
        idx = storage.notes_index(username)
        moved = False
        for item in idx:
            old_f = item.get("folder") or ""
            new_f = ren(old_f)
            if new_f != old_f:
                item["folder"] = new_f
                moved = True
        if moved:
            storage.save_notes_index(username, idx)
        changed_f = True
    if PLAN_FOLDER not in folders:
        folders.insert(0, PLAN_FOLDER)
        changed_f = True
    if QUICK_FOLDER not in folders:
        folders.append(QUICK_FOLDER)
        changed_f = True
    if changed_f:
        storage.save_user_json(username, "notes/folders.json", folders)
        data = _load_vaults(username)
        fv = dict(data.get("folderVault") or {})
        fv[PLAN_FOLDER] = VAULT_SYSTEM
        fv[QUICK_FOLDER] = VAULT_SYSTEM
        data["folderVault"] = fv
        _save_vaults(username, data)

def _is_junk_path(path: str) -> bool:
    """是否 macOS / Windows 资源垃圾（不合法路径段或带 ._ 前缀）"""
    for seg in path.replace("\\", "/").split("/"):
        if not seg:
            continue
        if seg.startswith("._") or seg in _JUNK_BASENAMES:
            return True
        if seg == "__MACOSX":
            return True
    return False

def _safe_fs_name(s: str) -> str:
    """生成安全文件名：去除路径分隔符与控制字符，限制长度。"""
    if not s:
        return "untitled"
    s = re.sub(r"[\\/:*?\"<>|\r\n\t]", "_", s).strip(" ._")
    return (s or "untitled")[:80]

def _note_to_md(meta: dict, content: str) -> bytes:
    """单条笔记 → .md 字节（标题作 H1 + 空行 + 正文）"""
    title = meta.get("title") or "未命名笔记"
    body = (content or "").lstrip()
    # 如果正文不是以 # 开头，标题先单独放一行
    if not body.startswith("#"):
        md = f"# {title}\n\n{body}\n"
    else:
        md = f"{body}\n"
    return md.encode("utf-8")

def _parse_md(raw: bytes, fallback_name: str) -> tuple:
    """从 .md 字节里解析出 (title, content)：若首行是 H1 则标题取 H1，否则取文件名。"""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    text = text.lstrip("\ufeff").lstrip()
    title, body = "", text
    m = re.match(r"^#\s+(.+?)\s*[\r\n]", text)
    if m:
        title = m.group(1).strip()
        body = text[m.end():].lstrip("\n")
    if not title:
        title = Path(fallback_name).stem or "未命名笔记"
    return title, body

def _ensure_folder(username: str, folder: str, vault_id: str = ""):
    """不存在则创建（与 /api/notes/folders 同语义，逐级补齐父级）"""
    folder = (folder or "").strip("/")
    if not folder:
        return
    vid = VAULT_SYSTEM if _is_builtin_folder(folder) else (vault_id or _active_vault_id(username))
    folders = storage.user_json(username, "notes/folders.json", [])
    data = _load_vaults(username)
    fv = dict(data.get("folderVault") or {})
    cur = ""
    changed = False
    for seg in folder.split("/"):
        cur = seg if not cur else cur + "/" + seg
        if cur not in folders:
            folders.append(cur)
            changed = True
        _folder_claim(fv, cur, vid)
    if changed:
        storage.save_user_json(username, "notes/folders.json", folders)
    data["folderVault"] = fv
    _save_vaults(username, data)

def _create_imported_note(username: str, title: str, content: str, folder: str) -> dict:
    """创建一篇笔记（避免与现有标题冲突，重复自动加序号）。"""
    idx = storage.notes_index(username)
    used = {m["title"] for m in idx}
    final = title
    n = 2
    while final in used:
        final = f"{title} ({n})"
        n += 1
    note_id = uuid.uuid4().hex[:8]
    vid = VAULT_SYSTEM if _is_builtin_folder(folder) else _active_vault_id(username)
    idx.insert(0, {"id": note_id, "title": final, "tags": [],
                   "folder": folder, "vault": vid, "pinned": False,
                   "updated": int(time.time())})
    storage.save_notes_index(username, idx)
    storage.note_write(username, note_id, content or "")
    return idx[0]

def _gc_trash(username: str):
    """按设置的天数自动清理回收站过期项；trashDays=0 表示永不自动清。"""
    prefs = storage.get_prefs(username)
    days = int(prefs.get("trashDays", 30) or 0)
    if days <= 0:
        return
    threshold = int(time.time()) - days * 86400
    idx = storage.notes_index(username)
    alive = []
    purged = 0
    for n in idx:
        if n.get("deleted") and (n.get("deleted") or 0) < threshold:
            try: storage.note_delete(username, n["id"])
            except Exception: pass
            purged += 1
        else:
            alive.append(n)
    if purged:
        storage.save_notes_index(username, alive)

def _share_same_scope(a: dict, b: dict) -> bool:
    if (a.get("kind") or "") != (b.get("kind") or ""):
        return False
    if (a.get("vault") or "") != (b.get("vault") or ""):
        return False
    if a.get("kind") == "note":
        return (a.get("noteId") or "") == (b.get("noteId") or "")
    return (a.get("folder") or "") == (b.get("folder") or "")

def _require_share(token: str):
    found = _resolve_share(token)
    if not found:
        raise HTTPException(404, "分享不存在或已过期")
    return found

def _enforce_share_login(rec: dict, authorization: Optional[str],
                         access: Optional[str] = None):
    if not rec.get("requireLogin"):
        return
    try:
        require_user(authorization, access)
    except HTTPException:
        raise HTTPException(401, "需要登录后查看此分享")

def require_sync_user(x_api_key: Optional[str]) -> str:
    """校验 X-API-Key，解析出用户名；失败抛 401。"""
    ctx = require_sync_ctx(x_api_key)
    return ctx["u"]

def require_sync_ctx(x_api_key: Optional[str]) -> dict:
    """校验 X-API-Key，返回 {u, vault, actor}。"""
    if not x_api_key:
        raise HTTPException(401, "缺少 X-API-Key 请求头")
    ctx = storage.verify_sync_context(x_api_key)
    if not ctx or not ctx.get("u"):
        raise HTTPException(401, "API Key 无效或已吊销")
    if ctx.get("vault") == VAULT_SYSTEM:
        raise HTTPException(403, "系统内置仓库不可同步")
    ctx.setdefault("actor", ctx["u"])
    if not _vault_sync_enabled(ctx["u"], ctx.get("vault") or ""):
        raise HTTPException(403, "万事屋服务端已关闭当前笔记仓库的同步功能")
    return ctx

def _sync_require_member_edit(ctx: dict):
    actor = ctx.get("actor") or ctx["u"]
    owner = ctx["u"]
    if actor == owner:
        return
    rec = _vault_by_id(owner, ctx.get("vault") or "")
    if not rec or rec.get("kind") != "team":
        raise HTTPException(403, "无权同步此仓库")
    mem = next((m for m in (rec.get("members") or []) if m.get("u") == actor), None)
    if not mem or not mem.get("canEdit"):
        raise HTTPException(403, "没有该团队仓库的编辑/同步权限")

def _guard_sync_put(ctx: dict, client_mtime: int, approval_id: Optional[str]):
    _sync_require_member_edit(ctx)
    actor = ctx.get("actor") or ctx["u"]
    owner = ctx["u"]
    vid = ctx.get("vault") or ""
    if actor == owner:
        return
    rec = _vault_by_id(owner, vid)
    if not rec or rec.get("kind") != "team":
        return
    now_ms = int(time.time() * 1000)
    if int(client_mtime or 0) > now_ms + 3600_000:
        if not (approval_id and teams.approval_ticket_ok(
                approval_id, actor, owner, vid, "overwrite")):
            raise HTTPException(403, "覆盖服务端需创建人审批")

def _guard_sync_delete(ctx: dict, path: str, approval_id: Optional[str]):
    _sync_require_member_edit(ctx)
    actor = ctx.get("actor") or ctx["u"]
    owner = ctx["u"]
    vid = ctx.get("vault") or ""
    if actor == owner:
        return
    rec = _vault_by_id(owner, vid)
    if not rec or rec.get("kind") != "team":
        return
    if approval_id and (teams.approval_ticket_ok(approval_id, actor, owner, vid, "bulk-delete", path)
                        or teams.approval_ticket_ok(approval_id, actor, owner, vid, "overwrite")):
        return
    n = teams.note_member_delete(actor, vid)
    if n > teams.DELETE_VALVE:
        raise HTTPException(403, "单次删除服务端超过 10 篇需创建人审批")

def _sync_safe_name(s: str) -> str:
    """路径段清洗：与 localsync.js safeName 一致（非法字符 -> _）。"""
    t = re.sub(r'[\\/:*?"<>|]', "_", str(s or "")).strip()
    return t or "未命名笔记"

def _note_to_path(meta: dict) -> str:
    """笔记 -> 相对路径：folder 各段清洗 + title.md（与 localsync.js expectedPath 一致）。"""
    segs = [_sync_safe_name(p) for p in str(meta.get("folder") or "").split("/") if p]
    segs.append(_sync_safe_name(meta.get("title")) + ".md")
    return "/".join(segs)

def _in_sync_scope(n: dict, vault_id: str = "") -> bool:
    """同步范围：当前令牌绑定的仓库内、未删除、非常驻的笔记。"""
    if not n or n.get("pinned") or n.get("deleted"):
        return False
    vid = vault_id or _infer_note_vault(n)
    if _infer_note_vault(n) != vid:
        return False
    if vid == VAULT_SYSTEM:
        return False
    return True

def _sync_path_index(username: str, vault_id: str = ""):
    """构建 {path: meta} 与 {id: path} 双向索引。
    path 分配按 (folder, title, id) 确定性排序：notes_index 会因 save_note 的
    updated 重排而变序，若不固定顺序，同名冲突笔记的 -2 后缀会在多次 /list 间抖动。"""
    idx = storage.notes_index(username)
    scoped = [n for n in idx
              if _in_sync_scope(n, vault_id) and not _is_junk_path(n.get("title") or "")]
    scoped.sort(key=lambda n: (n.get("folder") or "", n.get("title") or "",
                               n.get("id") or ""))
    by_path, id_to_path = {}, {}
    for n in scoped:
        want = _note_to_path(n)
        p, i = want, 2
        while p in by_path and by_path[p].get("id") != n.get("id"):
            stem = want[:-3] if want.lower().endswith(".md") else want
            p = "%s-%d.md" % (stem, i)
            i += 1
        by_path[p] = n
        id_to_path[n.get("id")] = p
    return by_path, id_to_path

def _resolve_sync_path(username: str, path: str, vault_id: str = ""):
    """path -> 唯一笔记 meta（供 file/rename/delete 定位）；未命中返回 None。"""
    by_path, _ = _sync_path_index(username, vault_id)
    return by_path.get(path)

def _validate_sync_path(path: str) -> str:
    """规范化 + 安全校验同步路径：拒绝绝对路径、..、空段、隐藏段（.obsidian/.git）、
    资源垃圾。因最终映射到笔记而非物理文件，遍历面小，但仍严格校验（需求 5 路径遍历防护）。"""
    raw = (path or "").replace("\\", "/").strip()
    if not raw or not raw.strip("/"):
        raise HTTPException(400, "path 不能为空")
    if raw.startswith("/"):
        raise HTTPException(400, "path 不能为绝对路径")
    norm = raw.strip("/")
    for seg in norm.split("/"):
        if not seg or seg in (".", ".."):
            raise HTTPException(400, "path 含非法路径段")
        if seg.startswith("."):
            raise HTTPException(400, "path 含隐藏段（. 开头），不在同步范围")
    if _is_junk_path(norm):
        raise HTTPException(400, "path 为系统资源垃圾，已拒绝")
    return norm

def _split_sync_path(norm: str):
    """相对路径 -> (folder, fname)。"""
    if "/" in norm:
        return norm.rsplit("/", 1)
    return "", norm

def _clip_sync(s: str, n: int = 40) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip()
    return s if len(s) <= n else s[:n] + "…"

def _diff_summary(old: str, new: str) -> str:
    old_lines = (old or "").splitlines()
    new_lines = (new or "").splitlines()
    n = max(len(old_lines), len(new_lines))
    for i in range(n):
        a = old_lines[i] if i < len(old_lines) else None
        b = new_lines[i] if i < len(new_lines) else None
        if a == b:
            continue
        if a is None:
            return "第 %d 行新增「%s」" % (i + 1, _clip_sync(b))
        if b is None:
            return "第 %d 行删除「%s」" % (i + 1, _clip_sync(a))
        return "第 %d 行由「%s」改为「%s」" % (i + 1, _clip_sync(a), _clip_sync(b))
    if len(old_lines) != len(new_lines):
        return "正文行数 %d → %d" % (len(old_lines), len(new_lines))
    return "正文有变更"

def _log_vault_note(username: str, vault_id: str, *, kind: str, title: str,
                    summary: str, path: str = "", source: str = "obsidian",
                    frm: str = "Obsidian", to: str = "万事屋"):
    storage.append_sync_log(username, {
        "vault": vault_id, "source": source, "kind": kind,
        "title": title, "summary": summary, "path": path,
        "from": frm, "to": to,
        "msg": "%s %s" % (kind, title or path),
    })

def _sync_apply_note(username, nid, folder, title, body_md, site_mtime, norm, vault_id=""):
    """落地一篇已存在笔记。正文/标题/文件夹均未变则不 bump updated，避免轮询误判远端变更。"""
    if folder:
        _ensure_folder(username, folder, vault_id)
    old_body = storage.note_read(username, nid, "")
    idx = storage.notes_index(username)
    hit = next((it for it in idx if it.get("id") == nid), None)
    old_title = (hit or {}).get("title") or ""
    old_folder = (hit or {}).get("folder") or ""
    old_vault = (hit or {}).get("vault") or ""
    new_title = title or old_title or "未命名笔记"
    vault_same = (not vault_id) or old_vault == vault_id
    if old_body == body_md and new_title == old_title and folder == old_folder and vault_same:
        return {"path": norm, "mtime": site_mtime, "id": nid, "applied": True, "unchanged": True}
    if old_body != body_md:
        storage.note_rev_snapshot(username, nid, old_body, old_title, "obsidian")
    storage.note_write(username, nid, body_md)
    now = int(time.time())
    if hit is not None:
        hit["title"] = new_title
        hit["folder"] = folder
        if vault_id:
            hit["vault"] = vault_id
        hit["updated"] = now
        storage.save_notes_index(username, idx)
    bits = []
    if new_title != old_title and old_title:
        bits.append("标题「%s」→「%s」" % (_clip_sync(old_title, 24), _clip_sync(new_title, 24)))
    if folder != old_folder:
        bits.append("文件夹「%s」→「%s」" % (_clip_sync(old_folder or "根目录", 24),
                                      _clip_sync(folder or "根目录", 24)))
    if old_body != body_md:
        bits.append(_diff_summary(old_body, body_md))
    return {"path": norm, "mtime": now * 1000, "id": nid, "applied": True,
            "title": new_title, "summary": "；".join(bits) or "内容已更新"}


__all__ = [n for n in list(globals()) if not n.startswith("__")]

