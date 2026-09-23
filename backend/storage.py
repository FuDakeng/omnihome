"""万事屋 · 存储层（三引擎 · 模块化分表）
引擎一（默认）：文件存储——每用户一个独立目录，JSON / Markdown 文件持久化，
        天然按模块分区（一模块一文件、一笔记一文件），目录命名即定位索引。
引擎二/三：数据库存储（SQLite / MySQL / PostgreSQL）——按功能模块拆分为独立表
        （书签 / 分类 / 笔记 / 文件夹 / 日历 / 保险库 / 偏好 / 仪表盘 / 计划 /
        AI 配置 / 备份配置），每表以 (username, 模块内主键) 为主键，并配备
        常用查询索引（分类、更新时间），避免各模块大文本挤在同一张表互相拖累。
旧版单表 omni_kv 在数据库首次连接时自动迁移至新结构：迁移前落盘全量快照备份，
迁移在同一事务内完成（失败整体回滚，旧表原封不动）；迁移未完成期间读路径自动
回查旧表（双读兜底），系统不会因迁移失败而不可用。
全局配置（config.json）始终以文件存放，其中 storage 段记录当前引擎。
"""
import fcntl
import hashlib
import json
import re
import secrets
import shutil
import threading
import time
import zipfile
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(ROOT / "data")
USERS_DIR = DATA_DIR / "users"
CONFIG_FILE = DATA_DIR / "config.json"
SQLITE_FILE = DATA_DIR / "omnihome.db"

_lock = threading.Lock()  # SQL 事务互斥（同进程）
_path_locks = {}
_path_locks_mu = threading.Lock()


def _thread_lock_for(path: Path) -> threading.Lock:
    key = str(path)
    with _path_locks_mu:
        lk = _path_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _path_locks[key] = lk
        return lk

SAFE_NAME = re.compile(r"^[\w\u4e00-\u9fa5\-]{1,32}$")

DEFAULT_PREFS = {
    "theme": {"mode": "dark", "hue": 243, "sat": 72},
    "layout": {"compact": False, "reduceMotion": False, "sidebarCollapsed": False},
    "locale": {"lang": "zh-CN", "weekStart": "mon", "tempUnit": "c"},
    "weather": {"city": "", "lat": 30.2741, "lon": 120.1552},
    "trashDays": 30,        # v0.2.15 增：回收站文件保留天数，0 = 永久（需手工清空）
    "obsidianSync": False,  # 功能设置：Obsidian 插件同步
    "activeVault": "default",
}


def _atomic_write(path: Path, content: str):
    """按路径加线程锁 + fcntl 文件锁，多进程 worker 下也不会互相踩文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(path) + ".lock")
    tmp = path.with_suffix(path.suffix + ".tmp")
    with _thread_lock_for(path):
        with open(lock_path, "a+") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                tmp.write_text(content, encoding="utf-8")
                tmp.replace(path)
            finally:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, obj):
    _atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))


def read_text(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return fallback


def write_text(path: Path, content: str):
    _atomic_write(path, content)


# ---------- 全局配置（始终文件存储） ----------
def get_config() -> dict:
    return read_json(CONFIG_FILE, {"users": {}, "createdAt": None})


def save_config(cfg: dict):
    write_json(CONFIG_FILE, cfg)


def valid_username(name: str) -> bool:
    return bool(SAFE_NAME.match(name or ""))


# ---------- Obsidian 同步 API Key（每用户每仓库一枚，sha256 哈希存全局 config） ----------
# 为什么用哈希而非 secretbox 加密：API Key 只需「校验」不需「还原明文」，
# 存单向哈希最安全——即便 config.json 泄露，攻击者也拿不到可用的原始 Key。
# 明文仅在生成时返回一次（前端负责提示用户妥善保存）。
# 存全局 config（始终文件存储、跨 file/sqlite/db 引擎一致），结构：
#   config["syncKeys"] = { <sha256(raw)>: {"u": 用户名, "vault": 仓库id, "prefix": 明文前缀, "created": 时间戳} }
# 历史 Key 无 vault 字段时视为绑定「默认仓库」。
SYNC_KEY_PREFIX = "ohs_"          # OmniHome Sync，便于识别与掩码展示
VAULT_DEFAULT = "default"
VAULT_SYSTEM = "system"
SYNC_LOG_MAX = 400


def _sync_key_hash(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def _sync_key_owner(v) -> str:
    """兼容取值：新结构为 dict({u,prefix,created})，容忍历史字符串结构。"""
    return v.get("u") if isinstance(v, dict) else v


def _sync_key_vault(v) -> str:
    if isinstance(v, dict):
        return v.get("vault") or VAULT_DEFAULT
    return VAULT_DEFAULT


def gen_sync_key(username: str, vault_id: str = VAULT_DEFAULT,
                 actor: Optional[str] = None) -> str:
    """为指定用户的指定仓库生成（或重置）同步 API Key，返回明文（仅此一次可见）。
    actor 为持钥人（团队成员钥的 u 仍是创建人）。同一 actor+仓库同时仅一枚。
    系统内置仓库禁止发令牌。"""
    vid = vault_id or VAULT_DEFAULT
    if vid == VAULT_SYSTEM:
        raise ValueError("系统内置仓库不可创建同步令牌")
    who = actor or username
    raw = SYNC_KEY_PREFIX + secrets.token_urlsafe(32)
    cfg = get_config()
    keys = {}
    for k, v in (cfg.get("syncKeys") or {}).items():
        act = v.get("actor") if isinstance(v, dict) else None
        act = act or _sync_key_owner(v)
        if act == who and _sync_key_vault(v) == vid:
            continue
        keys[k] = v
    keys[_sync_key_hash(raw)] = {"u": username, "vault": vid, "actor": who,
                                 "prefix": raw[:12], "created": int(time.time())}
    cfg["syncKeys"] = keys
    save_config(cfg)
    return raw


def verify_sync_key(raw: str) -> Optional[str]:
    """校验明文 API Key，命中返回所属用户名，否则 None。"""
    ctx = verify_sync_context(raw)
    return ctx["u"] if ctx else None


def verify_sync_context(raw: str) -> Optional[dict]:
    """校验明文 API Key，命中返回 {u, vault, actor}，否则 None。"""
    if not raw:
        return None
    v = (get_config().get("syncKeys") or {}).get(_sync_key_hash(raw))
    if not v:
        return None
    owner = _sync_key_owner(v)
    actor = v.get("actor") if isinstance(v, dict) else None
    return {"u": owner, "vault": _sync_key_vault(v), "actor": actor or owner}


def revoke_sync_key(username: str, vault_id: Optional[str] = None,
                    actor: Optional[str] = None):
    """吊销同步 API Key。
    actor 指定则只吊销该持钥人；vault_id 为空则吊销该 actor（默认本人）全部；
    若 actor 为空且 vault_id 有值：吊销「指向该仓库且 u=username」的全部钥（创建人解散团队仓）。"""
    cfg = get_config()
    keep = {}
    who = actor or username
    for k, v in (cfg.get("syncKeys") or {}).items():
        act = v.get("actor") if isinstance(v, dict) else None
        act = act or _sync_key_owner(v)
        store = _sync_key_owner(v)
        vid = _sync_key_vault(v)
        if actor:
            if act == who and (not vault_id or vid == vault_id):
                continue
        elif vault_id:
            if store == username and vid == vault_id:
                continue
        else:
            if act == username:
                continue
        keep[k] = v
    cfg["syncKeys"] = keep
    save_config(cfg)


def sync_key_info(username: str, vault_id: str = VAULT_DEFAULT) -> dict:
    """返回指定仓库、当前用户作为持钥人的掩码信息（不含明文）。"""
    vid = vault_id or VAULT_DEFAULT
    for v in (get_config().get("syncKeys") or {}).values():
        act = v.get("actor") if isinstance(v, dict) else None
        act = act or _sync_key_owner(v)
        if act == username and _sync_key_vault(v) == vid:
            prefix = v.get("prefix", "") if isinstance(v, dict) else ""
            created = v.get("created", 0) if isinstance(v, dict) else 0
            return {"enabled": True, "vault": vid, "prefix": prefix,
                    "masked": (prefix + "…") if prefix else "已启用",
                    "created": created}
    return {"enabled": False, "vault": vid, "prefix": "", "masked": "", "created": 0}


def list_sync_keys(username: str) -> list:
    """列出该用户作为持钥人的各仓库同步令牌（掩码，不含明文）。"""
    out = []
    for v in (get_config().get("syncKeys") or {}).values():
        act = v.get("actor") if isinstance(v, dict) else None
        act = act or _sync_key_owner(v)
        if act != username:
            continue
        prefix = v.get("prefix", "") if isinstance(v, dict) else ""
        created = v.get("created", 0) if isinstance(v, dict) else 0
        out.append({"vault": _sync_key_vault(v), "enabled": True,
                    "prefix": prefix, "masked": (prefix + "…") if prefix else "已启用",
                    "created": created, "store": _sync_key_owner(v)})
    return out


def owner_has_sync_key(owner: str, vault_id: str) -> bool:
    vid = vault_id or VAULT_DEFAULT
    for v in (get_config().get("syncKeys") or {}).values():
        act = v.get("actor") if isinstance(v, dict) else None
        act = act or _sync_key_owner(v)
        if _sync_key_owner(v) == owner and act == owner and _sync_key_vault(v) == vid:
            return True
    return False


def append_sync_log(username: str, entry: dict):
    """追加一条同步日志（最新在前，最多 SYNC_LOG_MAX 条）。"""
    logs = user_json(username, "notes/sync-log.json", [])
    if not isinstance(logs, list):
        logs = []
    rec = {
        "ts": int(entry.get("ts") or time.time()),
        "vault": entry.get("vault") or "",
        "source": entry.get("source") or "server",
        "level": entry.get("level") or "info",
        "msg": str(entry.get("msg") or "")[:500],
        "kind": str(entry.get("kind") or "")[:16],
        "title": str(entry.get("title") or "")[:120],
        "from": str(entry.get("from") or "")[:32],
        "to": str(entry.get("to") or "")[:32],
        "summary": str(entry.get("summary") or "")[:240],
        "path": str(entry.get("path") or "")[:240],
    }
    logs.insert(0, rec)
    save_user_json(username, "notes/sync-log.json", logs[:SYNC_LOG_MAX])


def read_sync_log(username: str, vault_id: Optional[str] = None, limit: int = 80) -> list:
    logs = user_json(username, "notes/sync-log.json", [])
    if not isinstance(logs, list):
        return []
    if vault_id:
        logs = [x for x in logs if (x or {}).get("vault") == vault_id]
    return logs[:max(1, min(int(limit or 80), SYNC_LOG_MAX))]


# ---------- 存储引擎配置 ----------
def storage_cfg() -> dict:
    return get_config().get("storage") or {"engine": "file", "url": ""}


def engine() -> str:
    return storage_cfg().get("engine", "file")


def _db_url_for(cfg: dict) -> str:
    eng = cfg.get("engine", "file")
    if eng == "sqlite":
        return "sqlite:///" + str(SQLITE_FILE)
    if eng == "db":
        return cfg.get("url", "")
    return ""



from store.db import (  # noqa: E402
    _sql_engine, _get_db, _reset_db, test_db_conn, ensure_db,
    _sql_read, _sql_write, _sql_delete, _sql_keys, _legacy,
    _TABLES, _sql_read_obj, _sql_write_rows_obj, _ROWS_KEYS,
)
from store.migrate import (  # noqa: E402
    _migrate_legacy, _file_clear_user, migrate_storage, _sql_stats_bytes,
)


def user_dir(username: str) -> Path:
    return USERS_DIR / username


def ensure_user_dir(username: str) -> Path:
    d = user_dir(username)
    if engine() == "file":
        (d / "notes").mkdir(parents=True, exist_ok=True)
    return d

# ---------- KV 读写（按引擎分发） ----------
def _kv_keys(username: str) -> list:
    """用户全部数据条目的 name 列表（不含备份目录）。"""
    if engine() == "file":
        d = user_dir(username)
        if not d.exists():
            return []
        return [p.relative_to(d).as_posix() for p in d.rglob("*")
                if p.is_file() and p.parts and p.parts[0] != "backups"
                and not p.name.endswith(".tmp")
                and not any(part.startswith(".") for part in p.parts)]
    with _get_db().connect() as conn:
        return _sql_keys(username, conn)


def _kv_read(username: str, name: str) -> Optional[str]:
    if engine() == "file":
        p = user_dir(username) / name
        try:
            return p.read_text(encoding="utf-8")
        except (FileNotFoundError, IsADirectoryError, UnicodeDecodeError):
            return None
    with _get_db().connect() as conn:
        content = _sql_read(username, name, conn)
        if content is not None:
            return content
        # 迁移未完成期间：新表无数据则回查旧表（双读兜底）
        if _legacy(conn):
            from sqlalchemy import text
            row = conn.execute(text(
                'SELECT "content" FROM "omni_kv" '
                'WHERE "username" = :u AND "name" = :n'),
                {"u": username, "n": name}).first()
            return row[0] if row else None
        return None


def _kv_write(username: str, name: str, content: str):
    if engine() == "file":
        _atomic_write(user_dir(username) / name, content)
        return
    with _lock:
        with _get_db().begin() as conn:
            _sql_write(username, name, content, conn)


def _kv_delete(username: str, name: str):
    if engine() == "file":
        p = user_dir(username) / name
        if p.is_file():
            p.unlink()
        return
    with _lock:
        with _get_db().begin() as conn:
            _sql_delete(username, name, conn)


def _kv_delete_user(username: str):
    if engine() == "file":
        d = user_dir(username)
        if d.exists():
            shutil.rmtree(d)
        return
    from sqlalchemy import text
    with _lock:
        with _get_db().begin() as conn:
            for key in _sql_keys(username, conn):
                _sql_delete(username, key, conn)
            try:
                conn.execute(text(
                    'DELETE FROM "omni_kv" WHERE "username" = :u'),
                             {"u": username})
            except Exception:
                pass  # 旧表已迁移删除


def user_file_exists(username: str, name: str) -> bool:
    return _kv_read(username, name) is not None


# ---------- 用户 JSON / 文本 ----------
def user_json(username: str, name: str, fallback):
    # SQL 行表直返对象：免 dumps(indent=2) -> loads 双重序列化。
    # 仅三个 obj 直读行表走此路径（folders 等行表 key 仍走 _kv_read）
    if engine() != "file" and name in ("bookmarks.json", "bookmark-cats.json",
                                       "calendar.json"):
        with _get_db().connect() as conn:
            obj = _sql_read_obj(conn, username, name)
            if obj is not None:
                return obj
        return fallback
    content = _kv_read(username, name)
    if content is None:
        return fallback
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return fallback


def save_user_json(username: str, name: str, obj):
    if engine() != "file" and name in _ROWS_KEYS:
        # 行表：SQL 引擎直传对象，避免序列化往返（文件引擎仍写可读 JSON）
        with _lock:
            with _get_db().begin() as conn:
                _sql_write_rows_obj(conn, username, name, obj)
        return
    _kv_write(username, name, json.dumps(obj, ensure_ascii=False, indent=2))


def user_text(username: str, name: str, fallback: str = "") -> str:
    content = _kv_read(username, name)
    return fallback if content is None else content


def save_user_text(username: str, name: str, content: str):
    _kv_write(username, name, content)


def delete_user_file(username: str, name: str):
    _kv_delete(username, name)


# ---------- 偏好 ----------
def get_prefs(username: str) -> dict:
    prefs = user_json(username, "prefs.json", {})
    merged = json.loads(json.dumps(DEFAULT_PREFS))
    for k, v in prefs.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    return merged


def save_prefs(username: str, prefs: dict):
    save_user_json(username, "prefs.json", prefs)


# ---------- 笔记 ----------
NOTE_ID = re.compile(r"^[\w\-]{1,64}$")


def notes_index(username: str) -> list:
    return user_json(username, "notes/index.json", [])


def save_notes_index(username: str, idx: list):
    save_user_json(username, "notes/index.json", idx)


def note_key(username: str, note_id: str) -> Optional[str]:
    if not NOTE_ID.match(note_id or ""):
        return None
    return f"notes/{note_id}.md"


def note_path(username: str, note_id: str) -> Optional[Path]:
    """仅文件引擎有效的物理路径；数据库引擎返回 None（调用方请用 note_* 接口）。"""
    key = note_key(username, note_id)
    return user_dir(username) / key if key else None


def note_exists(username: str, note_id: str) -> bool:
    key = note_key(username, note_id)
    return bool(key) and _kv_read(username, key) is not None


def note_read(username: str, note_id: str, fallback: str = "") -> str:
    key = note_key(username, note_id)
    if not key:
        return fallback
    content = _kv_read(username, key)
    return fallback if content is None else content


def note_write(username: str, note_id: str, content: str):
    key = note_key(username, note_id)
    if key:
        _kv_write(username, key, content)


def note_delete(username: str, note_id: str):
    key = note_key(username, note_id)
    if key:
        _kv_delete(username, key)
    _kv_delete(username, _note_revs_key(note_id))


NOTE_REV_MAX = 80
NOTE_REV_COALESCE = 120


def _note_revs_key(note_id: str) -> str:
    return "notes/revs/" + (note_id or "") + ".json"


def note_revs_load(username: str, note_id: str) -> list:
    data = user_json(username, _note_revs_key(note_id), [])
    return data if isinstance(data, list) else []


def note_revs_save(username: str, note_id: str, items: list):
    save_user_json(username, _note_revs_key(note_id), (items or [])[:NOTE_REV_MAX])


def note_rev_snapshot(username: str, note_id: str, content: str,
                      title: str = "", source: str = "web",
                      force: bool = False):
    """在覆盖正文前把旧内容记入历史。同来源 2 分钟内合并为一次会话，避免自动保存刷屏。"""
    if not note_key(username, note_id):
        return None
    body = content if content is not None else ""
    items = note_revs_load(username, note_id)
    if not force and not str(body).strip() and not items:
        return None
    now = int(time.time())
    src = "obsidian" if source == "obsidian" else "web"
    if items:
        last = items[0] if isinstance(items[0], dict) else {}
        if last.get("content") == body:
            return None
        if (not force and last.get("source") == src
                and (now - int(last.get("ts") or 0)) < NOTE_REV_COALESCE):
            return None
    rev = int((items[0] or {}).get("rev") or 0) + 1 if items else 1
    rec = {"rev": rev, "ts": now, "source": src,
           "title": str(title or "")[:120], "content": body}
    items.insert(0, rec)
    note_revs_save(username, note_id, items)
    return rec


def note_rev_get(username: str, note_id: str, rev: int):
    try:
        want = int(rev)
    except (TypeError, ValueError):
        return None
    for x in note_revs_load(username, note_id):
        if isinstance(x, dict) and int(x.get("rev") or 0) == want:
            return x
    return None


def note_revs_meta(username: str, note_id: str) -> list:
    out = []
    for x in note_revs_load(username, note_id):
        if not isinstance(x, dict):
            continue
        out.append({
            "rev": int(x.get("rev") or 0),
            "ts": int(x.get("ts") or 0),
            "source": x.get("source") or "web",
            "title": x.get("title") or "",
            "chars": len(x.get("content") or ""),
        })
    return out


# ---------- 笔记附件（图片等：KV 存 base64 载荷，天然随备份/迁移/清空走） ----------
def asset_write(username: str, name: str, payload: str):
    _kv_write(username, "notes/assets/" + name, payload)


def asset_read(username: str, name: str) -> Optional[str]:
    return _kv_read(username, "notes/assets/" + name)


def asset_delete(username: str, name: str):
    """删除附件（KV 级别）；若已不存在则静默成功"""
    _kv_delete(username, "notes/assets/" + name)


def asset_list(username: str) -> list:
    """用户名下全部附件名（随备份/迁移走，三引擎通用）。"""
    pref = "notes/assets/"
    return [k[len(pref):] for k in _kv_keys(username) if k.startswith(pref)]


# ---------- 备份（无论引擎，备份文件始终落盘在用户目录） ----------
def backup_dir(username: str) -> Path:
    d = user_dir(username) / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def create_backup(username: str, name: str) -> Path:
    """把用户数据打包为 zip（排除 backups 目录自身）。"""
    ts = time.strftime("%Y%m%d-%H%M%S")
    out = backup_dir(username) / f"{name}-{ts}.zip"
    with _lock:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            for key in _kv_keys(username):
                if key.startswith("backups/"):
                    continue
                content = _kv_read(username, key)
                if content is not None:
                    zf.writestr(key, content)
    return out


def restore_backup(username: str, name: str) -> int:
    """用备份 zip 覆盖当前数据（不含 backups 目录）。返回恢复条目数。"""
    path = backup_dir(username) / name
    if not path.exists():
        raise FileNotFoundError("备份不存在")
    with zipfile.ZipFile(path, "r") as zf:
        entries = [n for n in zf.namelist()
                   if not n.startswith("backups/") and not n.endswith("/")]
        if engine() == "file":
            d = user_dir(username)
            for key in _kv_keys(username):
                if key.startswith("backups/"):
                    continue
                _kv_delete(username, key)
            for n in entries:
                _atomic_write(d / n, zf.read(n).decode("utf-8", "replace"))
        else:
            _kv_delete_user(username)
            for n in entries:
                _kv_write(username, n, zf.read(n).decode("utf-8", "replace"))
    return len(entries)


def prune_backups(username: str, keep: int):
    """按修改时间保留最近 keep 份备份，更早的删除。keep<=0 表示不限制。"""
    if keep <= 0:
        return
    files = sorted(backup_dir(username).glob("*.zip"),
                   key=lambda p: p.stat().st_mtime)
    for old in files[:-keep] if len(files) > keep else []:
        try:
            old.unlink()
        except OSError:
            pass


# ---------- 清空用户数据（保留账号、偏好与备份） ----------
WIPE_EXACT = ("bookmarks.json", "bookmark-cats.json", "calendar.json",
              "vault.json", "plan.md")


def wipe_user_data(username: str):
    if engine() == "file":
        d = user_dir(username)
        for name in WIPE_EXACT:
            (d / name).unlink(missing_ok=True)
        shutil.rmtree(d / "notes", ignore_errors=True)
        (d / "notes").mkdir(exist_ok=True)
    else:
        for key in _kv_keys(username):
            if key in WIPE_EXACT or (key.startswith("notes/")
                                     and key != "notes/folders.json"):
                _kv_delete(username, key)
    # 清空后写入空书签文件，避免下次读取时重新播种默认书签
    save_user_json(username, "bookmarks.json", [])


def storage_stats(username: str) -> dict:
    if engine() == "file":
        d = user_dir(username)
        total = sum(p.stat().st_size for p in d.rglob("*") if p.is_file())
        notes = len([i for i in notes_index(username)])
        bookmarks = len(user_json(username, "bookmarks.json", []))
        vault = user_json(username, "vault.json", {})
        vault_items = len(vault.get("items", {}))
    else:
        from sqlalchemy import text
        with _get_db().connect() as conn:
            total = _sql_stats_bytes(conn, username)
            notes = (conn.execute(text(
                'SELECT COUNT(*) FROM "bm_notes" WHERE "username" = :u'),
                {"u": username}).scalar() or 0)
            bookmarks = (conn.execute(text(
                'SELECT COUNT(*) FROM "bm_bookmarks" '
                'WHERE "username" = :u'),
                {"u": username}).scalar() or 0)
            vault_items = (conn.execute(text(
                'SELECT COUNT(*) FROM "bm_vault_items" '
                'WHERE "username" = :u'),
                {"u": username}).scalar() or 0)
    return {
        "bytes": total,
        "notes": notes,
        "bookmarks": bookmarks,
        "vaultItems": vault_items,
        "backups": len(list(backup_dir(username).glob("*.zip"))),
    }
