"""万事屋 · 偏好与仪表盘"""
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
from routers.common import _require_admin  # noqa: F401

@router.get("/api/settings")
def get_settings(authorization: Optional[str] = Header(None)):
    return storage.get_prefs(require_user(authorization))

# 监控横条可选项（顺序即横条从左到右的展示顺序）
SYS_BAR_ORDER = ("cpu", "cpuTemp", "gpu", "mem", "disk",
                 "diskWrite", "diskRead", "netUp", "netDown")


def clean_sysbar_fields(fields):
    """只保留已知指标，并按固定顺序去重。非列表返回 None（调用方不改原值）。"""
    if not isinstance(fields, list):
        return None
    got = {k for k in fields if isinstance(k, str)}
    return [k for k in SYS_BAR_ORDER if k in got]


class PrefsIn(BaseModel):
    theme: Optional[dict] = None
    layout: Optional[dict] = None
    locale: Optional[dict] = None
    weather: Optional[dict] = None
    sysbar: Optional[dict] = None
    trashDays: Optional[int] = None   # v0.2.15 增：回收站文件保留天数（0=永久保留，需手动清）
    obsidianSync: Optional[bool] = None  # 功能设置：Obsidian 插件同步开关

@router.put("/api/settings")
def put_settings(body: PrefsIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    prefs = storage.get_prefs(username)
    for key in ("theme", "layout", "locale", "weather"):
        val = getattr(body, key)
        if val:
            if key == "layout" and "sidebarCollapsed" in val:
                val["sidebarCollapsed"] = bool(val["sidebarCollapsed"])
            prefs[key].update(val)
    if body.sysbar is not None and isinstance(body.sysbar, dict):
        cur = prefs.get("sysbar")
        if not isinstance(cur, dict):
            cur = {}
            prefs["sysbar"] = cur
        if "fields" in body.sysbar:
            cleaned = clean_sysbar_fields(body.sysbar.get("fields"))
            if cleaned is not None:
                cur["fields"] = cleaned
    if body.trashDays is not None:
        days = max(0, min(3650, int(body.trashDays)))   # 上限 10 年，超过视作永久保留（0）
        prefs["trashDays"] = days
    if body.obsidianSync is not None:
        prefs["obsidianSync"] = bool(body.obsidianSync)
    storage.save_prefs(username, prefs)
    return prefs

DEFAULT_WIDGETS = ["weather", "monitor", "quicknav", "calendar", "word",
                   "vault", "quicknote", "plan", "translate", "passgen"]

class DashboardIn(BaseModel):
    order: list = []
    removed: list = []
    sizes: dict = {}      # 组件 id -> { col: 跨列数, h: 最小高度 px }

def _clean_sizes(sizes: dict, known: set) -> dict:
    """只保留已知组件且数值合法的尺寸，避免脏数据把卡片撑坏。"""
    out = {}
    for wid, v in (sizes or {}).items():
        if wid not in known or not isinstance(v, dict):
            continue
        item = {}
        col = v.get("col")
        if isinstance(col, (int, float)) and 3 <= col <= 12:
            item["col"] = int(col)
        h = v.get("h")
        if isinstance(h, (int, float)) and 160 <= h <= 2000:
            item["h"] = int(h)
        if item:
            out[wid] = item
    return out

@router.get("/api/dashboard")
def get_dashboard(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    d = storage.user_json(username, "dashboard.json",
                          {"order": [], "removed": [], "sizes": {}})
    d.setdefault("order", [])
    d.setdefault("removed", [])
    d.setdefault("sizes", {})
    return d

@router.put("/api/dashboard")
def put_dashboard(body: DashboardIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    known = set(DEFAULT_WIDGETS)
    order = [w for w in body.order if w in known]
    removed = [w for w in body.removed if w in known]
    storage.save_user_json(username, "dashboard.json",
                           {"order": order, "removed": removed,
                            "sizes": _clean_sizes(body.sizes, known)})
    return {"ok": True}

