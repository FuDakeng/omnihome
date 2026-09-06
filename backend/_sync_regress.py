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
         "vault": "system" if pinned or (folder or "").split("/")[0] in ("每日计划", "灵感速记") else "default",
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
    rlog = client.get("/api/sync/log?vault=default&limit=20", headers=HA(tok))
    logs = (rlog.json() or {}).get("logs") or []
    add_log = next((x for x in logs if x.get("kind") == "add" and x.get("title") == "笔记A"), None)
    check(f"[{engine}] 新建写入笔记级日志",
          rlog.status_code == 200 and bool(add_log)
          and add_log.get("from") == "Obsidian" and add_log.get("to") == "万事屋"
          and "新建" in (add_log.get("summary") or ""), str(add_log)[:160])

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
    rlog = client.get("/api/sync/log?vault=default&limit=20", headers=HA(tok))
    del_log = next((x for x in (rlog.json() or {}).get("logs") or [] if x.get("kind") == "delete"), None)
    check(f"[{engine}] 删除写入笔记级日志",
          bool(del_log) and del_log.get("title") == "待删"
          and del_log.get("from") == "Obsidian", str(del_log)[:160])
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
    rlog = client.get("/api/sync/log?vault=default&limit=40", headers=HA(tok))
    edit_log = next((x for x in (rlog.json() or {}).get("logs") or []
                     if x.get("kind") == "edit" and "LWW" in (x.get("title") or "")), None)
    check(f"[{engine}] 修改写入笔记级日志",
          bool(edit_log) and edit_log.get("summary"), str(edit_log)[:160])

    # ---------- 7y. 仓库级同步开关（令牌保留但不放行） ----------
    print("-- 7y. 仓库级开关 --")
    r = client.put("/api/sync/enabled", headers=HA(tok),
                   json={"vault": "default", "enabled": False})
    check(f"[{engine}] 关闭当前仓库同步", r.status_code == 200 and r.json().get("enabled") is False,
          r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(key))
    check(f"[{engine}] 关闭后令牌握手 403", r.status_code == 403, str(r.status_code) + r.text[:80])
    closed_msg = str((r.json() or {}).get("detail") or r.text)
    check(f"[{engine}] 关闭后提示仓库同步已关",
          "已关闭" in closed_msg and "同步" in closed_msg, closed_msg[:80])
    r = client.get("/api/sync/apikey?vault=default", headers=HA(tok))
    info = r.json() or {}
    check(f"[{engine}] 关闭后令牌仍在且未吊销",
          r.status_code == 200 and info.get("enabled") is True and info.get("vaultSync") is False,
          str(info)[:120])
    r = client.put("/api/sync/enabled", headers=HA(tok),
                   json={"vault": "default", "enabled": True})
    check(f"[{engine}] 重新开启当前仓库", r.status_code == 200 and r.json().get("enabled") is True,
          r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(key))
    check(f"[{engine}] 重开后原令牌可用", r.status_code == 200 and r.json().get("vault") == "default",
          r.text[:80])
    r = client.put("/api/sync/enabled", headers=HA(tok),
                   json={"vault": "system", "enabled": True})
    check(f"[{engine}] 系统仓不可开启", r.status_code == 400, str(r.status_code))

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

    # ---------- 11. 笔记仓库与握手 ----------
    print("-- 11. 仓库 / hello --")
    reset(engine)
    tok, key = reset(engine)
    r = client.get("/api/sync/hello", headers=HK(key))
    check(f"[{engine}] hello 握手", r.status_code == 200 and r.json().get("ok") is True
          and r.json().get("vault") == "default", str(r.status_code) + r.text[:80])
    r = client.get("/api/notes", headers=HA(tok))
    vids = {v["id"] for v in (r.json().get("vaults") or [])}
    check(f"[{engine}] 默认含 default+system 仓库",
          "default" in vids and "system" in vids, str(sorted(vids)))
    r = client.post("/api/sync/apikey", headers=HA(tok), json={"vault": "system"})
    check(f"[{engine}] 系统仓库禁止令牌", r.status_code == 400, str(r.status_code) + r.text[:80])
    r = client.post("/api/notes/vaults", headers=HA(tok), json={"name": "工区"})
    check(f"[{engine}] 自建仓库", r.status_code == 200 and bool(r.json().get("id")), r.text[:80])
    uv = r.json().get("id")
    r = client.post("/api/sync/apikey", headers=HA(tok), json={"vault": uv})
    check(f"[{engine}] 未开启时自建仓不能发令牌", r.status_code == 403, str(r.status_code) + r.text[:80])
    r = client.put("/api/sync/enabled", headers=HA(tok), json={"vault": uv, "enabled": True})
    check(f"[{engine}] 开启自建仓同步", r.status_code == 200 and r.json().get("enabled") is True,
          r.text[:80])
    r = client.post("/api/sync/apikey", headers=HA(tok), json={"vault": uv})
    ukey = r.json().get("apiKey", "")
    check(f"[{engine}] 自建仓库可发令牌", r.status_code == 200 and ukey.startswith("ohs_"), ukey[:12])
    r = client.get("/api/sync/hello", headers=HK(ukey))
    check(f"[{engine}] 自建令牌 hello 指向该仓",
          r.status_code == 200 and r.json().get("vault") == uv, r.text[:80])
    r = client.post("/api/notes", headers=HA(tok), json={"title": "仓内笔记", "vault": uv})
    gone_id = (r.json() or {}).get("id")
    check(f"[{engine}] 自建仓内建笔记", r.status_code == 200 and bool(gone_id), r.text[:80])
    r = client.post("/api/notes/folders", headers=HA(tok), json={"name": "仓内夹", "vault": uv})
    check(f"[{engine}] 自建仓内建文件夹", r.status_code == 200, r.text[:80])
    r = client.delete(f"/api/notes/vaults/{uv}", headers=HA(tok))
    check(f"[{engine}] 删除自建仓库", r.status_code == 200, str(r.status_code))
    r = client.get("/api/notes", headers=HA(tok))
    nd = r.json() or {}
    note_ids = [n.get("id") for n in (nd.get("notes") or [])]
    folders = nd.get("folders") or []
    check(f"[{engine}] 删仓后笔记不迁入默认仓", gone_id not in note_ids, str(note_ids[:8]))
    check(f"[{engine}] 删仓后文件夹一并删除", "仓内夹" not in folders, str(folders)[:80])
    r = client.delete("/api/notes/vaults/default", headers=HA(tok))
    check(f"[{engine}] 默认仓库不可删", r.status_code == 403, str(r.status_code))
    r = client.delete("/api/notes/vaults/system", headers=HA(tok))
    check(f"[{engine}] 系统仓库不可删", r.status_code == 403, str(r.status_code))
    r = client.put("/api/notes/vaults/select", headers=HA(tok), json={"vault": "system"})
    check(f"[{engine}] 切换当前仓库", r.status_code == 200 and r.json().get("current") == "system",
          r.text[:80])

    # ---------- 12. 笔记详情 + 分享 ----------
    print("-- 12. 分享 / get_note --")
    r = client.put("/api/notes/vaults/select", headers=HA(tok), json={"vault": "default"})
    check(f"[{engine}] 切回默认仓库", r.status_code == 200, r.text[:80])
    r = client.post("/api/notes", headers=HA(tok), json={"title": "分享测试"})
    nid = (r.json() or {}).get("id")
    check(f"[{engine}] 新建笔记", r.status_code == 200 and bool(nid), r.text[:80])
    r = client.put(f"/api/notes/{nid}", headers=HA(tok), json={"content": "hello share"})
    check(f"[{engine}] 写入正文", r.status_code == 200, r.text[:80])
    r = client.get(f"/api/notes/{nid}", headers=HA(tok))
    check(f"[{engine}] GET 笔记含正文", r.status_code == 200 and r.json().get("content") == "hello share",
          r.text[:80])
    r = client.post("/api/notes/shares", headers=HA(tok),
                    json={"kind": "note", "noteId": nid, "expireDays": 7, "canEdit": True})
    token = (r.json() or {}).get("token") or ""
    sid = (r.json() or {}).get("id") or ""
    check(f"[{engine}] 创建笔记分享", r.status_code == 200 and token.startswith("s_"), token[:12])
    r = client.put(f"/api/notes/shares/{sid}", headers=HA(tok), json={"canEdit": False})
    check(f"[{engine}] 更新分享关闭编辑", r.status_code == 200 and r.json().get("canEdit") is False,
          r.text[:80])
    r = client.get(f"/api/share/{token}")
    check(f"[{engine}] 关闭编辑后公开只读", r.status_code == 200 and r.json().get("canEdit") is False,
          r.text[:80])
    r = client.put(f"/api/notes/shares/{sid}", headers=HA(tok), json={"canEdit": True})
    check(f"[{engine}] 更新分享重新开启编辑", r.status_code == 200 and r.json().get("canEdit") is True,
          r.text[:80])
    r = client.get(f"/api/share/{token}")
    check(f"[{engine}] 公开读取分享", r.status_code == 200 and r.json().get("canEdit") is True, r.text[:80])
    check(f"[{engine}] 单篇分享不造文件夹树",
          r.json().get("folders") in ([], None), str(r.json().get("folders")))
    r = client.get(f"/api/share/{token}/notes/{nid}")
    check(f"[{engine}] 公开读笔记", r.status_code == 200 and r.json().get("content") == "hello share",
          r.text[:80])
    r = client.put(f"/api/share/{token}/notes/{nid}", json={"content": "edited via share"})
    check(f"[{engine}] 分享可编辑", r.status_code == 200, r.text[:80])
    r = client.get(f"/api/notes/{nid}", headers=HA(tok))
    check(f"[{engine}] 分享写入生效", r.status_code == 200 and r.json().get("content") == "edited via share",
          r.text[:80])
    r = client.post("/api/notes/folders", headers=HA(tok), json={"name": "sharefold"})
    check(f"[{engine}] 建文件夹", r.status_code == 200, r.text[:80])
    r = client.post("/api/notes/folders", headers=HA(tok), json={"name": "sharefold/sub"})
    check(f"[{engine}] 建子文件夹", r.status_code == 200, r.text[:80])
    r = client.post("/api/notes/folders", headers=HA(tok), json={"name": "sharefold/empty"})
    check(f"[{engine}] 建空子文件夹", r.status_code == 200, r.text[:80])
    r = client.post("/api/notes", headers=HA(tok), json={"title": "子笔记", "folder": "sharefold/sub"})
    check(f"[{engine}] 子文件夹内建笔记", r.status_code == 200, r.text[:80])
    r = client.post("/api/notes/shares", headers=HA(tok),
                    json={"kind": "folder", "folder": "sharefold", "expireDays": 1})
    ftoken = (r.json() or {}).get("token") or ""
    check(f"[{engine}] 分享文件夹", r.status_code == 200 and ftoken.startswith("s_"),
          ftoken[:12])
    r = client.get(f"/api/share/{ftoken}")
    sfolders = r.json().get("folders") or []
    check(f"[{engine}] 分享回 folders 含子目录",
          "sharefold" in sfolders and "sharefold/sub" in sfolders and "sharefold/empty" in sfolders,
          str(sfolders))
    r = client.get("/api/notes", headers=HA(tok))
    note_shares = [x for x in ((r.json() or {}).get("shares") or []) if x.get("noteId") == nid]
    check(f"[{engine}] 列表含 shares", isinstance((r.json() or {}).get("shares"), list)
          and len(r.json().get("shares") or []) >= 1, r.text[:80])
    check(f"[{engine}] 分享列表回显 token",
          any((x.get("token") or "") == token for x in note_shares), str(note_shares)[:80])
    r = client.post("/api/notes/shares", headers=HA(tok),
                    json={"kind": "note", "noteId": nid, "expireDays": 7,
                          "requireLogin": True})
    ltoken = (r.json() or {}).get("token") or ""
    check(f"[{engine}] 创建需登录分享", r.status_code == 200 and ltoken.startswith("s_"),
          ltoken[:12])
    r = client.get(f"/api/share/{ltoken}")
    check(f"[{engine}] 需登录分享未登录 401", r.status_code == 401, str(r.status_code))
    r = client.get(f"/api/share/{ltoken}", headers=HA(tok))
    check(f"[{engine}] 需登录分享已登录可读",
          r.status_code == 200 and r.json().get("requireLogin") is True, r.text[:80])
    r = client.post("/api/auth/login", json={"username": USER, "password": "wrong-pass"})
    det = ""
    try:
        det = str((r.json() or {}).get("detail") or "")
    except Exception:
        det = (r.text or "")[:80]
    check(f"[{engine}] 密码错误 401", r.status_code == 401, str(r.status_code))
    check(f"[{engine}] 密码错误提示含密码", "密码" in det, det[:80])
    r = client.get(f"/api/share/{token}/notes/{nid}/export")
    check(f"[{engine}] 分享下载当前 md",
          r.status_code == 200 and b"edited via share" in (r.content or b""),
          str(r.status_code))
    r = client.get(f"/api/share/{token}/export")
    check(f"[{engine}] 分享下载范围 zip",
          r.status_code == 200 and (r.content or b"").startswith(b"PK"),
          str(r.status_code))
    r = client.post("/api/notes/shares", headers=HA(tok),
                    json={"kind": "note", "noteId": nid, "expireDays": 7})
    check(f"[{engine}] 同笔记再生成一条分享", r.status_code == 200, r.text[:80])
    r = client.delete(f"/api/notes/shares/{sid}", headers=HA(tok))
    check(f"[{engine}] 取消分享", r.status_code == 200, str(r.status_code))
    r = client.get("/api/notes", headers=HA(tok))
    left = [x for x in ((r.json() or {}).get("shares") or []) if x.get("noteId") == nid]
    check(f"[{engine}] 取消后同笔记全部分享已吊销", left == [], str(left)[:80])
    r = client.get(f"/api/share/{token}")
    check(f"[{engine}] 旧链接已失效", r.status_code == 404, str(r.status_code))

    # ---------- 13. 团队仓库 + 成员同步审批 ----------
    print("-- 13. 团队仓库 / 审批 --")
    USER2 = "teammate"
    cfg = storage.get_config()
    cfg["users"][USER2] = {"password": sessions.hash_password("pw123456"),
                           "nickname": USER2, "role": "user",
                           "createdAt": "", "email": ""}
    storage.save_config(cfg)
    storage.ensure_user_dir(USER2)
    storage.delete_user_file(USER2, "notes/index.json")
    storage.save_user_json(USER2, "notes/folders.json", [])
    tok2 = sessions.create_session(USER2)
    client.get("/api/notes", headers=HA(tok2))
    r = client.post("/api/notes/vaults/default/team", headers=HA(tok))
    check(f"[{engine}] 默认仓不可转团队", r.status_code == 400, str(r.status_code))
    r = client.post("/api/notes/vaults/system/team", headers=HA(tok))
    check(f"[{engine}] 系统仓不可转团队", r.status_code == 400, str(r.status_code))
    r = client.post("/api/notes/vaults", headers=HA(tok), json={"name": "项目组"})
    tvid = (r.json() or {}).get("id")
    check(f"[{engine}] 再建自建仓", r.status_code == 200 and bool(tvid), r.text[:80])
    r = client.post(f"/api/notes/vaults/{tvid}/team", headers=HA(tok))
    invite = (r.json() or {}).get("token") or ""
    check(f"[{engine}] user 仓转团队", r.status_code == 200 and invite.startswith("t_"), invite[:12])
    r = client.post("/api/notes/vaults/join", headers=HA(tok2), json={"token": invite})
    check(f"[{engine}] 成员加入", r.status_code == 200 and r.json().get("id") == tvid, r.text[:80])
    r = client.post("/api/notes/vaults/join", headers=HA(tok2), json={"token": invite})
    check(f"[{engine}] 重复加入幂等", r.status_code == 200, r.text[:80])
    r = client.get("/api/notes", headers=HA(tok2))
    mvs = r.json().get("vaults") or []
    mv = next((v for v in mvs if v.get("id") == tvid), None)
    check(f"[{engine}] 成员仓库切换器可见团队仓",
          bool(mv) and mv.get("kind") == "team" and mv.get("canEdit") is False, str(mv))
    check(f"[{engine}] 成员投影不含邀请码", "invite" not in (mv or {}), str(mv))
    r = client.get(f"/api/notes/vaults/{tvid}/team", headers=HA(tok2))
    check(f"[{engine}] 成员看不到邀请 token",
          r.status_code == 200 and "token" not in r.json(), str(list((r.json() or {}).keys())))
    r = client.post("/api/notes", headers=HA(tok2), json={"title": "只读不可写", "vault": tvid})
    check(f"[{engine}] 只读成员新建 403", r.status_code == 403, str(r.status_code))
    r = client.post("/api/notes", headers=HA(tok), json={"title": "团队笔记", "vault": tvid})
    tnid = (r.json() or {}).get("id")
    check(f"[{engine}] 创建人在团队仓建笔记", r.status_code == 200 and bool(tnid), r.text[:80])
    r = client.put(f"/api/notes/{tnid}", headers=HA(tok2), json={"content": "hack"})
    check(f"[{engine}] 只读成员改笔记 403", r.status_code == 403, str(r.status_code))
    r = client.put(f"/api/notes/vaults/{tvid}/members/{USER2}", headers=HA(tok),
                   json={"canEdit": True})
    check(f"[{engine}] 开启成员编辑权", r.status_code == 200 and r.json().get("canEdit") is True,
          r.text[:80])
    r = client.put(f"/api/notes/{tnid}", headers=HA(tok2), json={"content": "member edit"})
    check(f"[{engine}] 可编辑成员改笔记", r.status_code == 200, r.text[:80])
    r = client.get(f"/api/notes/{tnid}", headers=HA(tok))
    check(f"[{engine}] 成员写入落创建人存储",
          r.status_code == 200 and r.json().get("content") == "member edit", r.text[:80])
    r = client.post("/api/sync/apikey", headers=HA(tok2), json={"vault": tvid})
    check(f"[{engine}] 创建人未开同步时成员不能发钥", r.status_code == 403, str(r.status_code))
    r = client.put("/api/sync/enabled", headers=HA(tok), json={"vault": tvid, "enabled": True})
    check(f"[{engine}] 创建人开启仓库同步开关",
          r.status_code == 200 and r.json().get("enabled") is True, r.text[:80])
    r = client.post("/api/sync/apikey", headers=HA(tok2), json={"vault": tvid})
    mkey = (r.json() or {}).get("apiKey") or ""
    check(f"[{engine}] 开启同步后成员无需创建人令牌即可发钥",
          r.status_code == 200 and mkey.startswith("ohs_"), mkey[:12] + r.text[:80])
    r = client.post("/api/sync/apikey", headers=HA(tok), json={"vault": tvid})
    okey = (r.json() or {}).get("apiKey") or ""
    check(f"[{engine}] 创建人团队仓令牌", r.status_code == 200 and okey.startswith("ohs_"), okey[:12])
    r = client.get("/api/sync/hello", headers=HK(mkey))
    check(f"[{engine}] 成员钥 hello 指向创建人仓",
          r.status_code == 200 and r.json().get("vault") == tvid
          and r.json().get("pluginMin") == "0.0.6", r.text[:80])
    check(f"[{engine}] 创建人与成员团队仓令牌不同",
          okey != mkey and okey.startswith("ohs_") and mkey.startswith("ohs_"),
          (okey[:12], mkey[:12]))
    r = client.post("/api/sync/apikey?vault=default", headers=HA(tok), json={"vault": "default"})
    dkey = (r.json() or {}).get("apiKey") or ""
    check(f"[{engine}] 创建人默认仓令牌与团队仓不同",
          r.status_code == 200 and dkey.startswith("ohs_") and dkey != okey
          and (r.json() or {}).get("vault") == "default", r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(dkey))
    check(f"[{engine}] 默认仓令牌 hello 指向 default",
          r.status_code == 200 and r.json().get("vault") == "default", r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(okey))
    check(f"[{engine}] 重置默认仓后团队仓钥仍有效",
          r.status_code == 200 and r.json().get("vault") == tvid, r.text[:80])
    r = client.post("/api/sync/apikey?vault=" + tvid, headers=HA(tok))
    qkey = (r.json() or {}).get("apiKey") or ""
    check(f"[{engine}] 仅 query vault 签发到团队仓",
          r.status_code == 200 and (r.json() or {}).get("vault") == tvid
          and qkey.startswith("ohs_") and qkey != dkey, r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(qkey))
    check(f"[{engine}] query 签发的钥 hello 指向团队仓",
          r.status_code == 200 and r.json().get("vault") == tvid, r.text[:80])
    r = client.get("/api/sync/hello", headers=HK(dkey))
    check(f"[{engine}] 重置团队仓不影响默认仓钥",
          r.status_code == 200 and r.json().get("vault") == "default", r.text[:80])
    okey = qkey
    r = client.delete("/api/sync/apikey?vault=" + tvid, headers=HA(tok))
    check(f"[{engine}] 创建人吊销自己的团队仓钥", r.status_code == 200, str(r.status_code))
    r = client.get("/api/sync/hello", headers=HK(okey))
    check(f"[{engine}] 创建人旧团队钥已失效", r.status_code == 401, str(r.status_code))
    r = client.get("/api/sync/hello", headers=HK(mkey))
    check(f"[{engine}] 吊销创建人钥不影响成员钥",
          r.status_code == 200 and r.json().get("vault") == tvid, r.text[:80])
    r = client.post("/api/sync/apikey?vault=" + tvid, headers=HA(tok), json={"vault": tvid})
    okey = (r.json() or {}).get("apiKey") or ""
    check(f"[{engine}] 创建人重新签发团队仓钥",
          r.status_code == 200 and okey.startswith("ohs_"), okey[:12])
    r = client.post("/api/notes/folders", headers=HA(tok), json={"name": "工作", "vault": "default"})
    check(f"[{engine}] 创建人默认仓先占同名文件夹", r.status_code == 200, r.text[:80])
    now_ms = int(time.time() * 1000)
    r = client.post("/api/sync/file", headers=HK(mkey),
                    json={"path": "工作/子夹/成员笔记.md",
                          "content": "# 成员笔记\n\nhi", "clientMtime": now_ms})
    check(f"[{engine}] 成员可推送嵌套文件夹笔记",
          r.status_code == 200 and (r.json() or {}).get("applied") is True, r.text[:120])
    r = client.get("/api/notes", headers=HA(tok2))
    nd = r.json() or {}
    folders2 = nd.get("folders") or []
    fv2 = nd.get("folderVault") or {}
    hit_n = next((n for n in (nd.get("notes") or []) if n.get("title") == "成员笔记"), None)
    check(f"[{engine}] 成员笔记落团队仓且带文件夹",
          bool(hit_n) and hit_n.get("vault") == tvid and hit_n.get("folder") == "工作/子夹",
          str(hit_n)[:120])
    check(f"[{engine}] 成员可见团队仓文件夹",
          "工作" in folders2 and "工作/子夹" in folders2, str(folders2)[:120])

    def _claimed(fv, name, vid):
        cur = (fv or {}).get(name)
        if isinstance(cur, list):
            return vid in cur
        return cur == vid
    check(f"[{engine}] 同名文件夹被团队仓认领（不抢默认仓）",
          _claimed(fv2, "工作", tvid) and _claimed(fv2, "工作/子夹", tvid), str(fv2.get("工作")))
    r = client.get("/api/notes", headers=HA(tok))
    ndo = r.json() or {}
    check(f"[{engine}] 创建人也能看到团队仓嵌套文件夹",
          "工作/子夹" in (ndo.get("folders") or [])
          and _claimed(ndo.get("folderVault") or {}, "工作/子夹", tvid),
          str((ndo.get("folderVault") or {}).get("工作/子夹")))
    for i in range(12):
        client.post("/api/notes", headers=HA(tok), json={"title": "td%d" % i, "vault": tvid})
    for i in range(10):
        rd = client.delete("/api/sync/file", headers=HK(mkey), params={"path": "td%d.md" % i})
        check(f"[{engine}] 成员删第 {i+1} 篇", rd.status_code == 200, rd.text[:80])
    r = client.delete("/api/sync/file", headers=HK(mkey), params={"path": "td10.md"})
    check(f"[{engine}] 成员第 11 篇无票 403", r.status_code == 403, str(r.status_code) + r.text[:60])
    r = client.post("/api/sync/approvals", headers=HK(mkey),
                    json={"kind": "bulk-delete", "paths": ["td10.md", "td11.md"]})
    aid = (r.json() or {}).get("id") or ""
    check(f"[{engine}] 成员提交 bulk-delete 审批", r.status_code == 200 and bool(aid), r.text[:80])
    r = client.get("/api/inbox", headers=HA(tok))
    items = r.json().get("items") or []
    hit_in = next((x for x in items if x.get("ref") == aid), None)
    check(f"[{engine}] 创建人收件箱有待审批", bool(hit_in), str(items[:2])[:80])
    r = client.put("/api/inbox/" + hit_in["id"], headers=HA(tok),
                   json={"action": "approve", "read": True})
    check(f"[{engine}] 创建人批准", r.status_code == 200, r.text[:80])
    r = client.get("/api/sync/approvals/" + aid, headers=HK(mkey))
    check(f"[{engine}] 成员轮询获批", r.status_code == 200 and r.json().get("status") == "approved",
          r.text[:80])
    r = client.delete("/api/sync/file", headers={**HK(mkey), "X-Sync-Approval": aid},
                      params={"path": "td10.md"})
    check(f"[{engine}] 有票可删第 11 篇", r.status_code == 200, r.text[:80])
    r = client.delete("/api/sync/file", headers=HK(okey), params={"path": "td11.md"})
    check(f"[{engine}] 创建人删除不需票", r.status_code == 200, r.text[:80])
    far = int(time.time() * 1000) + 86400000
    r = client.post("/api/sync/file", headers=HK(mkey),
                    json={"path": "团队笔记.md", "content": "# 团队笔记\n\noverwrite",
                          "clientMtime": far})
    check(f"[{engine}] 成员超窗口覆盖无票 403", r.status_code == 403, str(r.status_code))
    r = client.post("/api/sync/approvals", headers=HK(mkey), json={"kind": "overwrite"})
    oid = (r.json() or {}).get("id") or ""
    check(f"[{engine}] 提交 overwrite 审批", r.status_code == 200 and bool(oid), r.text[:80])
    r = client.get("/api/inbox", headers=HA(tok))
    oin = next((x for x in (r.json().get("items") or []) if x.get("ref") == oid), None)
    client.put("/api/inbox/" + oin["id"], headers=HA(tok), json={"action": "approve", "read": True})
    r = client.post("/api/sync/file", headers={**HK(mkey), "X-Sync-Approval": oid},
                    json={"path": "团队笔记.md", "content": "# 团队笔记\n\noverwrite",
                          "clientMtime": far})
    check(f"[{engine}] 有覆盖票可强制写", r.status_code == 200 and r.json().get("applied") is True,
          r.text[:80])
    r = client.post("/api/sync/approvals", headers=HK(okey), json={"kind": "overwrite"})
    check(f"[{engine}] 创建人无需提交审批", r.status_code == 400, str(r.status_code))
    r = client.delete(f"/api/notes/vaults/{tvid}", headers=HA(tok2))
    check(f"[{engine}] 成员不能删团队仓", r.status_code == 403, str(r.status_code))
    r = client.post("/api/notes/vaults", headers=HA(tok), json={"name": "可删仓"})
    dvid = (r.json() or {}).get("id")
    r = client.delete(f"/api/notes/vaults/{dvid}", headers=HA(tok))
    check(f"[{engine}] user 仓删除仍 200", r.status_code == 200, str(r.status_code))
    r = client.delete(f"/api/notes/vaults/{tvid}/team", headers=HA(tok))
    check(f"[{engine}] 创建人转回普通仓", r.status_code == 200, r.text[:80])
    r = client.get("/api/notes", headers=HA(tok2))
    left_ids = {v.get("id") for v in (r.json().get("vaults") or [])}
    check(f"[{engine}] 转回后成员投影消失", tvid not in left_ids, str(sorted(left_ids)))
    r = client.get("/api/sync/list", headers=HK(mkey))
    check(f"[{engine}] 转回后成员钥吊销", r.status_code == 401, str(r.status_code))

    st = sessions.create_session("t")
    sessions._sessions.clear()
    sessions.load_sessions()
    check(f"[{engine}] 会话落盘后可恢复", sessions.get_session_user(st) == "t", "reload")


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
