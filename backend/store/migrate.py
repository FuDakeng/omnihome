"""万事屋 · 存储引擎迁移（旧单表 → 分表，file ↔ db）"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import storage
from store.db import _has_table, _sql_write, _sql_engine, _TABLES, _reset_db, test_db_conn

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
        bak = storage.DATA_DIR / ("migration-backup-" +
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
    d = storage.user_dir(username)
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
    cfg = storage.get_config()
    users = list(cfg.get("users", {}).keys())
    snapshot = {}
    for u in users:
        snapshot[u] = {k: storage._kv_read(u, k) for k in storage._kv_keys(u)}
        snapshot[u] = {k: v for k, v in snapshot[u].items() if v is not None}
    # 2. 写入目标（先清空该用户旧数据，避免残留 key 混入；再按模块路由写入）
    if target_engine == "file":
        for u, items in snapshot.items():
            _file_clear_user(u)
            for k, v in items.items():
                storage._atomic_write(storage.user_dir(u) / k, v)
    else:
        dst_url = "sqlite:///" + str(storage.SQLITE_FILE) if target_engine == "sqlite" else url
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
    cfg = storage.get_config()
    cfg["storage"] = {"engine": target_engine,
                      "url": url if target_engine == "db" else ""}
    storage.save_config(cfg)
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


