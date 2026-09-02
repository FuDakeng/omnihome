# -*- coding: utf-8 -*-
"""阶段 C-B：SQLite 引擎服务重启后的数据持久化验证。
读 /tmp/omni-s6-snapshot.json（C-A 阶段快照），登录后逐模块对比。"""
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


snap = json.load(open("/tmp/omni-s6-snapshot.json"))
print("快照模块:", list(snap.keys()))

st, r = api("POST", "/api/auth/login", {"username": "test", "password": "test123"})
check("重启后登录", st == 200 and "token" in r, str(r)[:80])
T = r.get("token", "")


def cmp(name, key):
    st, r = api("GET", "/api/" + key, token=T)
    want, got = snap.get(name), r
    if name == "notes":
        got = r.get("notes", [])
        want = want.get("notes", []) if isinstance(want, dict) else want
    same = (want is not None and
            json.dumps(want, sort_keys=True, ensure_ascii=False) ==
            json.dumps(got, sort_keys=True, ensure_ascii=False))
    check(f"重启后 {name} 一致", same, str(got)[:120])


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
        check(f"重启后 {k} 一致",
              json.dumps(v, sort_keys=True) == json.dumps(r, sort_keys=True),
              str(r)[:100])

st, r = api("GET", "/api/data/storage", token=T)
check("重启后引擎仍为 sqlite", st == 200 and r.get("engine") == "sqlite", str(r)[:120])
st, r = api("GET", "/api/data/stats", token=T)
check("重启后统计可读", st == 200 and r.get("bookmarks") == 3, str(r)[:150])

print("\n===== 阶段 C-B 结果：%d 通过 / %d 失败 =====" % (len(OK), len(FAIL)))
print("失败项:", FAIL if FAIL else "无")
