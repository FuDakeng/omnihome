# -*- coding: utf-8 -*-
"""诊断：sqlite 引擎下 cats/calendar 两次读取是否稳定 + 切回 file 后对比。"""
import json
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"


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


st, r = api("POST", "/api/auth/login", {"username": "test", "password": "test123"})
T = r.get("token", "")

print("== sqlite 引擎 ==")
st, cats1 = api("GET", "/api/bookmark-cats", token=T)
st, cats2 = api("GET", "/api/bookmark-cats", token=T)
print("cats 两次一致:", json.dumps(cats1, sort_keys=True) == json.dumps(cats2, sort_keys=True))
print("cats:", json.dumps(cats1, ensure_ascii=False)[:400])
st, cal1 = api("GET", "/api/calendar?month=2026-09", token=T)
st, cal2 = api("GET", "/api/calendar?month=2026-09", token=T)
print("calendar 两次一致:", json.dumps(cal1, sort_keys=True) == json.dumps(cal2, sort_keys=True))
print("cal:", json.dumps(cal1, ensure_ascii=False)[:300])

# 切回 file 再对比
st, r = api("POST", "/api/data/storage", {"engine": "file", "url": ""}, token=T)
print("切回 file:", st, str(r)[:200])
st, catsF = api("GET", "/api/bookmark-cats", token=T)
st, calF = api("GET", "/api/calendar?month=2026-09", token=T)
print("cats file==sqlite:", json.dumps(catsF, sort_keys=True) == json.dumps(cats1, sort_keys=True))
print("cal  file==sqlite:", json.dumps(calF, sort_keys=True) == json.dumps(cal1, sort_keys=True))
if json.dumps(catsF, sort_keys=True) != json.dumps(cats1, sort_keys=True):
    print("catsF:", json.dumps(catsF, ensure_ascii=False)[:400])
if json.dumps(calF, sort_keys=True) != json.dumps(cal1, sort_keys=True):
    print("calF:", json.dumps(calF, ensure_ascii=False)[:300])
