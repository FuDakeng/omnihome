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
import json
import re
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

_lock = threading.Lock()

SAFE_NAME = re.compile(r"^[\w\u4e00-\u9fa5\-]{1,32}$")

DEFAULT_PREFS = {
    "theme": {"mode": "dark", "hue": 243, "sat": 72},
    "layout": {"compact": False, "reduceMotion": False},
    "locale": {"lang": "zh-CN", "weekStart": "mon", "tempUnit": "c"},
    "weather": {"city": "", "lat": 30.2741, "lon": 120.1552},
    "trashDays": 30,        # v0.2.15 增：回收站文件保留天数，0 = 永久（需手工清空）
}


def _atomic_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, obj):
    with _lock:
        _atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))


def read_text(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return fallback


def write_text(path: Path, content: str):
    with _lock:
        _atomic_write(path, content)


# ---------- 全局配置（始终文件存储） ----------
def get_config() -> dict:
    return read_json(CONFIG_FILE, {"users": {}, "createdAt": None})


def save_config(cfg: dict):
    write_json(CONFIG_FILE, cfg)


def valid_username(name: str) -> bool:
    return bool(SAFE_NAME.match(name or ""))


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


# ---------- 数据库层（模块化分表，SQLAlchemy） ----------
# 表结构定义（单一事实源）：cols=(列名, 通用类型, 是否NOT NULL)；
# TEXT 在 MySQL 下自动升级为 MEDIUMTEXT；索引内联进 CREATE TABLE。
# desc：表注释；列注释在 _COL_COMMENTS 中按列名统一定义。
# 注释仅 MySQL / PostgreSQL 支持（SQLite 无此语法，自动跳过）。
_COL_COMMENTS = {
    "username": "所属用户名（数据隔离维度）",
    "id": "条目唯一 ID",
    "name": "名称 / 文件名",
    "title": "标题",
    "url": "网址",
    "desc": "描述",
    "tags": "标签（JSON 数组）",
    "cat": "所属分类 ID",
    "hue": "图标色相（0-360）",
    "icon": "内置图标（sym:xxx）或空=自动站点图标",
    "builtin": "是否内置分类（1=全部/未分类）",
    "hidden": "是否隐藏（1=隐藏）",
    "pinned": "是否置顶（1=置顶）",
    "folder": "所属文件夹名",
    "payload": "整块 JSON 负载",
    "content": "正文（Markdown）",
    "vcheck": "主密钥校验串（密文）",
    "salt": "主密码派生盐",
    "pos": "排序位置",
    "updated": "更新时间戳（毫秒）",
    "hash": "内容指纹（增量同步去重）",
    "version": "迁移版本号",
    "done_at": "迁移完成时间戳（毫秒）",
}
_TABLES = {
    "bm_bookmarks": {
        "desc": "快捷导航·书签（磁贴：图标/名称/地址/描述/标签）",
        "cols": [("username", "VARCHAR(64)"), ("id", "VARCHAR(64)"),
                 ("name", "VARCHAR(255)"), ("url", "VARCHAR(1024)"),
                 ("desc", "TEXT"), ("tags", "TEXT"), ("cat", "VARCHAR(64)"),
                 ("hue", "INTEGER"), ("icon", "VARCHAR(64)"),
                 ("pos", "BIGINT"), ("updated", "BIGINT"),
                 ("hash", "VARCHAR(32)")],
        "pk": ["username", "id"],
        "idx": [("username", "cat"), ("username", "updated")],
    },
    "bm_cats": {
        "desc": "快捷导航·书签分类（含隐藏与排序）",
        "cols": [("username", "VARCHAR(64)"), ("id", "VARCHAR(64)"),
                 ("name", "VARCHAR(255)"), ("builtin", "INTEGER"),
                 ("hidden", "INTEGER"), ("pos", "BIGINT"), ("updated", "BIGINT"),
                 ("hash", "VARCHAR(32)")],
        "pk": ["username", "id"],
        "idx": [("username", "pos")],
    },
    "bm_notes": {
        "desc": "知识库·笔记（Markdown 正文/标签/文件夹）",
        "cols": [("username", "VARCHAR(64)"), ("id", "VARCHAR(64)"),
                 ("title", "VARCHAR(255)"), ("tags", "TEXT"),
                 ("pinned", "INTEGER"), ("folder", "VARCHAR(255)"),
                 ("pos", "BIGINT"), ("content", "TEXT"), ("updated", "BIGINT"),
                 ("deleted", "BIGINT"), ("deleted_title", "VARCHAR(255)")],
        "pk": ["username", "id"],
        "idx": [("username", "updated"), ("username", "pos")],
    },
    "bm_note_folders": {
        "desc": "知识库·笔记文件夹",
        "cols": [("username", "VARCHAR(64)"), ("name", "VARCHAR(255)"),
                 ("pos", "BIGINT"), ("updated", "BIGINT")],
        "pk": ["username", "name"],
        "idx": [],
    },
    "bm_calendar": {
        "desc": "日历·日程事件（负载含日期/时间/颜色）",
        "cols": [("username", "VARCHAR(64)"), ("id", "VARCHAR(64)"),
                 ("payload", "TEXT"), ("pos", "BIGINT"), ("updated", "BIGINT"),
                 ("hash", "VARCHAR(32)")],
        "pk": ["username", "id"],
        "idx": [("username", "updated")],
    },
    "bm_vault_meta": {
        "desc": "密码保险库·主密钥元数据（校验串/盐，不含明文）",
        "cols": [("username", "VARCHAR(64)"), ("vcheck", "TEXT"),
                 ("salt", "TEXT"), ("updated", "BIGINT")],
        "pk": ["username"],
        "idx": [],
    },
    "bm_vault_items": {
        "desc": "密码保险库·凭据条目（AES-256-GCM 密文负载）",
        "cols": [("username", "VARCHAR(64)"), ("id", "VARCHAR(255)"),
                 ("payload", "TEXT"), ("updated", "BIGINT")],
        "pk": ["username", "id"],
        "idx": [("username", "updated")],
    },
    "bm_prefs": {
        "desc": "用户偏好（主题/布局/语言区域）",
        "cols": [("username", "VARCHAR(64)"), ("payload", "TEXT"),
                 ("updated", "BIGINT")],
        "pk": ["username"], "idx": [],
    },
    "bm_dashboard": {
        "desc": "仪表盘布局（组件排序/收纳）",
        "cols": [("username", "VARCHAR(64)"), ("payload", "TEXT"),
                 ("updated", "BIGINT")],
        "pk": ["username"], "idx": [],
    },
    "bm_plan": {
        "desc": "今日计划（Markdown 正文）",
        "cols": [("username", "VARCHAR(64)"), ("payload", "TEXT"),
                 ("updated", "BIGINT")],
        "pk": ["username"], "idx": [],
    },
    "bm_ai": {
        "desc": "AI 智能配置（接口地址/模型，密钥仅存服务端）",
        "cols": [("username", "VARCHAR(64)"), ("payload", "TEXT"),
                 ("updated", "BIGINT")],
        "pk": ["username"], "idx": [],
    },
    "bm_backup_cfg": {
        "desc": "定时备份配置（开关/周期/保留份数）",
        "cols": [("username", "VARCHAR(64)"), ("payload", "TEXT"),
                 ("updated", "BIGINT")],
        "pk": ["username"], "idx": [],
    },
    # 未知 key 兜底表：保证迁移与恢复不丢任何数据（正常数据不会落到这里）
    "bm_misc": {
        "desc": "兜底存储（未知 key 迁移保底用，正常数据不落此表）",
        "cols": [("username", "VARCHAR(64)"), ("name", "VARCHAR(255)"),
                 ("content", "TEXT"), ("updated", "BIGINT")],
        "pk": ["username", "name"], "idx": [],
    },
    "bm_migrations": {
        "desc": "数据迁移记录（旧版单表迁移幂等标记）",
        "cols": [("version", "VARCHAR(32)"), ("done_at", "BIGINT")],
        "pk": ["version"], "idx": [],
    },
}

# 逻辑 key → 行表（列表型模块，逐行存储）
_ROWS_KEYS = {
    "bookmarks.json": "bm_bookmarks",
    "bookmark-cats.json": "bm_cats",
    "notes/folders.json": "bm_note_folders",
    "calendar.json": "bm_calendar",
}
# 逻辑 key → 文档表（单文档模块，单行存储）
_DOC_KEYS = {
    "prefs.json": "bm_prefs",
    "dashboard.json": "bm_dashboard",
    "plan.md": "bm_plan",
    "ai.json": "bm_ai",
    "backup.json": "bm_backup_cfg",
}

_db_engine = None
_db_url = None
_legacy_done = False   # 旧表 omni_kv 已迁移/不存在后置 True，避免重复探测


def _is_mysql(conn) -> bool:
    return conn.engine.dialect.name == "mysql"


def _esc_cmt(s: str) -> str:
    """转义注释中的单引号（SQL 字符串字面量）。"""
    return (s or "").replace("'", "''")


def _table_ddl(name: str, spec: dict, mysql: bool) -> str:
    q = lambda s: '"%s"' % s
    cols = []
    for c, t in spec["cols"]:
        typ = t
        if mysql and t == "TEXT":
            typ = "MEDIUMTEXT"
        elif mysql and t == "INTEGER":
            typ = "INT"
        col = f"{q(c)} {typ} NOT NULL"
        if mysql and _COL_COMMENTS.get(c):
            col += f" COMMENT '{_esc_cmt(_COL_COMMENTS[c])}'"
        cols.append(col)
    sql = (f"CREATE TABLE IF NOT EXISTS {q(name)} ({', '.join(cols)}, "
           f"PRIMARY KEY ({', '.join(q(c) for c in spec['pk'])}) ")
    if mysql:   # 仅 MySQL 支持 CREATE TABLE 内联索引与表注释
        for idx in spec["idx"]:
            sql += (f", INDEX {q('idx_%s_%s' % (name, idx[-1]))} "
                    f"({', '.join(q(c) for c in idx)})")
        if spec.get("desc"):
            sql += f") COMMENT='{_esc_cmt(spec['desc'])}'"
            return sql
    return sql + ")"


def _sync_comments(conn, dialect: str):
    """为已存在的表补注释（幂等）：MySQL 仅表级（列级需 MODIFY 重建列，风险高不做）；
    PostgreSQL 用 COMMENT ON 语句，表与列都覆盖。SQLite 无注释语法，跳过。"""
    from sqlalchemy import text
    q = lambda s: '"%s"' % s
    for name, spec in _TABLES.items():
        try:
            if dialect == "postgresql":
                if spec.get("desc"):
                    conn.execute(text(
                        f"COMMENT ON TABLE {q(name)} IS '{_esc_cmt(spec['desc'])}'"))
                for c, _ in spec["cols"]:
                    if _COL_COMMENTS.get(c):
                        conn.execute(text(
                            f"COMMENT ON COLUMN {q(name)}.{q(c)} IS "
                            f"'{_esc_cmt(_COL_COMMENTS[c])}'"))
            elif dialect == "mysql" and spec.get("desc"):
                conn.execute(text(
                    f"ALTER TABLE {q(name)} "
                    f"COMMENT='{_esc_cmt(spec['desc'])}'"))
        except Exception:
            pass   # 注释失败不影响建表与读写


def _has_column(conn, table: str, col: str) -> bool:
    """用 SELECT * ... LIMIT 0 的 cursor.description 判断列是否存在。
    不能用 SELECT <col> ... LIMIT 1：sqlite 对此宽松（列不存在也不报错），
    曾导致旧库补列逻辑被误跳过、新列永远补不上（v0.2.23 修复）。"""
    from sqlalchemy import text
    try:
        res = conn.execute(text('SELECT * FROM "%s" LIMIT 0' % table))
        return col in (res.keys() or [])
    except Exception:
        return False


def _ensure_tables(conn):
    mysql = _is_mysql(conn)
    from sqlalchemy import text
    for name, spec in _TABLES.items():
        conn.execute(text(_table_ddl(name, spec, mysql)))
    # 已存在的旧表补齐缺失列（幂等）：hash 指纹列、bm_notes 软删两列（回收站 v0.2.23）
    extra_cols = {"hash": "VARCHAR(32) NOT NULL DEFAULT ''"}
    notes_spec = dict(_TABLES["bm_notes"])
    for cname, ctype in notes_spec["cols"]:
        if cname in ("deleted", "deleted_title"):
            extra_cols[cname] = ctype
    for name, spec in _TABLES.items():
        for c, t in spec["cols"]:
            if c in extra_cols and not _has_column(conn, name, c):
                try:
                    conn.execute(text('ALTER TABLE "%s" ADD COLUMN "%s" %s'
                                      % (name, c, extra_cols[c])))
                except Exception:
                    pass
    if not mysql:   # SQLite / PostgreSQL：建表后单独建索引（幂等）
        for name, spec in _TABLES.items():
            for idx in spec["idx"]:
                conn.execute(text(
                    f'CREATE INDEX IF NOT EXISTS "idx_{name}_{idx[-1]}" '
                    f'ON "{name}" ({", ".join("%s" % c for c in idx)})'))
    _sync_comments(conn, conn.engine.dialect.name)


def _upsert_sql(table: str, cols: list, pk: list, conn):
    """生成 INSERT ... ON CONFLICT / ON DUPLICATE KEY UPDATE 语句（返回 text 对象）。"""
    from sqlalchemy import text
    q = lambda s: '"%s"' % s
    params = ", ".join(f":{c}" for c in cols)
    qcols = ", ".join(q(c) for c in cols)
    if _is_mysql(conn):
        assigns = ", ".join(f"{q(c)} = VALUES({q(c)})"
                            for c in cols if c not in pk)
        sql = (f"INSERT INTO {q(table)} ({qcols}) VALUES ({params}) "
               f"ON DUPLICATE KEY UPDATE {assigns}")
    else:
        assigns = ", ".join(f"{q(c)} = excluded.{q(c)}"
                            for c in cols if c not in pk)
        sql = (f"INSERT INTO {q(table)} ({qcols}) VALUES ({params}) "
               f"ON CONFLICT ({', '.join(q(c) for c in pk)}) "
               f"DO UPDATE SET {assigns}")
    return text(sql)


def _sql_delete_ids(conn, table: str, username: str, id_col: str, ids: list):
    """按 id 集合批量删除（分批，避开 SQLite 999 参数上限）。"""
    from sqlalchemy import text
    batch = []
    for sid in ids:
        batch.append(sid)
        if len(batch) >= 500:
            _sql_delete_ids_batch(conn, table, username, id_col, batch)
            batch = []
    if batch:
        _sql_delete_ids_batch(conn, table, username, id_col, batch)


def _sql_delete_ids_batch(conn, table: str, username: str, id_col: str, ids: list):
    from sqlalchemy import text
    ph = ", ".join(":d%d" % i for i in range(len(ids)))
    conn.execute(text('DELETE FROM "%s" WHERE "username" = :u AND "%s" IN (%s)'
                      % (table, id_col, ph)),
                 {"u": username,
                  **{"d%d" % i: v for i, v in enumerate(ids)}})


def _row_hash(params: dict, diff_cols: list) -> str:
    """行内容指纹：diff 列按稳定顺序拼接后 MD5（供增量对比）。"""
    import hashlib
    return hashlib.md5("\x1f".join(
        str(params.get(c, "")) for c in diff_cols).encode("utf-8")).hexdigest()


def _sql_rows_upsert(conn, table: str, username: str, cols: list, pk: list,
                     id_col: str, params: list, diff_cols: Optional[list] = None):
    """行表增量写：内容级 diff，仅 upsert 实际变化的行，避免整段重写。
    diff_cols 为参与内容对比的列（默认全部业务列，updated 等时间列自动排除）；
    删除按 id 集合差集处理（分批，避开 SQLite 999 参数上限）。"""
    from sqlalchemy import text
    if diff_cols is None:
        diff_cols = [c for c in cols
                     if c not in (id_col, "username", "updated", "hash")]
    rows = conn.execute(text(
        'SELECT "%s", "hash" FROM "%s" WHERE "username" = :u'
        % (id_col, table)),
        {"u": username}).fetchall()
    existing = {r[0]: r[1] or "" for r in rows}
    new_ids = set(p[id_col] for p in params)
    stale = existing.keys() - new_ids
    if stale:
        _sql_delete_ids(conn, table, username, id_col, sorted(stale))
    fresh, kept = [], []
    for p in params:
        if p[id_col] not in existing:
            fresh.append(p)
        elif p.get("hash") != existing[p[id_col]]:
            kept.append(p)
    if fresh:
        ph = ", ".join(":%s" % c for c in cols)
        conn.execute(text("INSERT INTO %s (%s) VALUES (%s)"
                          % (table, ", ".join('"%s"' % c for c in cols), ph)),
                     fresh)
    if kept:
        conn.execute(_upsert_sql(table, cols, pk, conn), kept)


def _has_table(conn, name: str) -> bool:
    from sqlalchemy import text
    try:
        conn.execute(text(f'SELECT 1 FROM "{name}" LIMIT 1'))
        return True
    except Exception:
        return False


def _legacy(conn) -> bool:
    """旧单表 omni_kv 是否仍在使用（迁移尚未完成）。"""
    global _legacy_done
    if _legacy_done:
        return False
    if not _has_table(conn, "omni_kv"):
        _legacy_done = True
        return False
    from sqlalchemy import text
    row = conn.execute(text('SELECT 1 FROM "bm_migrations" LIMIT 1')).first()
    if row is not None:
        _legacy_done = True
        return False
    return True


def _sql_engine(url: str):
    """为指定连接串创建引擎、确保表存在，并自动迁移旧版单表数据。"""
    from sqlalchemy import create_engine, text
    kwargs = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        Path(url.replace("sqlite:///", "")).parent.mkdir(parents=True, exist_ok=True)
        kwargs["connect_args"] = {"check_same_thread": False}
    eng = create_engine(url, **kwargs)
    with eng.begin() as conn:
        if url.startswith("sqlite"):
            try:
                conn.execute(text("PRAGMA journal_mode=WAL"))
            except Exception:
                pass
        _ensure_tables(conn)
    _migrate_legacy(eng)
    return eng


def _get_db():
    """当前引擎的数据库连接（惰性创建，配置切换后由 _reset_db 重置）。"""
    global _db_engine, _db_url
    url = _db_url_for(storage_cfg())
    if not url:
        raise RuntimeError("数据库存储未配置连接")
    if _db_engine is not None and url == _db_url:
        return _db_engine
    if _db_engine is not None:
        try:
            _db_engine.dispose()
        except Exception:
            pass
    _db_engine = _sql_engine(url)
    _db_url = url
    return _db_engine


def _reset_db():
    global _db_engine, _db_url, _legacy_done
    if _db_engine is not None:
        try:
            _db_engine.dispose()
        except Exception:
            pass
    _db_engine, _db_url = None, None
    _legacy_done = False


def test_db_conn(url: str):
    """测试外部数据库连接是否可用（连接并执行 SELECT 1）。"""
    from sqlalchemy import create_engine, text
    eng = create_engine(url)
    try:
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
    finally:
        eng.dispose()


def ensure_db():
    """当前引擎为数据库时建立连接并触发旧表迁移（幂等，供启动时调用）。"""
    if engine() in ("sqlite", "db"):
        _get_db()


# ---------- 用户目录（文件引擎使用） ----------
def user_dir(username: str) -> Path:
    return USERS_DIR / username


def ensure_user_dir(username: str) -> Path:
    d = user_dir(username)
    if engine() == "file":
        (d / "notes").mkdir(parents=True, exist_ok=True)
    return d


# ---------- SQL 模块读写（绑定连接，conn 为 None 时由 _kv_* 自行管理） ----------
def _sql_read_bookmarks_obj(conn, username: str) -> list:
    from sqlalchemy import text
    rows = conn.execute(text(
        'SELECT "id", "name", "url", "desc", "tags", "cat", "hue", "icon", '
        '"pos" FROM "bm_bookmarks" WHERE "username" = :u '
        'ORDER BY "pos", "id"'),
        {"u": username}).fetchall()
    out = []
    for r in rows:
        try:
            tags = json.loads(r.tags) if r.tags else []
        except json.JSONDecodeError:
            tags = []
        out.append({"id": r.id, "name": r.name, "url": r.url,
                    "desc": r.desc or "", "tags": tags, "cat": r.cat,
                    "hue": r.hue, "icon": r.icon or "", "order": r.pos})
    return out


def _sql_read_bookmarks(conn, username: str) -> str:
    return json.dumps(_sql_read_bookmarks_obj(conn, username),
                      ensure_ascii=False, indent=2)


def _sql_read_obj(conn, username: str, key: str):
    """行表对象直读（bookmarks/cats/calendar），非行表返回 None。"""
    if key == "bookmarks.json":
        return _sql_read_bookmarks_obj(conn, username)
    if key == "bookmark-cats.json":
        return _sql_read_cats_obj(conn, username)
    if key == "calendar.json":
        return _sql_read_calendar_obj(conn, username)
    return None


def _sql_write_rows_obj(conn, username: str, key: str, obj):
    """行表直传对象写入（bookmarks / cats / calendar）。"""
    if key == "bookmarks.json":
        _sql_write_bookmarks_obj(conn, username, obj)
    elif key == "bookmark-cats.json":
        _sql_write_cats_obj(conn, username, obj)
    elif key == "calendar.json":
        _sql_write_calendar_obj(conn, username, obj)
    else:
        _sql_write(username, key, json.dumps(obj, ensure_ascii=False), conn)


def _sql_write_bookmarks(conn, username: str, content: str):
    try:
        arr = json.loads(content) if content and content.strip() else []
    except json.JSONDecodeError:
        arr = []
    _sql_write_bookmarks_obj(conn, username, arr)


def _sql_write_bookmarks_obj(conn, username: str, arr):
    t = int(time.time())
    params = []
    for i, b in enumerate(arr):
        if not isinstance(b, dict):
            continue
        params.append({
            "username": username, "id": str(b.get("id") or "x%d" % i),
            "name": b.get("name") or "", "url": b.get("url") or "",
            "desc": b.get("desc") or "",
            "tags": json.dumps(b.get("tags") or [], ensure_ascii=False),
            "cat": b.get("cat") or "", "hue": int(b.get("hue") or 0),
            "icon": b.get("icon") or "", "pos": int(b.get("order", i)),
            "updated": t})
    for p in params:
        p["hash"] = _row_hash(p, ["name", "url", "desc", "tags", "cat",
                                  "hue", "icon", "pos"])
    _sql_rows_upsert(conn, "bm_bookmarks", username,
                     ["username", "id", "name", "url", "desc", "tags",
                      "cat", "hue", "icon", "pos", "updated", "hash"],
                     ["username", "id"], "id", params)


def _sql_read_cats_obj(conn, username: str) -> list:
    from sqlalchemy import text
    rows = conn.execute(text(
        'SELECT "id", "name", "builtin", "hidden" FROM "bm_cats" '
        'WHERE "username" = :u ORDER BY "pos", "id"'),
        {"u": username}).fetchall()
    out = []
    for r in rows:
        item = {"id": r.id, "name": r.name}
        if r.builtin:
            item["builtin"] = True
        if r.hidden:
            item["hidden"] = True
        out.append(item)
    return out


def _sql_read_cats(conn, username: str) -> str:
    return json.dumps(_sql_read_cats_obj(conn, username),
                      ensure_ascii=False, indent=2)


def _sql_write_cats(conn, username: str, content: str):
    try:
        arr = json.loads(content) if content and content.strip() else []
    except json.JSONDecodeError:
        arr = []
    _sql_write_cats_obj(conn, username, arr)


def _sql_write_cats_obj(conn, username: str, arr):
    t = int(time.time())
    params = [{"username": username, "id": str(c.get("id") or "x%d" % i),
               "name": c.get("name") or "",
               "builtin": 1 if c.get("builtin") else 0,
               "hidden": 1 if c.get("hidden") else 0,
               "pos": i, "updated": t}
              for i, c in enumerate(arr) if c.get("id")]
    for p in params:
        p["hash"] = _row_hash(p, ["name", "builtin", "hidden", "pos"])
    _sql_rows_upsert(conn, "bm_cats", username,
                     ["username", "id", "name", "builtin", "hidden",
                      "pos", "updated", "hash"],
                     ["username", "id"], "id", params)


def _sql_read_folders(conn, username: str) -> str:
    from sqlalchemy import text
    rows = conn.execute(text(
        'SELECT "name" FROM "bm_note_folders" WHERE "username" = :u '
        'ORDER BY "pos", "name"'), {"u": username}).fetchall()
    return json.dumps([r.name for r in rows], ensure_ascii=False, indent=2)


def _sql_write_folders(conn, username: str, content: str):
    from sqlalchemy import text
    conn.execute(text('DELETE FROM "bm_note_folders" WHERE "username" = :u'),
                 {"u": username})
    try:
        arr = json.loads(content) if content and content.strip() else []
    except json.JSONDecodeError:
        arr = []
    # 保序去重：文件夹名是主键 (username, name) 的组成部分，重复名会触发
    # UniqueViolation（如旧版「速记」改名合并到「灵感速记」时两者并存）。
    # 落库前必须合并，否则整批 INSERT 失败 → list_notes 稳定 500。
    seen, names = set(), []
    for n in arr:
        name = str(n)
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    if not names:
        return
    t = int(time.time())
    params = [{"u": username, "name": name, "pos": i, "t": t}
              for i, name in enumerate(names)]
    conn.execute(text(
        'INSERT INTO "bm_note_folders" '
        '("username", "name", "pos", "updated") '
        "VALUES (:u, :name, :pos, :t)"), params)


def _sql_read_calendar_obj(conn, username: str) -> list:
    from sqlalchemy import text
    payloads = [r[0] for r in conn.execute(text(
        'SELECT "payload" FROM "bm_calendar" WHERE "username" = :u '
        'ORDER BY "pos", "id"'), {"u": username}).fetchall()]
    if not payloads:
        return []
    try:  # 整段拼接一次解析（payload 均为本层写入的合法 JSON）
        return json.loads("[" + ",".join(payloads) + "]")
    except json.JSONDecodeError:  # 兜底：逐行容错解析
        out = []
        for p in payloads:
            try:
                out.append(json.loads(p))
            except (json.JSONDecodeError, TypeError):
                continue
        return out


def _sql_read_calendar(conn, username: str) -> str:
    return json.dumps(_sql_read_calendar_obj(conn, username),
                      ensure_ascii=False, indent=2)


def _sql_write_calendar(conn, username: str, content: str):
    try:
        arr = json.loads(content) if content and content.strip() else []
    except json.JSONDecodeError:
        arr = []
    _sql_write_calendar_obj(conn, username, arr)


def _sql_write_calendar_obj(conn, username: str, arr):
    t = int(time.time())
    params = []
    for i, ev in enumerate(arr):
        if not isinstance(ev, dict):
            continue
        params.append({"username": username,
                       "id": str(ev.get("id") or "x%d" % i),
                       "payload": json.dumps(ev, ensure_ascii=False),
                       "pos": i, "updated": t})
    for p in params:
        p["hash"] = _row_hash(p, ["payload", "pos"])
    _sql_rows_upsert(conn, "bm_calendar", username,
                     ["username", "id", "payload", "pos", "updated",
                      "hash"],
                     ["username", "id"], "id", params)


def _sql_read_vault(conn, username: str) -> str:
    from sqlalchemy import text
    meta = conn.execute(text(
        'SELECT "vcheck", "salt", "updated" FROM "bm_vault_meta" '
        'WHERE "username" = :u'), {"u": username}).first()
    rows = conn.execute(text(
        'SELECT "id", "payload" FROM "bm_vault_items" '
        'WHERE "username" = :u'),
        {"u": username}).fetchall()
    items = {}
    for r in rows:
        try:
            items[r.id] = json.loads(r.payload)
        except (json.JSONDecodeError, TypeError):
            items[r.id] = r.payload
    out = {"check": meta.vcheck if meta else None,
           "salt": meta.salt if meta else None,
           "items": items,
           "updatedAt": meta.updated if meta else 0}
    return json.dumps(out, ensure_ascii=False, indent=2)


def _sql_write_vault(conn, username: str, content: str):
    from sqlalchemy import text
    try:
        obj = json.loads(content) if content and content.strip() else {}
    except json.JSONDecodeError:
        obj = {}
    items = obj.get("items") if isinstance(obj, dict) else None
    conn.execute(text('DELETE FROM "bm_vault_items" WHERE "username" = :u'),
                 {"u": username})
    if isinstance(items, dict) and items:
        t = int(time.time())
        params = [{"u": username, "id": str(k),
                   "payload": json.dumps(v, ensure_ascii=False), "t": t}
                  for k, v in items.items()]
        conn.execute(text(
            'INSERT INTO "bm_vault_items" '
            '("username", "id", "payload", "updated") '
            "VALUES (:u, :id, :payload, :t)"), params)
    t = int(time.time())
    conn.execute(_upsert_sql("bm_vault_meta",
                             ["username", "vcheck", "salt", "updated"],
                             ["username"], conn),
                 {"username": username, "vcheck": obj.get("check"),
                  "salt": obj.get("salt"), "updated": t})


def _sql_read_notes_index(conn, username: str) -> str:
    from sqlalchemy import text
    rows = conn.execute(text(
        'SELECT "id", "title", "tags", "pinned", "folder", "updated", '
        '"deleted", "deleted_title" '
        'FROM "bm_notes" WHERE "username" = :u ORDER BY "pos", "id"'),
        {"u": username}).fetchall()
    out = []
    for r in rows:
        try:
            tags = json.loads(r.tags) if r.tags else []
        except json.JSONDecodeError:
            tags = []
        item = {"id": r.id, "title": r.title, "tags": tags,
                "pinned": bool(r.pinned), "folder": r.folder or "",
                "updated": r.updated}
        # 软删字段（回收站）：列可能尚不存在（旧库未补列），兜底 0/None
        try: item["deleted"] = int(r.deleted) if r.deleted else 0
        except (AttributeError, TypeError, ValueError): item["deleted"] = 0
        try: item["deleted_title"] = r.deleted_title or ""
        except AttributeError: item["deleted_title"] = ""
        out.append(item)
    return json.dumps(out, ensure_ascii=False, indent=2)


def _sql_write_notes_index(conn, username: str, content: str):
    from sqlalchemy import text
    try:
        idx = json.loads(content) if content and content.strip() else []
    except json.JSONDecodeError:
        idx = []
    if not idx:
        return
    params = []
    for i, item in enumerate(idx):
        if not isinstance(item, dict) or not item.get("id"):
            continue
        params.append({"u": username, "id": str(item["id"]),
                       "title": item.get("title") or "",
                       "tags": json.dumps(item.get("tags") or [],
                                          ensure_ascii=False),
                       "pinned": 1 if item.get("pinned") else 0,
                       "folder": (item.get("folder") or "")[:255],
                       "pos": i,
                       "t": int(item.get("updated") or time.time()),
                       "deleted": int(item.get("deleted") or 0),
                       "deleted_title": (item.get("deleted_title") or "")[:255]})
    if params:
        sql = ('INSERT INTO "bm_notes" '
               '("username", "id", "title", "tags", "pinned", '
               '"folder", "pos", "updated", "content", "deleted", "deleted_title") '
               "VALUES (:u, :id, :title, :tags, :pinned, :folder, :pos, :t, '', "
               ":deleted, :deleted_title)")
        if _is_mysql(conn):
            sql += (" ON DUPLICATE KEY UPDATE \"title\" = VALUES(\"title\"), "
                    "\"tags\" = VALUES(\"tags\"), "
                    "\"pinned\" = VALUES(\"pinned\"), "
                    "\"folder\" = VALUES(\"folder\"), "
                    "\"pos\" = VALUES(\"pos\"), "
                    "\"updated\" = VALUES(\"updated\"), "
                    "\"deleted\" = VALUES(\"deleted\"), "
                    "\"deleted_title\" = VALUES(\"deleted_title\")")
        else:
            sql += (' ON CONFLICT ("username", "id") DO UPDATE SET '
                    '"title" = excluded."title", "tags" = excluded."tags", '
                    '"pinned" = excluded."pinned", '
                    '"folder" = excluded."folder", "pos" = excluded."pos", '
                    '"updated" = excluded."updated", '
                    '"deleted" = excluded."deleted", '
                    '"deleted_title" = excluded."deleted_title"')
        conn.execute(text(sql), params)


def _note_id_of(key: str) -> Optional[str]:
    if key.startswith("notes/") and key.endswith(".md"):
        nid = key[len("notes/"):-len(".md")]
        return nid if nid else None
    return None


def _sql_read_note_body(conn, username: str, key: str) -> Optional[str]:
    nid = _note_id_of(key)
    if not nid:
        return None
    from sqlalchemy import text
    row = conn.execute(text(
        'SELECT "content" FROM "bm_notes" '
        'WHERE "username" = :u AND "id" = :n'),
        {"u": username, "n": nid}).first()
    return row[0] if row else None


def _sql_write_note_body(conn, username: str, key: str, content: str):
    nid = _note_id_of(key)
    if not nid:
        return
    from sqlalchemy import text
    # INSERT 补齐元数据列默认值（新行首写正文时行可能尚不存在）；
    # 冲突时仅更新正文与时间，不覆盖标题/标签/排序等元数据。
    sql = ('INSERT INTO "bm_notes" '
           '("username", "id", "content", "updated", "title", '
           '"tags", "pinned", "folder", "pos") '
           "VALUES (:username, :id, :c, :t, '', '', 0, '', 0)")
    if _is_mysql(conn):
        sql += (" ON DUPLICATE KEY UPDATE \"content\" = VALUES(\"content\"), "
                "\"updated\" = VALUES(\"updated\")")
    else:
        sql += (' ON CONFLICT ("username", "id") DO UPDATE SET '
                '"content" = excluded."content", '
                '"updated" = excluded."updated"')
    conn.execute(text(sql),
                 {"username": username, "id": nid, "c": content,
                  "t": int(time.time())})


def _sql_read_doc(conn, table: str, username: str) -> Optional[str]:
    from sqlalchemy import text
    row = conn.execute(text(
        f'SELECT "payload" FROM "{table}" WHERE "username" = :u'),
        {"u": username}).first()
    return row[0] if row else None


def _sql_write_doc(conn, table: str, username: str, content: str):
    conn.execute(_upsert_sql(table, ["username", "payload", "updated"],
                             ["username"], conn),
                 {"username": username, "payload": content,
                  "updated": int(time.time())})


def _sql_read(username: str, key: str, conn) -> Optional[str]:
    """按模块路由读取逻辑 key（返回文本或 None）。"""
    if key in _ROWS_KEYS:
        table = _ROWS_KEYS[key]
        if table == "bm_bookmarks":
            return _sql_read_bookmarks(conn, username)
        if table == "bm_cats":
            return _sql_read_cats(conn, username)
        if table == "bm_note_folders":
            return _sql_read_folders(conn, username)
        return _sql_read_calendar(conn, username)
    if key == "notes/index.json":
        return _sql_read_notes_index(conn, username)
    if _note_id_of(key):
        return _sql_read_note_body(conn, username, key)
    if key == "vault.json":
        return _sql_read_vault(conn, username)
    if key in _DOC_KEYS:
        return _sql_read_doc(conn, _DOC_KEYS[key], username)
    # 未知 key → 兜底表
    from sqlalchemy import text
    row = conn.execute(text(
        'SELECT "content" FROM "bm_misc" '
        'WHERE "username" = :u AND "name" = :n'),
        {"u": username, "n": key}).first()
    return row[0] if row else None


def _sql_write(username: str, key: str, content: str, conn):
    """按模块路由写入（conn 由调用方提供，事务由调用方管理）。"""
    if key in _ROWS_KEYS:
        table = _ROWS_KEYS[key]
        if table == "bm_bookmarks":
            _sql_write_bookmarks(conn, username, content)
        elif table == "bm_cats":
            _sql_write_cats(conn, username, content)
        elif table == "bm_note_folders":
            _sql_write_folders(conn, username, content)
        else:
            _sql_write_calendar(conn, username, content)
    elif key == "notes/index.json":
        _sql_write_notes_index(conn, username, content)
    elif _note_id_of(key):
        _sql_write_note_body(conn, username, key, content)
    elif key == "vault.json":
        _sql_write_vault(conn, username, content)
    elif key in _DOC_KEYS:
        _sql_write_doc(conn, _DOC_KEYS[key], username, content)
    else:
        from sqlalchemy import text
        conn.execute(_upsert_sql("bm_misc", ["username", "name", "content",
                                             "updated"],
                                 ["username", "name"], conn),
                     {"username": username, "name": key,
                      "content": content, "updated": int(time.time())})
    # 迁移未完成期间同步清理旧表对应行，保证数据源一致
    if _legacy(conn):
        from sqlalchemy import text
        conn.execute(text(
            'DELETE FROM "omni_kv" WHERE "username" = :u AND "name" = :n'),
            {"u": username, "n": key})


def _sql_delete(username: str, key: str, conn):
    from sqlalchemy import text
    if key in _ROWS_KEYS:
        conn.execute(text(
            f'DELETE FROM "{_ROWS_KEYS[key]}" WHERE "username" = :u'),
            {"u": username})
    elif key == "notes/index.json":
        conn.execute(text('DELETE FROM "bm_notes" WHERE "username" = :u'),
                     {"u": username})
    elif _note_id_of(key):
        conn.execute(text(
            'DELETE FROM "bm_notes" WHERE "username" = :u AND "id" = :n'),
            {"u": username, "n": _note_id_of(key)})
    elif key == "vault.json":
        conn.execute(text(
            'DELETE FROM "bm_vault_meta" WHERE "username" = :u'),
            {"u": username})
        conn.execute(text(
            'DELETE FROM "bm_vault_items" WHERE "username" = :u'),
            {"u": username})
    elif key in _DOC_KEYS:
        conn.execute(text(
            f'DELETE FROM "{_DOC_KEYS[key]}" WHERE "username" = :u'),
            {"u": username})
    else:
        conn.execute(text(
            'DELETE FROM "bm_misc" WHERE "username" = :u AND "name" = :n'),
            {"u": username, "n": key})
    if _legacy(conn):
        conn.execute(text(
            'DELETE FROM "omni_kv" WHERE "username" = :u AND "name" = :n'),
            {"u": username, "n": key})


def _sql_keys(username: str, conn) -> list:
    from sqlalchemy import text
    keys = []
    for key, table in _ROWS_KEYS.items():
        if conn.execute(text(
                f'SELECT 1 FROM "{table}" WHERE "username" = :u LIMIT 1'),
                {"u": username}).first():
            keys.append(key)
    if conn.execute(text(
            'SELECT 1 FROM "bm_notes" WHERE "username" = :u LIMIT 1'),
            {"u": username}).first():
        keys.append("notes/index.json")
        rows = conn.execute(text(
            'SELECT "id" FROM "bm_notes" WHERE "username" = :u'),
            {"u": username}).fetchall()
        keys += [f"notes/{r.id}.md" for r in rows]
    for table in ("bm_vault_meta", "bm_vault_items"):
        if conn.execute(text(
                f'SELECT 1 FROM "{table}" WHERE "username" = :u LIMIT 1'),
                {"u": username}).first():
            keys.append("vault.json")
            break
    for key, table in _DOC_KEYS.items():
        if conn.execute(text(
                f'SELECT 1 FROM "{table}" WHERE "username" = :u LIMIT 1'),
                {"u": username}).first():
            keys.append(key)
    rows = conn.execute(text(
        'SELECT "name" FROM "bm_misc" WHERE "username" = :u'),
        {"u": username}).fetchall()
    keys += [r.name for r in rows]
    if _legacy(conn):
        rows = conn.execute(text(
            'SELECT "name" FROM "omni_kv" WHERE "username" = :u'),
            {"u": username}).fetchall()
        seen = set(keys)
        keys += [r.name for r in rows if r.name not in seen]
    return keys


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
        with _lock:
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


# ---------- 旧版单表自动迁移（无损，失败可回滚） ----------
def _migrate_legacy(eng):
    """把旧单表 omni_kv 的数据迁移到模块分表。

    迁移前把全量数据落盘为快照备份文件；迁移在单事务内完成（建表 → 逐条解析
    写入新表 → 记录版本 → 删除旧表），任何异常整体回滚，旧表原封不动；
    失败时仅告警，读写层自动走「新表为主、旧表兜底」的双读路径继续运行。
    """
    from sqlalchemy import text
    try:
        with eng.connect() as conn:
            if not _has_table(conn, "omni_kv"):
                return
            if conn.execute(text(
                    'SELECT 1 FROM "bm_migrations" LIMIT 1')).first():
                return
            rows = conn.execute(text(
                'SELECT "username", "name", "content" FROM "omni_kv"')).fetchall()
        if not rows:
            with eng.begin() as conn:
                conn.execute(text(
                    'INSERT INTO "bm_migrations" ("version", "done_at") '
                    "VALUES ('1', :t)"), {"t": int(time.time())})
                conn.execute(text('DROP TABLE "omni_kv"'))
            return
        # 1. 迁移前自动备份：全量快照落盘（不依赖用户备份配置）
        snap: dict = {}
        for u, n, c in rows:
            snap.setdefault(u, {})[n] = c
        bak = DATA_DIR / ("migration-backup-" +
                          time.strftime("%Y%m%d-%H%M%S") + ".json")
        bak.write_text(json.dumps(snap, ensure_ascii=False, indent=1),
                       encoding="utf-8")
        # 2. 单事务迁移：失败整体回滚，旧表原封不动
        with eng.begin() as conn:
            for u, items in snap.items():
                for k, v in items.items():
                    _sql_write(u, k, v, conn)
            conn.execute(text(
                'INSERT INTO "bm_migrations" ("version", "done_at") '
                "VALUES ('1', :t)"), {"t": int(time.time())})
            conn.execute(text('DROP TABLE "omni_kv"'))
    except Exception as exc:  # 迁移失败：回滚 + 双读兜底，不影响服务
        print(f"[storage] omni_kv 迁移失败，已回滚：{exc}", flush=True)


# ---------- 存储引擎迁移 ----------
def _file_clear_user(username: str):
    """清空文件引擎下某用户的全部数据（保留 backups 备份目录）。"""
    d = user_dir(username)
    if not d.exists():
        return
    for p in d.iterdir():
        if p.name == "backups":
            continue
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


def _sql_clear_user(conn, username: str):
    """清空 SQL 引擎下某用户在全部模块表中的行（同事务，供迁移前清理）。"""
    from sqlalchemy import text
    for name, spec in _TABLES.items():
        if "username" not in dict(spec["cols"]):
            continue  # bm_migrations 等系统表无用户维度
        conn.execute(text(
            f'DELETE FROM "{name}" WHERE "username" = :u'),
                     {"u": username})


def migrate_storage(target_engine: str, url: str = "") -> int:
    """把全部用户数据从当前引擎迁移到目标引擎，成功后切换配置。
    返回迁移的条目数。目标为外部数据库时先验证连接。"""
    if target_engine not in ("file", "sqlite", "db"):
        raise ValueError("不支持的存储引擎")
    if target_engine == "db" and not url:
        raise ValueError("外部数据库需要连接串")
    # 1. 读快照（含外部数据库连通性验证）
    if target_engine == "db":
        test_db_conn(url)
    cfg = get_config()
    users = list(cfg.get("users", {}).keys())
    snapshot = {}
    for u in users:
        snapshot[u] = {k: _kv_read(u, k) for k in _kv_keys(u)}
        snapshot[u] = {k: v for k, v in snapshot[u].items() if v is not None}
    # 2. 写入目标（先清空该用户旧数据，避免残留 key 混入；再按模块路由写入）
    if target_engine == "file":
        for u, items in snapshot.items():
            _file_clear_user(u)
            for k, v in items.items():
                _atomic_write(user_dir(u) / k, v)
    else:
        dst_url = "sqlite:///" + str(SQLITE_FILE) if target_engine == "sqlite" else url
        dst_eng = _sql_engine(dst_url)
        try:
            with dst_eng.begin() as conn:
                for u, items in snapshot.items():
                    _sql_clear_user(conn, u)
                    for k, v in items.items():
                        _sql_write(u, k, v, conn)
        finally:
            dst_eng.dispose()
    # 3. 切换引擎配置
    cfg = get_config()
    cfg["storage"] = {"engine": target_engine,
                      "url": url if target_engine == "db" else ""}
    save_config(cfg)
    _reset_db()
    return sum(len(v) for v in snapshot.values())


# ---------- 统计（SQL 引擎按表聚合，不逐行读内容） ----------
def _sql_stats_bytes(conn, username: str) -> int:
    from sqlalchemy import text
    total = 0
    total += (conn.execute(text(
        'SELECT COALESCE(SUM(LENGTH("name") + LENGTH("url") + LENGTH("desc") + '
        'LENGTH("tags") + LENGTH("cat") + LENGTH("icon")), 0) '
        'FROM "bm_bookmarks" WHERE "username" = :u'),
        {"u": username}).scalar() or 0)
    total += (conn.execute(text(
        'SELECT COALESCE(SUM(LENGTH("title") + LENGTH("tags") + '
        'LENGTH("folder") + LENGTH("content")), 0) '
        'FROM "bm_notes" WHERE "username" = :u'),
        {"u": username}).scalar() or 0)
    for table, cols in (("bm_calendar", ("payload",)),
                        ("bm_vault_items", ("payload",)),
                        ("bm_cats", ("name",)),
                        ("bm_note_folders", ("name",))):
        expr = " + ".join('LENGTH("%s")' % c for c in cols)
        total += (conn.execute(text(
            f"SELECT COALESCE(SUM({expr}), 0) FROM \"{table}\" "
            'WHERE "username" = :u'), {"u": username}).scalar() or 0)
    total += (conn.execute(text(
        'SELECT COALESCE(SUM(LENGTH("vcheck") + LENGTH("salt")), 0) '
        'FROM "bm_vault_meta" WHERE "username" = :u'),
        {"u": username}).scalar() or 0)
    for table in ("bm_prefs", "bm_dashboard", "bm_plan",
                  "bm_ai", "bm_backup_cfg"):
        total += (conn.execute(text(
            f'SELECT COALESCE(SUM(LENGTH("payload")), 0) FROM "{table}" '
            'WHERE "username" = :u'), {"u": username}).scalar() or 0)
    rows = conn.execute(text(
        'SELECT COALESCE(SUM(LENGTH("content")), 0) FROM "bm_misc" '
        'WHERE "username" = :u'), {"u": username}).scalar()
    return total + (rows or 0)


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
