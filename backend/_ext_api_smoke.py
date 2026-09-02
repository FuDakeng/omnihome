"""插件 API 冒烟：验证扩展将使用的接口形态（跑完自动清理）。"""
import json
import urllib.request

BASE = "http://localhost:8000"


def req(method, path, body=None, token=None):
    r = urllib.request.Request(BASE + path, method=method)
    if token:
        r.add_header("Authorization", "Bearer " + token)
    data = None
    if body is not None:
        r.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(r, data, timeout=5) as f:
        return json.loads(f.read())


ok = 0
fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, extra)


d = req("POST", "/api/auth/login", {"username": "test", "password": "test123"})
check("登录返回 token+user", bool(d.get("token")) and d.get("user", {}).get("username") == "test")
T = d["token"]

cats = req("GET", "/api/bookmark-cats", token=T)
check("分类为列表且含内置 all/none",
      isinstance(cats, list) and {"all", "none"} <= {c["id"] for c in cats}, str(cats)[:80])
check("分类字段 id/name", all("id" in c and "name" in c for c in cats))

bms = req("GET", "/api/bookmarks", token=T)
check("书签为列表", isinstance(bms, list))
if bms:
    b0 = bms[0]
    check("书签字段齐全", all(k in b0 for k in ("id", "name", "url", "cat", "order")))

bid = None
try:
    r = req("POST", "/api/bookmarks",
            {"name": "插件冒烟书签", "url": "https://ext-smoke.example.com", "cat": "common"}, token=T)
    bid = r.get("id")
    check("新增书签返回 id", bool(bid))
    check("新增书签 order 自动分配", r.get("order") is not None)
    bms = req("GET", "/api/bookmarks", token=T)
    hit = [b for b in bms if b.get("id") == bid]
    check("列表可见新书签", bool(hit) and hit[0]["cat"] == "common")
finally:
    if bid:
        req("DELETE", "/api/bookmarks/" + bid, token=T)
        bms = req("GET", "/api/bookmarks", token=T)
        check("清理冒烟书签", all(b.get("id") != bid for b in bms))

# 401 行为：无效 token
import urllib.error
try:
    urllib.request.urlopen(urllib.request.Request(
        BASE + "/api/bookmarks", headers={"Authorization": "Bearer invalid"}), timeout=5)
    check("无效 token 返回 401", False, "未抛异常")
except urllib.error.HTTPError as e:
    check("无效 token 返回 401", e.code == 401)

print("\n结果：%d 通过 / %d 失败" % (ok, fail))
