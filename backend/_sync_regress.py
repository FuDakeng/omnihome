# -*- coding: utf-8 -*-
"""Obsidian /api/sync 专项回归（单元测试 · 自包含）

用 FastAPI TestClient 在进程内跑完整 HTTP 栈，无需启动服务、无需联网。
storage 重定向到临时目录，file + sqlite 双引擎各跑一遍，结束自动清理，
绝不触碰真实 data/。

覆盖：
  · API Key 鉴权（缺失 / 错误 / 正确）
  · /list 结构 + 同步范围过滤（排除 pinned / 回收站 / 内置文件夹）
  · /file 读写往返（标题作 H1，与 _note_to_md 一致）
  · 同文件夹同名 -> -2 序号
  · /file/rename 改 folder + title
  · /file DELETE -> 软删进回收站（正文保留、可恢复）
  · LWW（客户端更旧 / 2 秒内 / 明显更新）
  · 路径遍历（.. / 绝对路径 / 空段）被拒
  · 隐藏段（.obsidian/.git）与资源垃圾被拒 / 被过滤
运行：cd backend && python3 _sync_regress.py
"""
import json
import base64
import shutil
import tempfile
import time
import uuid
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="omnihome-sync-test-"))

import storage                                   # noqa: E402
# 重定向到临时目录（这些全局在函数调用时读取，覆盖即生效）
storage.DATA_DIR = TMP
storage.USERS_DIR = TMP / "users"
storage.CONFIG_FILE = TMP / "config.json"
storage.SQLITE_FILE = TMP / "omnihome.db"
storage.USERS_DIR.mkdir(parents=True, exist_ok=True)
storage.CONFIG_FILE.write_text(json.dumps({"users": {}}), encoding="utf-8")

import sessions                                  # noqa: E402
from fastapi.testclient import TestClient         # noqa: E402
import main                                       # noqa: E402

client = TestClient(main.app)
OK, FAIL = [], []
USER = "synctester"


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{extra}]" if extra else ""))


def provision(engine):
    """切换到指定引擎，建用户 + session token + API Key；清空该用户笔记。"""
    cfg = storage.get_config()
    cfg["users"][USER] = {"password": sessions.hash_password("pw123456"),
                          "nickname": USER, "role": "admin",
                          "createdAt": "", "email": ""}
    cfg["storage"] = {"engine": engine, "url": ""}
    storage.save_config(cfg)
    if engine in ("sqlite", "db"):
        storage.ensure_db()
    storage.ensure_user_dir(USER)
    # 清空该用户笔记：SQL 引擎下 save_notes_index([]) 是 no-op（不删行），
    # 必须走 delete_user_file -> _sql_delete 触发 DELETE FROM bm_notes WHERE username。
    storage.delete_user_file(USER, "notes/index.json")
    storage.save_user_json(USER, "notes/folders.json", [])
    tok = sessions.create_session(USER)
    key = storage.gen_sync_key(USER)
    return tok, key


def HK(key):
    return {"X-API-Key": key}


def HA(tok):
    return {"Authorization": "Bearer " + tok}


def gcontent(body):
    """从 GET /api/sync/file 响应取正文：优先 base64 解码 contentB64（v0.2.29 新协议），
    回退明文 content（旧协议）。与插件 decodeSyncContent 语义一致。"""
    if isinstance(body.get("contentB64"), str):
        return base64.b64decode(body["contentB64"]).decode("utf-8", "replace")
    return body.get("content", "")


def seed(title, folder="", content="", updated=None, pinned=False, deleted=None):
    """直接经 storage 播种一篇笔记（精确控制 updated / pinned / deleted）。"""
    idx = storage.notes_index(USER)
    nid = uuid.uuid4().hex[:8]
    m = {"id": nid, "title": title, "tags": [], "folder": folder,
         "pinned": pinned, "updated": updated if updated is not None else int(time.time())}
    if deleted:
        m["deleted"] = deleted
        m["deleted_title"] = title
    idx.append(m)
    storage.save_notes_index(USER, idx)
    storage.note_write(USER, nid, content)
    return nid


def reset(engine):
    """清库并重新播种，返回 (tok, key)。"""
    return provision(engine)


def run_suite(engine):
    print(f"\n================ 引擎：{engine} ================")
    tok, key = reset(engine)

    # ---------- 1. API Key 鉴权 ----------
    print("-- 1. 鉴权 --")
    r = client.get("/api/sync/list")
    check(f"[{engine}] 无 X-API-Key -> 401", r.status_code == 401, str(r.status_code))
    r = client.get("/api/sync/list", headers=HK("ohs_bogus"))
    check(f"[{engine}] 错误 Key -> 401", r.status_code == 401, str(r.status_code))
    r = client.get("/api/sync/list", headers=HK(key))
    check(f"[{engine}] 正确 Key -> 200", r.status_code == 200, str(r.status_code))

    # ---------- 2. /list 过滤与结构 ----------
    print("-- 2. list 过滤 --")
    reset(engine)
    tok, key = reset(engine)
    now = int(time.time())
    seed("甲", folder="工作", content="正文甲", updated=now)
    seed("生词本", pinned=True, content="常驻")           # pinned 排除
    seed("计划项", folder="每日计划", content="x")         # 内置排除
    seed("速记项", folder="灵感速记", content="x")         # 内置排除
    seed("速记子", folder="灵感速记/子", content="x")      # 内置子路径排除
    seed("已删", folder="工作", content="x", deleted=now)  # 回收站排除
    r = client.get("/api/sync/list", headers=HK(key))
    paths = sorted(f["path"] for f in r.json().get("files", []))
    check(f"[{engine}] 仅同步范围内笔记入列", paths == ["工作/甲.md"], str(paths))
    one = r.json()["files"][0]
    check(f"[{engine}] mtime = updated*1000", one["mtime"] == now * 1000, str(one))

    # ---------- 3. /file 读写往返（H1） ----------
    print("-- 3. file 往返 --")
    reset(engine)
    tok, key = reset(engine)
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "笔记A.md", "content": "# 笔记A\n\n正文内容"})
    check(f"[{engine}] POST 新建 applied", r.status_code == 200 and r.json().get("applied") is True,
          r.text[:120])
    r = client.get("/api/sync/file", headers=HK(key), params={"path": "笔记A.md"})
    body = r.json()
    md = gcontent(body)
    check(f"[{engine}] GET 回读标题作 H1", md.startswith("# 笔记A"), md[:40])
    check(f"[{engine}] GET 回读含正文", "正文内容" in md, "")
    check(f"[{engine}] GET 正文走 contentB64（新协议、无明文 content）",
          isinstance(body.get("contentB64"), str) and body.get("content") is None, str(list(body.keys())))
    idx = storage.notes_index(USER)
    check(f"[{engine}] 索引标题解析正确", any(i["title"] == "笔记A" for i in idx),
          str([i["title"] for i in idx]))

    # base64 传输：正文含 HTML/JS/SVG 特征串时，响应体不得出现明文特征（对 WAF 不透明）
    evil = ('# ev\n\n<script>document.createElement("iframe")</script>\n'
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<svg xmlns="http://www.w3.org/2000/svg" width="1em"><path d="M0 0"/></svg>\n')
    b64 = base64.b64encode(evil.encode("utf-8")).decode("ascii")
    rp = client.post("/api/sync/file", headers=HK(key),
                     json={"path": "ev.md", "contentB64": b64, "clientMtime": 9_999_999_999_999})
    check(f"[{engine}] POST contentB64 applied",
          rp.status_code == 200 and rp.json().get("applied") is True, rp.text[:120])
    rr = client.get("/api/sync/file", headers=HK(key), params={"path": "ev.md"})
    raw = rr.content
    check(f"[{engine}] 响应体对 WAF 不透明（无明文 <svg/<script/<?xml）",
          (b"<svg" not in raw) and (b"<script" not in raw) and (b"<?xml" not in raw), "")
    dec = gcontent(rr.json())
    check(f"[{engine}] contentB64 往返无损（含 script/svg/iframe/xml）",
          ('createElement("iframe")' in dec) and ("<svg xmlns=" in dec) and ("<?xml" in dec), dec[:60])
    rb = client.post("/api/sync/file", headers=HK(key),
                     json={"path": "bad.md", "contentB64": "!!!not-b64!!!"})
    check(f"[{engine}] 非法 base64 返回 400", rb.status_code == 400, rb.text[:120])

    # 无 H1 -> 用文件名兜底标题
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "无H笔记.md", "content": "只有正文没有标题"})
    idx = storage.notes_index(USER)
    check(f"[{engine}] 无 H1 用文件名兜底标题",
          any(i["title"] == "无H笔记" for i in idx), str([i["title"] for i in idx]))

    # ---------- 4. 同文件夹同名 -> -2 ----------
    print("-- 4. 重名 -2 --")
    reset(engine)
    tok, key = reset(engine)
    seed("重名", folder="F", content="a")
    seed("重名", folder="F", content="b")
    r = client.get("/api/sync/list", headers=HK(key))
    paths = sorted(f["path"] for f in r.json()["files"])
    check(f"[{engine}] 同名分配 -2 后缀", paths == ["F/重名-2.md", "F/重名.md"], str(paths))
    # 多次 /list 顺序稳定（不抖动）
    p2 = sorted(f["path"] for f in client.get("/api/sync/list", headers=HK(key)).json()["files"])
    check(f"[{engine}] 重复 list 路径稳定", p2 == paths, str(p2))

    # ---------- 5. rename 改 folder + title ----------
    print("-- 5. rename --")
    reset(engine)
    tok, key = reset(engine)
    client.post("/api/sync/file", headers=HK(key),
                json={"path": "F/旧名.md", "content": "# 旧名\n\n正文"})
    r = client.put("/api/sync/file/rename", headers=HK(key),
                   json={"oldPath": "F/旧名.md", "newPath": "F2/新名.md"})
    check(f"[{engine}] rename 200", r.status_code == 200, r.text[:120])
    idx = storage.notes_index(USER)
    hit = idx[0]
    check(f"[{engine}] rename 改 folder+title",
          hit["folder"] == "F2" and hit["title"] == "新名", f'{hit["folder"]}/{hit["title"]}')
    r = client.get("/api/sync/list", headers=HK(key))
    paths = [f["path"] for f in r.json()["files"]]
    check(f"[{engine}] rename 后新路径入列、旧路径消失",
          paths == ["F2/新名.md"], str(paths))
    # 源不存在
    r = client.put("/api/sync/file/rename", headers=HK(key),
                   json={"oldPath": "不存在.md", "newPath": "x.md"})
    check(f"[{engine}] rename 源不存在 -> 404", r.status_code == 404, str(r.status_code))

    # ---------- 6. DELETE -> 回收站 ----------
    print("-- 6. delete 回收站 --")
    reset(engine)
    tok, key = reset(engine)
    nid = seed("待删", folder="工作", content="重要正文")
    r = client.delete("/api/sync/file", headers=HK(key), params={"path": "工作/待删.md"})
    check(f"[{engine}] DELETE softDeleted", r.status_code == 200 and r.json().get("softDeleted") is True,
          r.text[:120])
    idx = storage.notes_index(USER)
    hit = next(i for i in idx if i["id"] == nid)
    check(f"[{engine}] 笔记标记 deleted", bool(hit.get("deleted")), str(hit.get("deleted")))
    check(f"[{engine}] 正文未物理删除（可恢复）",
          storage.note_read(USER, nid, "") == "重要正文", "")
    r = client.get("/api/sync/list", headers=HK(key))
    check(f"[{engine}] 删除后不再入列",
          "工作/待删.md" not in [f["path"] for f in r.json()["files"]], "")
    r = client.delete("/api/sync/file", headers=HK(key), params={"path": "工作/不存在.md"})
    check(f"[{engine}] DELETE 不存在 -> 404", r.status_code == 404, str(r.status_code))

    # ---------- 7. LWW ----------
    print("-- 7. LWW --")
    reset(engine)
    tok, key = reset(engine)
    site_updated = int(time.time())
    lww_id = seed("LWW", folder="", content="站点版本", updated=site_updated)
    site_mtime = site_updated * 1000
    # 7a. 客户端更旧 -> 站点胜
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "LWW.md", "content": "旧客户端", "clientMtime": site_mtime - 10000})
    check(f"[{engine}] LWW 客户端更旧 -> applied False", r.json().get("applied") is False,
          r.text[:120])
    check(f"[{engine}] LWW 拒绝时正文未被改",
          storage.note_read(USER, lww_id, "") == "站点版本", "")
    # 7b. 2 秒内（同刻）-> 站点优先
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "LWW.md", "content": "同刻客户端", "clientMtime": site_mtime + 1000})
    check(f"[{engine}] LWW 2 秒内 -> 站点优先(applied False)", r.json().get("applied") is False,
          r.text[:120])
    # 7c. 客户端明显更新(>2s) -> 覆盖
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "LWW.md", "content": "# LWW\n\n新客户端", "clientMtime": site_mtime + 10000})
    check(f"[{engine}] LWW 客户端明显更新 -> applied True", r.json().get("applied") is True,
          r.text[:120])
    check(f"[{engine}] LWW 覆盖后正文更新",
          "新客户端" in storage.note_read(USER, lww_id, ""), "")
    # 7d. 客户端已知站点 mtime 且服务端未变：2 秒窗口内连续保存应落地（Obsidian 边打字边同步）
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "LWW.md", "content": "# LWW\n\n连续输入",
                          "clientMtime": int(time.time()) * 1000,
                          "knownRemoteMtime": r.json().get("mtime")})
    check(f"[{engine}] LWW 服务端未变时连续保存 -> applied True",
          r.json().get("applied") is True, r.text[:160])
    check(f"[{engine}] LWW 连续保存正文已落地",
          "连续输入" in storage.note_read(USER, lww_id, ""), "")
    # 7e. 正文未变不 bump mtime
    mtime_keep = r.json().get("mtime")
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "LWW.md", "content": "# LWW\n\n连续输入",
                          "clientMtime": int(time.time()) * 1000 + 5000,
                          "knownRemoteMtime": mtime_keep})
    check(f"[{engine}] LWW 正文相同 -> unchanged",
          r.json().get("unchanged") is True and r.json().get("mtime") == mtime_keep,
          r.text[:160])

    # ---------- 7x. 同步附件 ----------
    print("-- 7x. sync assets --")
    png = base64.b64encode(
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 24).decode()
    r = client.post("/api/sync/asset", headers=HK(key),
                    json={"filename": "shot.png", "dataB64": png})
    check(f"[{engine}] POST asset 200", r.status_code == 200, r.text[:120])
    aname = r.json().get("name") or ""
    check(f"[{engine}] asset 名含哈希后缀", aname.endswith(".png") and "-" in aname, aname)
    r = client.get("/api/sync/asset", headers=HK(key), params={"name": aname})
    check(f"[{engine}] GET asset 回读", r.status_code == 200 and r.json().get("dataB64") == png,
          str(r.status_code))
    r = client.get("/api/sync/assets", headers=HK(key))
    names = [a["name"] for a in r.json().get("assets", [])]
    check(f"[{engine}] list assets 含刚传文件", aname in names, str(names))
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "带图.md",
                          "content": "# 带图\n\n![](/api/notes/assets/" + aname + ")\n",
                          "clientMtime": int(time.time()) * 1000 + 10000})
    check(f"[{engine}] 笔记引用附件可写入", r.status_code == 200 and r.json().get("applied") is True,
          r.text[:120])
    r = client.get("/api/sync/file", headers=HK(key), params={"path": "带图.md"})
    check(f"[{engine}] 回读保留附件引用", aname in gcontent(r.json()), gcontent(r.json())[:80])

    # ---------- 8. 路径遍历防护 ----------
    print("-- 8. 路径遍历 --")
    reset(engine)
    tok, key = reset(engine)
    for bad in ["../etc/passwd", "/etc/passwd", "a/../../b.md", "..", "a//b.md"]:
        r = client.get("/api/sync/file", headers=HK(key), params={"path": bad})
        check(f"[{engine}] 遍历被拒: {bad!r}", r.status_code == 400, str(r.status_code))
    r = client.post("/api/sync/file", headers=HK(key),
                    json={"path": "../../evil.md", "content": "x"})
    check(f"[{engine}] POST 遍历被拒", r.status_code == 400, str(r.status_code))

    # ---------- 9. 隐藏段 / 资源垃圾 ----------
    print("-- 9. 隐藏与垃圾 --")
    reset(engine)
    tok, key = reset(engine)
    for bad in [".obsidian/app.json", ".git/config.md", "._临时.md", "工作/__MACOSX/x.md"]:
        r = client.get("/api/sync/file", headers=HK(key), params={"path": bad})
        check(f"[{engine}] 隐藏/垃圾入参被拒: {bad!r}", r.status_code == 400, str(r.status_code))
    # 隐藏/垃圾笔记不入 /list
    seed("正常", folder="工作", content="x")
    seed("._隐藏", folder="工作", content="x")     # ._ 前缀垃圾标题
    r = client.get("/api/sync/list", headers=HK(key))
    paths = [f["path"] for f in r.json()["files"]]
    check(f"[{engine}] 垃圾标题笔记被 /list 过滤", paths == ["工作/正常.md"], str(paths))

    # ---------- 10. API Key 管理端点（session 鉴权） ----------
    print("-- 10. API Key 管理 --")
    reset(engine)
    tok, key = reset(engine)
    r = client.get("/api/sync/apikey", headers=HA(tok))
    check(f"[{engine}] GET apikey 掩码(无明文)",
          r.status_code == 200 and r.json().get("enabled") is True and "apiKey" not in r.json(),
          r.text[:120])
    check(f"[{engine}] GET apikey 掩码含 prefix", bool(r.json().get("prefix")), r.text[:120])
    r = client.post("/api/sync/apikey", headers=HA(tok))
    newkey = r.json().get("apiKey", "")
    check(f"[{engine}] POST apikey 重置返回明文", r.status_code == 200 and newkey.startswith("ohs_"),
          newkey[:12])
    check(f"[{engine}] 重置后旧 Key 失效",
          client.get("/api/sync/list", headers=HK(key)).status_code == 401, "")
    check(f"[{engine}] 重置后新 Key 生效",
          client.get("/api/sync/list", headers=HK(newkey)).status_code == 200, "")
    r = client.delete("/api/sync/apikey", headers=HA(tok))
    check(f"[{engine}] DELETE apikey 吊销", r.status_code == 200, str(r.status_code))
    check(f"[{engine}] 吊销后 Key 失效",
          client.get("/api/sync/list", headers=HK(newkey)).status_code == 401, "")
    r = client.get("/api/sync/apikey")   # 无 session
    check(f"[{engine}] 管理端点需 session(401)", r.status_code == 401, str(r.status_code))


try:
    run_suite("file")
    run_suite("sqlite")
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print(f"\n==== 结果：PASS {len(OK)} / FAIL {len(FAIL)} ====")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print("  -", f)
    raise SystemExit(1)
print("全部通过 ✅")
