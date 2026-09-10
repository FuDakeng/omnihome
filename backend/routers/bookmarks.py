"""万事屋 · 书签与站点元信息"""
from __future__ import annotations

import re
import hashlib
import secrets
import threading
import time
import uuid
import json
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Body, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import storage
import secretbox
import teams
from sessions import require_user, verify_password

router = APIRouter()

class BookmarkIn(BaseModel):
    id: Optional[str] = None
    name: str
    url: str = ""
    cat: str = "common"
    order: int = 0
    icon: Optional[str] = None   # 空 = 自动获取站点图标；sym:i-xxx = 内置图标
    desc: Optional[str] = None
    tags: Optional[list] = None

DEFAULT_BOOKMARKS = [
    {"name": "GitHub", "url": "https://github.com", "cat": "dev"},
    {"name": "Bilibili", "url": "https://bilibili.com", "cat": "common"},
]

def _norm_bm(bm) -> dict:
    """规范化单条书签：补齐/兜底缺失字段。
    插件镜像同步、历史导入可能产出缺 name 的脏数据，
    前端 visible() 里 b.name.toLowerCase() 会直接抛 TypeError。"""
    if not isinstance(bm, dict):
        return None
    url = str(bm.get("url") or "").strip()
    name = str(bm.get("name") or "").strip() or url or "未命名"
    out = dict(bm)
    out["name"] = name
    out["url"] = url
    out.setdefault("id", uuid.uuid4().hex[:8])
    out.setdefault("cat", "common")
    out.setdefault("icon", "")
    out.setdefault("desc", "")
    tags = out.get("tags")
    out["tags"] = [str(t) for t in tags] if isinstance(tags, list) else []
    return out

def _bookmarks(username: str) -> list:
    """仅在首次使用（数据不存在）时播种默认书签；
    用户删光书签后数据仍存在（空列表），不会自动重生。
    读取时顺带规范化存量脏数据（缺 name 等），变更则回写。"""
    if not storage.user_file_exists(username, "bookmarks.json"):
        seed = []
        for i, s in enumerate(DEFAULT_BOOKMARKS):
            seed.append({"id": uuid.uuid4().hex[:8], "name": s["name"],
                         "url": s["url"], "cat": s["cat"],
                         "hue": hash(s["name"]) % 360, "order": i,
                         "icon": "", "desc": "", "tags": []})
        storage.save_user_json(username, "bookmarks.json", seed)
    data = storage.user_json(username, "bookmarks.json", [])
    norm = [n for n in (_norm_bm(b) for b in data) if n]
    if norm != data:
        storage.save_user_json(username, "bookmarks.json", norm)
    return norm

@router.get("/api/bookmarks")
def list_bookmarks(authorization: Optional[str] = Header(None)):
    return _bookmarks(require_user(authorization))

@router.post("/api/bookmarks")
def add_bookmark(body: BookmarkIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    bm = {"id": uuid.uuid4().hex[:8], "name": body.name, "url": body.url,
          "cat": body.cat or "common", "hue": hash(body.name) % 360,
          "order": len(bms), "icon": body.icon or "",
          "desc": body.desc or "", "tags": body.tags or []}
    bms.append(bm)
    storage.save_user_json(username, "bookmarks.json", bms)
    return bm

@router.put("/api/bookmarks")
def replace_bookmarks(bms: list = Body(...), authorization: Optional[str] = Header(None)):
    """整体保存（含拖拽排序后的顺序）；入库前规范化，杜绝缺字段脏数据。"""
    username = require_user(authorization)
    norm = [n for n in (_norm_bm(b) for b in bms) if n]
    storage.save_user_json(username, "bookmarks.json", norm)
    return {"ok": True}

@router.put("/api/bookmarks/{bid}")
def update_bookmark(bid: str, body: BookmarkIn,
                    authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    for bm in bms:
        if bm["id"] == bid:
            bm.update({"name": body.name, "url": body.url, "cat": body.cat,
                       "icon": body.icon or "", "desc": body.desc or "",
                       "tags": body.tags or []})
            storage.save_user_json(username, "bookmarks.json", bms)
            return bm
    raise HTTPException(404, "书签不存在")

@router.delete("/api/bookmarks/{bid}")
def delete_bookmark(bid: str, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    bms = _bookmarks(username)
    bms = [b for b in bms if b["id"] != bid]
    storage.save_user_json(username, "bookmarks.json", bms)
    return {"ok": True}

DEFAULT_CATS = [{"id": "all", "name": "全部"}, {"id": "common", "name": "常用"},
                {"id": "dev", "name": "开发"}, {"id": "media", "name": "影音"},
                {"id": "none", "name": "未分类"}]
CATS_FILE = "bookmark-cats.json"

class CatIn(BaseModel):
    name: str

def _cats(username: str):
    cats = storage.user_json(username, CATS_FILE, None)
    if cats is None:   # 首次使用：播种默认分类并保留内置分类
        cats = [dict(c) for c in DEFAULT_CATS]
        storage.save_user_json(username, CATS_FILE, cats)
    if not any(c["id"] == "all" for c in cats):
        cats.insert(0, {"id": "all", "name": "全部"})
    if not any(c["id"] == "none" for c in cats):
        cats.append({"id": "none", "name": "未分类"})
    return cats

@router.get("/api/bookmark-cats")
def list_cats(authorization: Optional[str] = Header(None)):
    return _cats(require_user(authorization))

@router.post("/api/bookmark-cats")
def add_cat(body: CatIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "分类名称不能为空")
    cats = _cats(username)
    if any(c["name"] == name for c in cats):
        raise HTTPException(400, "同名分类已存在")
    cat = {"id": uuid.uuid4().hex[:8], "name": name}
    # 插在「未分类」之前，保持兜底分类始终在末尾（「全部」位置由用户自由调整）
    idx = next((i for i, c in enumerate(cats) if c["id"] == "none"), len(cats))
    cats.insert(idx, cat)
    storage.save_user_json(username, CATS_FILE, cats)
    return cat

@router.put("/api/bookmark-cats")
def replace_cats(cats: list = Body(...), authorization: Optional[str] = Header(None)):
    """整体保存（含拖拽排序后的顺序与重命名）。"""
    username = require_user(authorization)
    old = {c["id"]: c for c in _cats(username)}
    cleaned = []
    for c in cats:
        cid = c.get("id")
        name = str(c.get("name") or "").strip()
        if not cid or not name:
            continue
        item = {"id": cid, "name": name}
        if old.get(cid, {}).get("builtin"):
            item["builtin"] = True
        if c.get("hidden"):
            item["hidden"] = True
        cleaned.append(item)
    if not any(c["id"] == "all" for c in cleaned):
        cleaned.insert(0, {"id": "all", "name": "全部"})
    if not any(c["id"] == "none" for c in cleaned):
        cleaned.append({"id": "none", "name": "未分类"})
    storage.save_user_json(username, CATS_FILE, cleaned)
    return {"ok": True}

@router.put("/api/bookmark-cats/{cid}")
def rename_cat(cid: str, body: CatIn, authorization: Optional[str] = Header(None)):
    if cid in ("all", "none"):
        raise HTTPException(400, "内置分类不能重命名")
    username = require_user(authorization)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "分类名称不能为空")
    cats = _cats(username)
    target = next((c for c in cats if c["id"] == cid), None)
    if not target:
        raise HTTPException(404, "分类不存在")
    if any(c["name"] == name and c["id"] != cid for c in cats):
        raise HTTPException(400, "同名分类已存在")
    target["name"] = name
    storage.save_user_json(username, CATS_FILE, cats)
    # 书签按分类 id 引用，重命名无需改书签即可同步生效；
    # 同时规范历史数据：cat 字段不在分类列表内的书签归入未分类
    bms = _bookmarks(username)
    ids = {c["id"] for c in cats}
    fixed = False
    for bm in bms:
        if bm.get("cat") not in ids:
            bm["cat"] = "none"
            fixed = True
    if fixed:
        storage.save_user_json(username, "bookmarks.json", bms)
    return target

@router.delete("/api/bookmark-cats/{cid}")
def delete_cat(cid: str, authorization: Optional[str] = Header(None)):
    if cid == "none":
        raise HTTPException(400, "「未分类」为兜底分类，不能删除")
    if cid == "all":
        raise HTTPException(400, "「全部」为内置分类，不能删除")
    username = require_user(authorization)
    cats = _cats(username)
    if not any(c["id"] == cid for c in cats):
        raise HTTPException(404, "分类不存在")
    cats = [c for c in cats if c["id"] != cid]
    storage.save_user_json(username, CATS_FILE, cats)
    # 该分类下的书签移入未分类
    bms = _bookmarks(username)
    for bm in bms:
        if bm.get("cat") == cid:
            bm["cat"] = "none"
    storage.save_user_json(username, "bookmarks.json", bms)
    return {"ok": True}

_FAV_CACHE = {}   # netloc -> (过期时间戳, 图标字节或 None, content_type)
_FAV_TTL = 7 * 86400
_FAV_FAIL_TTL = 600   # 失败短缓存，避免反复请求死站点
_BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")

def _parse_site_url(url: str):
    p = urlparse(url if re.match(r"^https?://", url) else "https://" + url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise HTTPException(400, "仅支持 http/https 网址")
    return p

def _fetch_site_icon(site_url: str, netloc: str):
    """依次尝试：首页声明的 icon 链接 → /favicon.ico → DuckDuckGo 图标源。
    成功返回 (bytes, content_type)，否则 None。"""
    headers = {"User-Agent": _BROWSER_UA}
    icon_urls = []
    try:
        r = httpx.get(site_url, headers=headers, timeout=6, follow_redirects=True)
        for m in re.finditer(r"<link[^>]+>", r.text[:60000], re.I):
            tag = m.group(0)
            if not re.search(r"rel\s*=\s*[\"']?[^\"'>\s]*icon", tag, re.I):
                continue
            hm = re.search(r"href\s*=\s*[\"']([^\"']+)", tag, re.I)
            if hm and not hm.group(1).strip().startswith("data:"):
                icon_urls.append(urljoin(str(r.url), hm.group(1).strip()))
    except Exception:
        pass
    icon_urls.append(site_url.rstrip("/") + "/favicon.ico")
    icon_urls.append(f"https://icons.duckduckgo.com/ip3/{netloc.split(':')[0]}.ico")
    for u in icon_urls:
        try:
            ri = httpx.get(u, headers=headers, timeout=6, follow_redirects=True)
            if ri.status_code != 200 or not ri.content:
                continue
            ctype = ri.headers.get("content-type", "").split(";")[0].strip()
            if not ctype.startswith("image/"):
                head = ri.content.lstrip()[:6]
                ctype = "image/svg+xml" if head.startswith((b"<svg", b"<?xml")) else ""
            if not ctype or len(ri.content) > 200_000:
                continue
            return ri.content, ctype
        except Exception:
            continue
    return None

@router.get("/api/favicon")
def favicon(url: str, authorization: Optional[str] = Header(None),
            token: Optional[str] = None):
    """站点图标代理（供 <img> 直接引用，token 以查询参数附加）。"""
    require_user(authorization, token)
    p = _parse_site_url(url)
    hit = _FAV_CACHE.get(p.netloc)
    if not hit or hit[0] <= time.time():
        got = _fetch_site_icon(p.geturl(), p.netloc)
        if len(_FAV_CACHE) > 300:
            _FAV_CACHE.clear()
        if got:
            hit = (time.time() + _FAV_TTL, got[0], got[1])
        else:
            hit = (time.time() + _FAV_FAIL_TTL, None, "")
        _FAV_CACHE[p.netloc] = hit
    if not hit[1]:
        raise HTTPException(404, "未能获取站点图标")
    return Response(content=hit[1], media_type=hit[2],
                    headers={"Cache-Control": "public, max-age=86400"})

def _short_title(t: str) -> str:
    """从网页标题提取简短站名：按分隔符取最短段。"""
    t = re.sub(r"\s+", " ", t or "").strip()
    for sep in ("|", "-", "–", "—", "_", "·", ":"):
        if sep in t:
            parts = [p.strip() for p in t.split(sep) if p.strip()]
            if parts:
                t = min(parts, key=len)
    return t[:20]

def _guess_name(netloc: str) -> str:
    """由域名猜短名：docs.bigmodel.cn → Bigmodel。"""
    host = netloc.split(":")[0].lower()
    labels = [l for l in host.split(".") if l]
    while len(labels) > 1 and labels[-1] in (
            "com", "cn", "org", "net", "io", "dev", "ai", "me", "co", "cc"):
        labels.pop()
    if len(labels) > 1 and len(labels[-1]) == 2:   # 国别码，如 com.cn
        labels.pop()
    while len(labels) > 1 and labels[0] in (
            "www", "m", "docs", "app", "api", "blog", "dev", "my"):
        labels.pop(0)
    return labels[0].capitalize() if labels else host

@router.get("/api/site-meta")
def site_meta(url: str, authorization: Optional[str] = Header(None)):
    """抓取网页标题并生成简短名称（新增书签时自动填充）。"""
    require_user(authorization)
    p = _parse_site_url(url)
    name = ""
    try:
        r = httpx.get(p.geturl(), headers={"User-Agent": _BROWSER_UA},
                      timeout=6, follow_redirects=True)
        m = re.search(r"<title[^>]*>([\s\S]*?)</title>", r.text[:60000], re.I)
        if m:
            name = _short_title(m.group(1))
    except Exception:
        pass
    return {"name": name or _guess_name(p.netloc)}

