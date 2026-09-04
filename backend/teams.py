"""万事屋 · 团队笔记仓库辅助：邀请索引、收件箱、同步审批票。"""
import hashlib
import secrets
import time
import uuid
from typing import Optional

import storage

INVITE_PREFIX = "t_"
APPROVAL_TTL = 24 * 3600
TICKET_TTL = 600
DELETE_VALVE = 10
DELETE_WINDOW = 120


def invite_hash(raw: str) -> str:
    return hashlib.sha256(("team-vault:" + (raw or "")).encode("utf-8")).hexdigest()


def new_invite() -> str:
    return INVITE_PREFIX + secrets.token_urlsafe(18)


def index_put(raw: str, owner: str, vid: str):
    cfg = storage.get_config()
    idxm = dict(cfg.get("teamVaultIndex") or {})
    idxm[invite_hash(raw)] = {"u": owner, "id": vid}
    cfg["teamVaultIndex"] = idxm
    storage.save_config(cfg)


def index_get(raw: str):
    raw = (raw or "").strip()
    if not raw:
        return None
    hit = (storage.get_config().get("teamVaultIndex") or {}).get(invite_hash(raw))
    if not hit:
        return None
    return hit.get("u"), hit.get("id")


def index_del_raw(raw: str):
    if not raw:
        return
    cfg = storage.get_config()
    idxm = dict(cfg.get("teamVaultIndex") or {})
    idxm.pop(invite_hash(raw), None)
    cfg["teamVaultIndex"] = idxm
    storage.save_config(cfg)


def index_del_vault(owner: str, vid: str):
    cfg = storage.get_config()
    idxm = dict(cfg.get("teamVaultIndex") or {})
    keep = {}
    for k, v in idxm.items():
        if v.get("u") == owner and v.get("id") == vid:
            continue
        keep[k] = v
    cfg["teamVaultIndex"] = keep
    storage.save_config(cfg)


# ---------- 收件箱 ----------
def inbox_list(username: str) -> list:
    items = storage.user_json(username, "inbox.json", [])
    return items if isinstance(items, list) else []


def inbox_save(username: str, items: list):
    storage.save_user_json(username, "inbox.json", items[:200])


def inbox_push(username: str, item: dict) -> dict:
    rec = dict(item)
    rec.setdefault("id", uuid.uuid4().hex[:12])
    rec.setdefault("ts", int(time.time()))
    rec.setdefault("read", False)
    items = inbox_list(username)
    items.insert(0, rec)
    inbox_save(username, items)
    return rec


def inbox_get(username: str, iid: str):
    return next((x for x in inbox_list(username) if x.get("id") == iid), None)


def inbox_patch(username: str, iid: str, **fields):
    items = inbox_list(username)
    hit = None
    for x in items:
        if x.get("id") == iid:
            x.update(fields)
            hit = x
            break
    if hit:
        inbox_save(username, items)
    return hit


def inbox_unread(username: str) -> int:
    return sum(1 for x in inbox_list(username) if not x.get("read"))


# ---------- 同步审批 ----------
def _approvals():
    cfg = storage.get_config()
    data = cfg.get("syncApprovals")
    return data if isinstance(data, dict) else {}


def _save_approvals(data: dict):
    cfg = storage.get_config()
    cfg["syncApprovals"] = data
    storage.save_config(cfg)


def approval_gc():
    now = int(time.time())
    data = _approvals()
    keep = {}
    for k, v in data.items():
        if not isinstance(v, dict):
            continue
        exp = int(v.get("expires") or 0)
        if exp and exp < now and v.get("status") != "approved":
            continue
        ticket_exp = int(v.get("ticketExpires") or 0)
        if v.get("status") == "approved" and ticket_exp and ticket_exp < now:
            continue
        keep[k] = v
    if len(keep) != len(data):
        _save_approvals(keep)
    return keep


def approval_create(owner: str, actor: str, vid: str, kind: str, paths: list) -> dict:
    approval_gc()
    aid = uuid.uuid4().hex[:12]
    rec = {
        "id": aid, "owner": owner, "actor": actor, "vault": vid,
        "kind": kind, "paths": list(paths or []),
        "status": "pending", "created": int(time.time()),
        "expires": int(time.time()) + APPROVAL_TTL,
        "ticket": "", "ticketExpires": 0,
    }
    data = _approvals()
    data[aid] = rec
    _save_approvals(data)
    kind_label = "用本地覆盖服务端" if kind == "overwrite" else (
        "单次删除服务端 %d 篇笔记" % len(paths or []))
    inbox_push(owner, {
        "type": "sync-approval", "ref": aid,
        "title": "团队仓库同步待审批",
        "body": "成员 %s 请求：%s" % (actor, kind_label),
        "vault": vid, "actor": actor, "kind": kind,
    })
    return rec


def approval_get(aid: str):
    approval_gc()
    return _approvals().get(aid)


def approval_decide(owner: str, aid: str, ok: bool) -> dict:
    rec = approval_get(aid)
    if not rec:
        return None
    if rec.get("owner") != owner:
        raise PermissionError("无权审批")
    if rec.get("status") != "pending":
        return rec
    rec["status"] = "approved" if ok else "denied"
    rec["decided"] = int(time.time())
    if ok:
        rec["ticket"] = secrets.token_urlsafe(16)
        rec["ticketExpires"] = int(time.time()) + TICKET_TTL
    data = _approvals()
    data[aid] = rec
    _save_approvals(data)
    if rec.get("actor"):
        inbox_push(rec.get("actor"), {
            "type": "sync-approval-result", "ref": aid,
            "title": "同步审批已通过" if ok else "同步审批已拒绝",
            "body": ("创建人已同意你对团队仓库的高危同步操作，请在 10 分钟内继续。"
                     if ok else "创建人拒绝了此次高危同步操作。"),
            "read": False,
        })
    return rec


def approval_ticket_ok(aid: str, actor: str, owner: str, vid: str, kind: str,
                       path: Optional[str] = None) -> bool:
    rec = approval_get(aid)
    if not rec or rec.get("status") != "approved":
        return False
    if rec.get("actor") != actor or rec.get("owner") != owner or rec.get("vault") != vid:
        return False
    if rec.get("kind") != kind:
        return False
    if int(rec.get("ticketExpires") or 0) < time.time():
        return False
    if kind == "bulk-delete" and path:
        paths = rec.get("paths") or []
        if paths and path not in paths:
            return False
    return True


# ---------- 成员短时删除计数（服务端阀） ----------
def _del_log():
    cfg = storage.get_config()
    data = cfg.get("syncDeleteLog")
    return data if isinstance(data, dict) else {}


def note_member_delete(actor: str, vid: str) -> int:
    """记录一次成员删除，返回窗口内次数。"""
    now = int(time.time())
    key = actor + "|" + vid
    data = _del_log()
    arr = [int(x) for x in (data.get(key) or []) if now - int(x) <= DELETE_WINDOW]
    arr.append(now)
    data[key] = arr[-40:]
    cfg = storage.get_config()
    cfg["syncDeleteLog"] = data
    storage.save_config(cfg)
    return len(arr)


def member_delete_count(actor: str, vid: str) -> int:
    now = int(time.time())
    key = actor + "|" + vid
    arr = [int(x) for x in (_del_log().get(key) or []) if now - int(x) <= DELETE_WINDOW]
    return len(arr)
