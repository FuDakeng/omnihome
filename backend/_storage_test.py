# -*- coding: utf-8 -*-
"""存储层重构综合测试：文件引擎冒烟 → 旧单表自动迁移 → SQL 引擎往返 → 引擎切换。
测试用临时用户名与临时库，结束时恢复 config.json 引擎为 file 并清理。"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, "/Users/jeanlaw/Documents/coder/OmniHome/backend")
import storage  # noqa: E402

OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{extra}]" if extra else ""))


def set_engine(eng, url=""):
    cfg = storage.get_config()
    cfg["storage"] = {"engine": eng, "url": url}
    storage.save_config(cfg)
    storage._reset_db()


# ---------- 1. 文件引擎冒烟 ----------
print("== 1. 文件引擎冒烟 ==")
for uu in ("u1", "u2", "systest"):
    shutil.rmtree(storage.user_dir(uu), ignore_errors=True)
set_engine("file")
assert storage.engine() == "file", "测试前置：引擎应为 file"
u = "systest"
bm = [{"id": "a1", "name": "SiteA", "url": "https://a.com", "desc": "d",
       "tags": ["t1"], "cat": "dev", "hue": 100, "icon": "", "order": 0}]
cats = [{"id": "all", "name": "全部"}, {"id": "dev", "name": "开发"}]
storage.save_user_json(u, "bookmarks.json", bm)
storage.save_user_json(u, "bookmark-cats.json", cats)
storage.save_user_json(u, "calendar.json", [{"id": "e1", "date": "2026-08-27",
                                             "title": "事件", "note": "n"}])
storage.save_user_json(u, "notes/folders.json", ["工作", "生活"])
storage.save_notes_index(u, [{"id": "n1", "title": "笔记1", "tags": [], "pinned": True,
                              "folder": "工作", "updated": 1787000000}])
storage.note_write(u, "n1", "# 笔记1\n正文内容")
storage.save_user_json(u, "vault.json", {"check": "ck", "salt": "st",
                                         "items": {"v1": {"blob": "B"}},
                                         "updatedAt": 1787000000})
storage.save_user_json(u, "prefs.json", {"theme": {"mode": "light"}})
storage.save_user_text(u, "plan.md", "- [ ] 任务\n")
storage.save_user_json(u, "backup.json", {"auto": True, "intervalHours": 24,
                                          "keep": 5, "lastAuto": 0})
storage.save_user_json(u, "ai.json", {"baseUrl": "http://x", "key": "k"})
check("文件引擎 书签读写", storage.user_json(u, "bookmarks.json", []) == bm)
check("文件引擎 分类读写", storage.user_json(u, "bookmark-cats.json", []) == cats)
check("文件引擎 日历读写", len(storage.user_json(u, "calendar.json", [])) == 1)
check("文件引擎 文件夹(字符串数组)",
      storage.user_json(u, "notes/folders.json", []) == ["工作", "生活"])
check("文件引擎 笔记索引", storage.notes_index(u)[0]["title"] == "笔记1")
check("文件引擎 笔记正文", storage.note_read(u, "n1") == "# 笔记1\n正文内容")
v = storage.user_json(u, "vault.json", {})
check("文件引擎 保险库", v["items"]["v1"]["blob"] == "B" and v["check"] == "ck")
check("文件引擎 偏好", storage.get_prefs(u)["theme"]["mode"] == "light")
check("文件引擎 计划", storage.user_text(u, "plan.md").startswith("- [ ]"))
check("文件引擎 备份配置", storage.user_json(u, "backup.json", {})["keep"] == 5)
check("文件引擎 AI配置", storage.user_json(u, "ai.json", {})["baseUrl"] == "http://x")
st = storage.storage_stats(u)
check("文件引擎 统计", st["bookmarks"] == 1 and st["notes"] == 1 and st["vaultItems"] == 1,
      json.dumps(st))
bk = storage.create_backup(u, "backup")
check("文件引擎 备份zip存在", bk.exists())
n_zip = len(zipfile.ZipFile(bk).namelist())
check("文件引擎 备份含全部模块", n_zip >= 9, f"{n_zip} entries")
storage.prune_backups(u, 2)
check("文件引擎 备份清理", len(list(storage.backup_dir(u).glob("*.zip"))) == 1)

# ---------- 2. 构造旧单表库 ----------
print("== 2. 构造旧单表 omni_kv ==")
# migrate_storage 按注册用户迁移，先把测试用户注册进配置
cfg = storage.get_config()
cfg["users"].setdefault("u1", {"role": "member", "createdAt": ""})
cfg["users"].setdefault("u2", {"role": "member", "createdAt": ""})
storage.save_config(cfg)
from sqlalchemy import create_engine, text  # noqa: E402
LEGACY = Path("/tmp/omni-legacy.db")
LEGACY.unlink(missing_ok=True)
eng = create_engine("sqlite:///" + str(LEGACY))
old_bm = [{"id": "b1", "name": "Old1", "url": "https://o1.com", "cat": "dev",
           "hue": 10, "order": 0},
          {"id": "b2", "name": "Old2", "url": "https://o2.com", "cat": "media",
           "hue": 20, "desc": "旧书签", "tags": ["x", "y"], "order": 1}]
old_idx = [{"id": "n1", "title": "旧笔记", "tags": ["灵感"], "pinned": False,
            "folder": "", "updated": 1787000001}]
old_rows = [
    ("u1", "bookmarks.json", json.dumps(old_bm, ensure_ascii=False)),
    ("u1", "bookmark-cats.json", json.dumps(
        [{"id": "all", "name": "全部"}, {"id": "dev", "name": "开发", "hidden": True}],
        ensure_ascii=False)),
    ("u1", "notes/index.json", json.dumps(old_idx, ensure_ascii=False)),
    ("u1", "notes/n1.md", "# 旧笔记\n旧正文"),
    ("u1", "notes/folders.json", json.dumps(["归档"], ensure_ascii=False)),
    ("u1", "calendar.json", json.dumps(
        [{"id": "e9", "date": "2026-09-01", "title": "旧日程", "note": ""}],
        ensure_ascii=False)),
    ("u1", "vault.json", json.dumps({"check": "ck", "salt": "sa",
                                     "items": {"v9": {"blob": "BBB", "meta": {}}},
                                     "updatedAt": 1787000002}, ensure_ascii=False)),
    ("u1", "prefs.json", json.dumps({"theme": {"mode": "light"}}, ensure_ascii=False)),
    ("u1", "plan.md", "- [ ] 旧计划\n"),
    ("u1", "backup.json", json.dumps({"auto": True, "keep": 3}, ensure_ascii=False)),
    ("u1", "weird-key.json", "unknown-content"),
    ("u2", "bookmarks.json", json.dumps(
        [{"id": "c1", "name": "User2Bm", "url": "https://u2.com", "cat": "none",
          "hue": 1, "order": 0}], ensure_ascii=False)),
]
with eng.begin() as c:
    c.execute(text("CREATE TABLE omni_kv (username VARCHAR(64), name VARCHAR(255), "
                   "content TEXT, updated BIGINT, PRIMARY KEY (username, name))"))
    c.execute(text("INSERT INTO omni_kv VALUES (:u, :n, :c, :t)"),
               [{"u": uu, "n": n, "c": cc, "t": 1787000000}
                for uu, n, cc in old_rows])
eng.dispose()
print(f"旧库就绪：{len(old_rows)} 行")

# ---------- 3. 引擎切 sqlite → 自动迁移 ----------
print("== 3. sqlite 引擎 + 自动迁移 ==")
set_engine("sqlite")
bak = storage.SQLITE_FILE.with_suffix(".db.bak")
if storage.SQLITE_FILE.exists():
    storage.SQLITE_FILE.rename(bak)
shutil.copy2(LEGACY, storage.SQLITE_FILE)
storage._reset_db()
eng2 = create_engine("sqlite:///" + str(storage.SQLITE_FILE))
with eng2.connect() as c:
    pre = c.execute(text("SELECT COUNT(*) FROM omni_kv")).scalar()
check("迁移前 omni_kv 行数=12", pre == 12, str(pre))
eng2.dispose()
storage._get_db()   # 触发建表 + 自动迁移
with create_engine("sqlite:///" + str(storage.SQLITE_FILE)).connect() as c:
    mv = c.execute(text("SELECT COUNT(*) FROM bm_migrations")).scalar()
    has_legacy = c.execute(text(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='omni_kv'")).scalar()
    check("迁移后 bm_migrations 有记录", mv == 1)
    check("迁移后 omni_kv 已删除", has_legacy == 0)
    bm_cnt = c.execute(text("SELECT COUNT(*) FROM bm_bookmarks")).scalar()
    notes_cnt = c.execute(text("SELECT COUNT(*) FROM bm_notes")).scalar()
    vault_cnt = c.execute(text("SELECT COUNT(*) FROM bm_vault_items")).scalar()
    misc_cnt = c.execute(text("SELECT COUNT(*) FROM bm_misc")).scalar()
    folders = [r[0] for r in c.execute(text(
        "SELECT name FROM bm_note_folders ORDER BY pos"))]
    check("迁移 书签3行", bm_cnt == 3, str(bm_cnt))
    check("迁移 笔记1行(索引+正文合并)", notes_cnt == 1, str(notes_cnt))
    check("迁移 凭据1行", vault_cnt == 1, str(vault_cnt))
    check("迁移 未知key进misc", misc_cnt == 1, str(misc_cnt))
    check("迁移 文件夹数组", folders == ["归档"], str(folders))
    r = c.execute(text("SELECT content FROM bm_notes WHERE username='u1' "
                       "AND id='n1'")).scalar()
    check("迁移 笔记正文", r == "# 旧笔记\n旧正文", repr(r))
    r = c.execute(text("SELECT hidden FROM bm_cats WHERE username='u1' "
                       "AND id='dev'")).scalar()
    check("迁移 分类hidden保留", r == 1, str(r))
    r = c.execute(text("SELECT content FROM bm_misc WHERE username='u1' "
                       "AND name='weird-key.json'")).scalar()
    check("迁移 misc内容", r == "unknown-content", repr(r))
backups = list(Path(storage.DATA_DIR).glob("migration-backup-*.json"))
check("迁移前快照备份已落盘", len(backups) >= 1, str(backups))
snap = json.loads(backups[0].read_text(encoding="utf-8"))
check("快照含2用户", set(snap) == {"u1", "u2"}, str(set(snap)))
for b in backups:
    b.unlink()

# ---------- 4. SQL 引擎公共接口往返 ----------
print("== 4. SQL 引擎公共接口 ==")
bm_read = storage.user_json("u1", "bookmarks.json", [])
# SQL 引擎对缺失字段补默认值（规范化），此处按关键字段语义对比
check("SQL 读书签", [(b.get("id"), b.get("name"), b.get("url"),
                      b.get("cat"), b.get("hue"), b.get("order"))
                     for b in bm_read] ==
                    [(b.get("id"), b.get("name"), b.get("url"),
                      b.get("cat"), b.get("hue"), b.get("order"))
                     for b in old_bm],
      json.dumps(bm_read, ensure_ascii=False)[:150])
check("SQL 读分类(含hidden)",
      storage.user_json("u1", "bookmark-cats.json", []) ==
      [{"id": "all", "name": "全部"}, {"id": "dev", "name": "开发", "hidden": True}])
check("SQL 读日历", storage.user_json("u1", "calendar.json", [])[0]["id"] == "e9")
check("SQL 读文件夹", storage.user_json("u1", "notes/folders.json", []) == ["归档"])
check("SQL 读笔记索引", storage.notes_index("u1")[0]["title"] == "旧笔记")
check("SQL 读笔记正文", storage.note_read("u1", "n1") == "# 旧笔记\n旧正文")
v = storage.user_json("u1", "vault.json", {})
check("SQL 读保险库", v["items"]["v9"]["blob"] == "BBB" and v["check"] == "ck")
check("SQL 读偏好", storage.get_prefs("u1")["theme"]["mode"] == "light")
check("SQL 读计划", storage.user_text("u1", "plan.md") == "- [ ] 旧计划\n")
check("SQL 读备份配置", storage.user_json("u1", "backup.json", {})["keep"] == 3)
check("SQL 读未知key", storage.user_text("u1", "weird-key.json") == "unknown-content")
st = storage.storage_stats("u1")
check("SQL 统计聚合", st["bookmarks"] == 2 and st["notes"] == 1 and
      st["vaultItems"] == 1 and st["bytes"] > 0, json.dumps(st))
new_bm = old_bm + [{"id": "b3", "name": "New3", "url": "https://n3.com",
                    "cat": "dev", "hue": 30, "order": 2}]
storage.save_user_json("u1", "bookmarks.json", new_bm)
check("SQL 写书签(逐行)", len(storage.user_json("u1", "bookmarks.json", [])) == 3)
storage.save_notes_index("u1", [{"id": "n1", "title": "改名", "tags": ["灵感"],
                                 "pinned": True, "folder": "归档",
                                 "updated": 1787000005}])
check("SQL 写索引(仅元数据)",
      storage.notes_index("u1")[0]["title"] == "改名" and
      storage.note_read("u1", "n1") == "# 旧笔记\n旧正文")
storage.note_write("u1", "n2", "新笔记正文")
storage.save_notes_index("u1", storage.notes_index("u1") + [
    {"id": "n2", "title": "新笔记", "tags": [], "pinned": False,
     "folder": "", "updated": 1787000006}])
check("SQL 新笔记(先写正文后写索引)",
      storage.note_read("u1", "n2") == "新笔记正文" and
      len(storage.notes_index("u1")) == 2)
storage.save_user_json("u1", "vault.json", {"check": "ck2", "salt": "sa2",
                                            "items": {"v9": {"blob": "CCC"}},
                                            "updatedAt": 1787000009})
v = storage.user_json("u1", "vault.json", {})
check("SQL 写保险库", v["check"] == "ck2" and v["items"]["v9"]["blob"] == "CCC")
bk2 = storage.create_backup("u1", "backup")
names = sorted(zipfile.ZipFile(bk2).namelist())
check("SQL 备份zip含模块key", "bookmarks.json" in names and
      "notes/n1.md" in names and "vault.json" in names and
      "weird-key.json" in names, str(names))
storage.wipe_user_data("u1")
check("SQL 清空后书签为空", storage.user_json("u1", "bookmarks.json", []) == [])
check("SQL 清空后笔记空", storage.notes_index("u1") == [])
check("SQL 清空后文件夹保留",
      storage.user_json("u1", "notes/folders.json", []) == ["归档"])
cnt = storage.restore_backup("u1", bk2.name)
check("SQL 恢复成功", cnt >= 11 and
      len(storage.user_json("u1", "bookmarks.json", [])) == 3, str(cnt))
check("SQL 恢复后正文", storage.note_read("u1", "n1") == "# 旧笔记\n旧正文")
check("SQL 恢复后偏好", storage.get_prefs("u1")["theme"]["mode"] == "light")

# ---------- 5. 引擎切换往返 ----------
print("== 5. 引擎切换 ==")
moved = storage.migrate_storage("file")
check("切回 file 迁移条目数", moved >= 10, str(moved))
check("file 读书签", len(storage.user_json("u1", "bookmarks.json", [])) == 3)
check("file 读正文", storage.note_read("u1", "n1") == "# 旧笔记\n旧正文")
moved = storage.migrate_storage("sqlite")
check("再切 sqlite 迁移条目数", moved >= 10, str(moved))
check("sqlite 读书签", len(storage.user_json("u1", "bookmarks.json", [])) == 3)
check("sqlite 读文件夹", storage.user_json("u1", "notes/folders.json", []) == ["归档"])

# ---------- 6. 清理 ----------
print("== 6. 清理 ==")
set_engine("file")
cfg = storage.get_config()
cfg["users"].pop("u1", None)
cfg["users"].pop("u2", None)
storage.save_config(cfg)
for uu in ("u1", "u2", "systest"):
    d = storage.user_dir(uu)
    if d.exists():
        shutil.rmtree(d)
if bak.exists():
    bak.unlink()
LEGACY.unlink(missing_ok=True)
print(f"\n结果：{len(OK)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：", FAIL)
    sys.exit(1)
