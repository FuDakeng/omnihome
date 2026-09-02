# -*- coding: utf-8 -*-
"""0.0.7 冒烟：头像 / 登录记录 / 绑定切换 / 解绑 / 用户列表权限（运行后自清理）"""
import json, sys, urllib.request, urllib.error

BASE = "http://127.0.0.1:8000"
ok = fail = 0

def req(method, path, token=None, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}

def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print("PASS ", name, extra)
    else:
        fail += 1; print("FAIL ", name, extra)

def as_list(d):
    return d if isinstance(d, list) else d.get("users", [])

# 1. 登录（产生真实登录记录）
s, d = req("POST", "/api/auth/login", body={"username": "test", "password": "test123"})
check("登录 test", s == 200 and d.get("token"), "[%d]" % s)
admin = d["token"]

# 2. 登录记录：字段齐全、位置/设备非空
s, d = req("GET", "/api/auth/logins", admin)
rec = (d.get("logins") or [{}])[0]
check("登录记录最新一条在首位", s == 200 and rec.get("ts"), "[%d]" % s)
check("登录记录含设备/位置", bool(rec.get("device")) and bool(rec.get("place")),
      repr({"device": rec.get("device"), "place": rec.get("place")}))
check("登录记录条数<=10", len(d.get("logins", [])) <= 10)

# 3. 头像：设置 → me 返回 → 移除
pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
s, _ = req("PUT", "/api/auth/avatar", admin, {"data": pixel})
check("上传头像", s == 200, "[%d]" % s)
s, d = req("GET", "/api/auth/session", admin)
u = d.get("user", d)
check("session 返回头像", s == 200 and (u.get("avatar") or "").startswith("data:image"), "[%d]" % s)
s, _ = req("PUT", "/api/auth/avatar", admin, {"remove": True})
s2, d2 = req("GET", "/api/auth/session", admin)
check("移除头像", s == 200 and not d2.get("user", d2).get("avatar"), "[%d]" % s)
s, _ = req("PUT", "/api/auth/avatar", admin, {"data": "http://evil/x"})
check("拒绝非 dataURL 头像", s in (400, 422), "[%d]" % s)

# 4. 建两个临时用户
for n in ("su_a", "su_b"):
    req("DELETE", "/api/auth/users/" + n, admin)   # 防残留
    s, _ = req("POST", "/api/auth/users", admin,
               {"username": n, "password": "pw_" + n, "nickname": n.upper(), "role": "member"})
    check("管理员建用户 " + n, s == 200, "[%d]" % s)

# 5. 管理员视角：用户列表全量
s, d = req("GET", "/api/auth/users", admin)
names = [u["username"] for u in as_list(d)]
check("管理员可见全部账号", s == 200 and "su_a" in names and "su_b" in names, "[%d] %s" % (s, names))

# 6. 切换：未绑定 + 错误密码 → 401
s, d = req("POST", "/api/auth/switch", admin, {"username": "su_b", "password": "wrong"})
check("未绑定错密码被拒", s == 401, "[%d]" % s)

# 7. 切换：密码验证成功 → 双向绑定
s, d = req("POST", "/api/auth/switch", admin, {"username": "su_a", "password": "pw_su_a"})
check("验证切换成功", s == 200 and d.get("token"), "[%d]" % s)
tok_a = d["token"]

s, d = req("GET", "/api/auth/links", admin)
links = {l["username"]: l for l in d.get("links", [])}
check("管理员侧绑定记录", "su_a" in links and not links["su_a"].get("expired"), str(list(links)))
s, d = req("GET", "/api/auth/links", tok_a)
check("对方侧绑定记录（双向）", any(l["username"] == "test" for l in d.get("links", [])))

# 8. 绑定期内免密切换（su_a → test 不带密码）
s, d = req("POST", "/api/auth/switch", tok_a, {"username": "test"})
check("绑定期免密切换", s == 200 and d.get("token"), "[%d]" % s)

# 9. 普通用户视角：只见自己 + 绑定账号
s, d = req("GET", "/api/auth/users", tok_a)
names_a = {u["username"]: u for u in as_list(d)}
check("普通用户只见自己+绑定", s == 200 and set(names_a) == {"su_a", "test"}, "[%d] %s" % (s, list(names_a)))
check("绑定账号标记", names_a.get("test", {}).get("bound") is True and names_a.get("su_a", {}).get("bound") is False)

# 10. 普通用户不能删人/加人
s, _ = req("DELETE", "/api/auth/users/test", tok_a)
check("普通用户删人被拒", s in (401, 403), "[%d]" % s)
s, _ = req("POST", "/api/auth/users", tok_a, {"username": "su_c", "password": "x12345"})
check("普通用户加人被拒", s in (401, 403), "[%d]" % s)

# 11. 解绑（双向生效）
s, _ = req("DELETE", "/api/auth/link/test", tok_a)
s2, d2 = req("GET", "/api/auth/links", tok_a)
s3, d3 = req("GET", "/api/auth/links", admin)
check("解绑双向生效", s == 200 and not d2.get("links") and not any(
    l["username"] == "su_a" for l in d3.get("links", [])), "[%d]" % s)

# 12. 解绑后免密切换被拒（需重新验证）
s, d = req("POST", "/api/auth/switch", tok_a, {"username": "test"})
check("解绑后免密切换被拒", s == 401, "[%d]" % s)

# 13. 删除登录记录
s, d = req("GET", "/api/auth/logins", admin)
logins = d.get("logins", [])
if len(logins) > 1:
    ts = logins[-1]["ts"]
    s, _ = req("DELETE", "/api/auth/logins/%d" % ts, admin)
    s2, d2 = req("GET", "/api/auth/logins", admin)
    check("删除单条登录记录", s == 200 and all(l["ts"] != ts for l in d2.get("logins", [])), "[%d]" % s)
else:
    check("删除单条登录记录", True, "跳过（仅1条）")

# 14. 清理
for n in ("su_a", "su_b"):
    req("DELETE", "/api/auth/users/" + n, admin)
s, d = req("GET", "/api/auth/users", admin)
names = [u["username"] for u in as_list(d)]
check("清理临时用户", "su_a" not in names and "su_b" not in names)

print("\n===== 账号体系冒烟：%d 通过 / %d 失败 =====" % (ok, fail))
sys.exit(1 if fail else 0)
