# -*- coding: utf-8 -*-
"""阶段 C-A：file → sqlite 引擎切换迁移（API 层）。
造数据 → 快照 → 切 sqlite → 逐模块对比。快照存 /tmp/omni-s6-snapshot.json 供重启后复用。"""
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"
OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("PASS  " if cond else "FAIL  ") + name + (f"  [{extra}]" if extra else ""))


def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return -1, str(e)


st, r = api("POST", "/api/auth/login", {"username": "test", "password": "test123"})
T = r.get("token", "")

# 1. 造数据（书签×3 + 分类 + 笔记×2 + 日历×2 + 保险库 + 计划 + 偏好）
api("DELETE", "/api/data/wipe", {"password": "test123"}, token=T)
for i in range(3):
    api("POST", "/api/bookmarks",
        {"name": f"切换书签{i}", "url": f"https://sw{i}.example.com",
         "desc": "d", "tags": ["t"], "cat": "dev", "hue": i}, token=T)
api("POST", "/api/bookmark-cats", {"name": "切换分类"}, token=T)
api("POST", "/api/notes/folders", {"name": "切换夹"}, token=T)
nids = []
for i in range(2):
    st, r = api("POST", "/api/notes", {"title": f"切换笔记{i}", "tags": [],
                                       "folder": "切换夹"}, token=T)
    nids.append(r.get("id"))
    api("PUT", f"/api/notes/{nids[-1]}", {"content": f"# 切换笔记{i}\n正文{i}"}, token=T)
for i in range(2):
    api("POST", "/api/calendar", {"date": "2026-09-0%d" % (i + 1),
                                  "title": f"切换日程{i}", "note": "n"}, token=T)
api("PUT", "/api/vault", {"check": "ck-sw", "salt": "sa",
                          "items": {"v1": {"blob": "B-SW"}}}, token=T)
api("PUT", "/api/plan", {"content": "- [ ] 切换任务\n"}, token=T)

# 2. 快照
snap = {
    "bookmarks": api("GET", "/api/bookmarks", token=T)[1],
    "cats": api("GET", "/api/bookmark-cats", token=T)[1],
    "notes": api("GET", "/api/notes", token=T)[1],
    "calendar": api("GET", "/api/calendar?month=2026-09", token=T)[1],
    "vault": api("GET", "/api/vault", token=T)[1],
    "plan": api("GET", "/api/plan", token=T)[1],
}
for n in nids:
    snap[f"note_body_{n}"] = api("GET", f"/api/notes/{n}", token=T)[1]
json.dump(snap, open("/tmp/omni-s6-snapshot.json", "w"), ensure_ascii=False)
print("快照已存:", {k: (len(v) if isinstance(v, list) else "obj") for k, v in snap.items()})

# 3. 切换到 sqlite
st, r = api("POST", "/api/data/storage", {"engine": "sqlite", "url": ""}, token=T)
check("切换 sqlite 返回", st == 200 and "moved" in r, str(r)[:200])
mig = r.get("moved", 0)
print("迁移条目数:", mig)

# 4. 逐模块对比（name=快照键, key=API 路径）
def cmp(name, key):
    st, r = api("GET", "/api/" + key, token=T)
    want = snap.get(name)
    got = r
    if name == "notes":   # 接口返回 {notes, folders}
        got = r.get("notes", [])
        want = want.get("notes", []) if isinstance(want, dict) else want
    same = (want is not None and
            json.dumps(want, sort_keys=True, ensure_ascii=False) ==
            json.dumps(got, sort_keys=True, ensure_ascii=False))
    check(f"迁移后 {name} 一致", same, str(got)[:120])


cmp("bookmarks", "bookmarks")
cmp("cats", "bookmark-cats")
cmp("notes", "notes")
cmp("calendar", "calendar?month=2026-09")
cmp("vault", "vault")
cmp("plan", "plan")
for k, v in snap.items():
    if k.startswith("note_body_"):
        nid = k.split("_")[2]
        st, r = api("GET", f"/api/notes/{nid}", token=T)
        check(f"迁移后 {k} 一致",
              json.dumps(v, sort_keys=True) == json.dumps(r, sort_keys=True),
              str(r)[:100])

st, r = api("GET", "/api/data/storage", token=T)
check("存储状态为 sqlite", st == 200 and r.get("engine") == "sqlite", str(r)[:120])
st, r = api("GET", "/api/data/stats", token=T)
check("迁移后统计可读", st == 200, str(r)[:150])

print("\n===== 阶段 C-A 结果：%d 通过 / %d 失败 =====" % (len(OK), len(FAIL)))
print("失败项:", FAIL if FAIL else "无")
