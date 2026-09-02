# -*- coding: utf-8 -*-
"""API 全链路回归（阶段 A：file 引擎核心接口；阶段 B：多用户隔离）。
针对运行在 127.0.0.1:8000 的服务；结束时清理测试数据。"""
import json
import time
import urllib.request
import urllib.error
from urllib.parse import quote

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


# ---------- A0. 前置：干净状态 + 开放注册 ----------
print("== A0. 前置 ==")
st, r = api("POST", "/api/auth/login", {"username": "test", "password": "test123"})
TO = r.get("token", "")
st, r = api("DELETE", "/api/data/wipe", {"password": "test123"}, token=TO)
check("前置清空数据", st == 200, str(st))
st, r = api("PUT", "/api/auth/register-config", {"allowRegister": True}, token=TO)
check("前置开放注册", st == 200, str(st))

# ---------- A1. 登录 ----------
print("== A1. 登录 ==")
st, r = api("POST", "/api/auth/login", {"username": "test", "password": "test123"})
check("登录 test", st == 200 and r.get("token"), str(st))
T = r.get("token", "")

st, r = api("GET", "/api/auth/session", token=T)
check("会话有效", st == 200 and r.get("user", {}).get("username") == "test", str(r)[:80])

# ---------- A2. 书签 ----------
print("== A2. 书签 ==")
st, r = api("GET", "/api/bookmarks", token=T)
check("书签列表(可空)", st == 200 and isinstance(r, list), str(type(r)))
n0 = len(r)
st, r = api("POST", "/api/bookmarks",
            {"name": "回归书签A", "url": "https://reg-a.example.com",
             "desc": "d", "tags": ["t"], "cat": "dev", "hue": 10}, token=T)
check("新增书签", st == 200 and r.get("name") == "回归书签A", str(st))
bid = r.get("id", "")
st, r = api("PUT", f"/api/bookmarks/{bid}",
            {"name": "回归书签A-改", "url": "https://reg-a.example.com/2",
             "desc": "d2", "tags": ["t2"], "cat": "dev", "hue": 20}, token=T)
check("更新书签", st == 200 and r.get("name") == "回归书签A-改", str(st))
st, r = api("PUT", "/api/bookmarks",
            [{"id": bid, "name": "全量替换1", "url": "https://r1.example.com",
              "desc": "", "tags": [], "cat": "dev", "hue": 0, "order": 0}], token=T)
check("全量替换书签", st == 200 and len(r) == 1, str(st))
st, r = api("DELETE", f"/api/bookmarks/{bid}", token=T)
check("删除书签", st == 200 and r.get("ok") is True, str(st))

# ---------- A3. 分类 ----------
print("== A3. 分类 ==")
st, r = api("GET", "/api/bookmark-cats", token=T)
check("分类列表", st == 200 and isinstance(r, list), str(type(r)))
st, r = api("POST", "/api/bookmark-cats", {"name": "回归分类"}, token=T)
check("新增分类", st == 200 and r.get("name") == "回归分类", str(st))
cid = r.get("id", "")
st, r = api("PUT", f"/api/bookmark-cats/{cid}", {"name": "回归分类-改"}, token=T)
check("重命名分类", st == 200 and r.get("name") == "回归分类-改", str(st))
st, r = api("DELETE", f"/api/bookmark-cats/{cid}", token=T)
check("删除分类", st == 200, str(st))

# ---------- A4. 笔记 ----------
print("== A4. 笔记 ==")
st, r = api("POST", "/api/notes", {"title": "回归笔记", "tags": [], "folder": "回归"})
check("笔记未授权拒绝", st in (401, 403), str(st))
st, r = api("POST", "/api/notes/folders", {"name": "回归文件夹"}, token=T)
check("新增文件夹", st == 200, str(st))
st, r = api("POST", "/api/notes", {"title": "回归笔记", "tags": ["a"], "folder": "回归"}, token=T)
check("创建笔记", st == 200 and r.get("title") == "回归笔记", str(st))
nid = r.get("id", "")
st, r = api("PUT", f"/api/notes/{nid}", {"content": "# 回归正文\n内容内容"}, token=T)
check("保存笔记正文", st == 200, str(st))
st, r = api("GET", f"/api/notes/{nid}", token=T)
check("读取笔记正文", st == 200 and r.get("content", "").startswith("# 回归正文"), str(st))
st, r = api("GET", "/api/notes", token=T)
check("笔记列表", st == 200 and any(n["id"] == nid for n in r.get("notes", [])), str(st))
st, r = api("DELETE", f"/api/notes/{nid}", token=T)
check("删除笔记", st == 200, str(st))
st, r = api("DELETE", "/api/notes/folders/" + quote("回归文件夹"), token=T)
check("删除文件夹", st == 200, str(st))

# ---------- A5. 日历 ----------
print("== A5. 日历 ==")
st, r = api("GET", "/api/calendar?month=2026-09", token=T)
check("日历列表", st == 200 and isinstance(r, list), str(st))
st, r = api("POST", "/api/calendar", {"date": "2026-09-01", "title": "回归日程",
                                      "note": "n"}, token=T)
check("新增日程", st == 200 and r.get("date") == "2026-09-01", str(st))
eid = r.get("id", "")
st, r = api("GET", "/api/calendar?month=2026-09", token=T)
check("日历按月过滤", st == 200 and any(e["id"] == eid for e in r), str(st))
st, r = api("DELETE", f"/api/calendar/{eid}", token=T)
check("删除日程", st == 200, str(st))

# ---------- A6. 保险库 / 计划 / 仪表盘 / 偏好 ----------
print("== A6. 保险库/计划/仪表盘/偏好 ==")
st, r = api("GET", "/api/vault", token=T)
check("保险库读取", st == 200, str(st))
st, r = api("PUT", "/api/vault", {"check": "ck-reg", "salt": "sa",
                                  "items": {"v1": {"blob": "B1"}},
                                  "updatedAt": 1787000000}, token=T)
check("保险库写入", st == 200 and r.get("ok") is True, str(st))
st, r = api("GET", "/api/vault", token=T)
check("保险库读回", r.get("items", {}).get("v1", {}).get("blob") == "B1", str(st))
st, r = api("GET", "/api/plan", token=T)
check("计划读取", st == 200, str(st))
st, r = api("PUT", "/api/plan", {"content": "- [ ] 回归任务\n", "updated": 1787000000}, token=T)
check("计划写入", st == 200 and r.get("ok") is True, str(st))
st, r = api("GET", "/api/plan", token=T)
check("计划读回", "- [ ] 回归任务" in r.get("content", ""), str(st))
st, r = api("GET", "/api/dashboard", token=T)
check("仪表盘读取", st == 200, str(st))
st, r = api("PUT", "/api/dashboard", {"widgets": [], "updated": 1787000000}, token=T)
check("仪表盘写入", st == 200, str(st))
st, r = api("GET", "/api/settings", token=T)
check("偏好读取", st == 200 and "theme" in r, str(st))
st, r = api("PUT", "/api/settings", {"theme": {"mode": "light", "hue": 1, "sat": 2},
                                     "layout": {}, "locale": {}, "weather": {}}, token=T)
check("偏好写入", st == 200, str(st))

# ---------- A7. 备份 / 统计 / 导出 ----------
print("== A7. 备份/统计/导出 ==")
st, r = api("PUT", "/api/data/backup-config", {"auto": False, "intervalHours": 24,
                                               "keep": 3, "lastAuto": 0}, token=T)
check("备份配置写入", st == 200, str(st))
st, r = api("POST", "/api/data/backup", token=T)
check("手动备份", st == 200 and r.get("name"), str(st))
bkname = r.get("name", "")
st, r = api("GET", "/api/data/stats", token=T)
check("存储统计", st == 200 and "bytes" in r and "notes" in r, str(st))
st, r = api("GET", "/api/data/storage", token=T)
check("存储状态", st == 200 and r.get("engine") == "file", str(st))
req = urllib.request.Request(BASE + "/api/data/export")
req.add_header("Authorization", "Bearer " + T)
try:
    with urllib.request.urlopen(req, timeout=30) as rsp:
        blob = rsp.read()
    check("全量导出", rsp.status == 200 and len(blob) > 0, f"{len(blob)}B")
except Exception as e:
    check("全量导出", False, str(e))
# 恢复（先删一条再恢复）
st, r = api("DELETE", f"/api/calendar/{eid}", token=T)  # 已删，幂等
st, r = api("POST", "/api/data/restore", {"name": bkname}, token=T)
check("备份恢复", st == 200 and r.get("restored", 0) > 0, str(r)[:120])

# ---------- A8. 清空数据 ----------
print("== A8. 清空数据 ==")
st, r = api("DELETE", "/api/data/wipe", {"password": "wrong-pass"}, token=T)
check("错误密码清空被拒", st in (400, 403), str(st))
st, r = api("DELETE", "/api/data/wipe", {"password": "test123"}, token=T)
check("清空数据", st == 200, str(st))
st, r = api("GET", "/api/bookmarks", token=T)
check("清空后书签为空", st == 200 and r == [], str(st))

# ---------- B. 多用户 ----------
print("== B. 多用户 ==")
st, r = api("POST", "/api/auth/register", {"username": "u_s6_a",
                                           "password": "pw-a-12345",
                                           "nickname": "用户A"})
check("注册用户A", st == 200, str(st))
st, r = api("POST", "/api/auth/login", {"username": "u_s6_a", "password": "pw-a-12345"})
check("用户A登录", st == 200 and r.get("token"), str(st))
TA = r.get("token", "")
st, r = api("POST", "/api/auth/register", {"username": "u_s6_b",
                                           "password": "pw-b-12345",
                                           "nickname": "用户B"})
check("注册用户B", st == 200, str(st))
st, r = api("POST", "/api/auth/login", {"username": "u_s6_b", "password": "pw-b-12345"})
TB = r.get("token", "")
st, r = api("POST", "/api/bookmarks",
            {"name": "A的书签", "url": "https://a.example.com", "desc": "",
             "tags": [], "cat": "", "hue": 0}, token=TA)
check("用户A写书签", st == 200, str(st))
st, r = api("GET", "/api/bookmarks", token=TA)
check("用户A见自己的书签", st == 200 and any(b["name"] == "A的书签" for b in r), str(st))
st, r = api("GET", "/api/bookmarks", token=TB)
check("用户B看不到A的书签", st == 200 and all(b["name"] != "A的书签" for b in r), str(st))
st, r = api("POST", "/api/notes", {"title": "B的笔记", "tags": [], "folder": ""}, token=TB)
check("用户B写笔记", st == 200, str(st))
st, r = api("GET", "/api/notes", token=TA)
check("用户A看不到B的笔记", st == 200 and all(n["title"] != "B的笔记" for n in r.get("notes", [])), str(st))

print("\n===== 阶段A+B 结果：%d 通过 / %d 失败 =====" % (len(OK), len(FAIL)))
if FAIL:
    print("失败项:", FAIL)
    sys_exit = 1
else:
    sys_exit = 0
# 清理测试用户（保留 test 数据状态：恢复偏好为默认暗色）
api("PUT", "/api/settings", {"theme": {"mode": "dark", "hue": 243, "sat": 72},
                             "layout": {}, "locale": {}, "weather": {}}, token=T)
api("PUT", "/api/auth/register-config", {"allowRegister": False}, token=T)
for u in ("u_s6_a", "u_s6_b"):
    api("DELETE", "/api/auth/users/" + u, token=T)
print("已清理 u_s6_a/u_s6_b 并关闭注册")
raise SystemExit(sys_exit)
