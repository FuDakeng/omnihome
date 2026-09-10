"""万事屋 · AI 配置与代理"""
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

AI_FILE = "ai.json"

def _ai_cfg(username: str) -> dict:
    """读取 AI 配置；若密钥仍是历史明文，就地升级为密文后回写。"""
    cfg = storage.user_json(username, AI_FILE,
                            {"endpoint": "", "apiKey": "", "model": "",
                             "enabled": False})
    key = cfg.get("apiKey") or ""
    if key and not secretbox.is_encrypted(key):
        cfg["apiKey"] = secretbox.encrypt(key)
        storage.save_user_json(username, AI_FILE, cfg)
    return cfg

def _ai_key(cfg: dict) -> str:
    """取出可用的明文密钥（解密失败时返回空串，调用方按未配置处理）。"""
    return secretbox.decrypt(cfg.get("apiKey") or "")

def _ai_public(cfg: dict) -> dict:
    """返回给前端的配置（不回传密钥本身，仅告知是否已配置）"""
    return {"endpoint": cfg.get("endpoint", ""), "model": cfg.get("model", ""),
            "enabled": bool(cfg.get("enabled")),
            "hasKey": bool(_ai_key(cfg))}

class AiConfigIn(BaseModel):
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None   # 空字符串 = 保留已有密钥；也支持整串清除标记 "__clear__"
    model: Optional[str] = None
    enabled: Optional[bool] = None

@router.get("/api/ai-config")
def get_ai_config(authorization: Optional[str] = Header(None)):
    return _ai_public(_ai_cfg(require_user(authorization)))

@router.put("/api/ai-config")
def put_ai_config(body: AiConfigIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if body.endpoint is not None:
        cfg["endpoint"] = body.endpoint.strip()
    if body.model is not None:
        cfg["model"] = body.model.strip()
    if body.enabled is not None:
        cfg["enabled"] = bool(body.enabled)
    if body.apiKey == "__clear__":
        cfg["apiKey"] = ""
    elif body.apiKey:
        cfg["apiKey"] = secretbox.encrypt(body.apiKey.strip())   # 只存密文
    storage.save_user_json(username, AI_FILE, cfg)
    return _ai_public(cfg)

def _ai_chat(cfg: dict, messages: list, max_tokens: int = 400) -> str:
    """调用用户配置的 OpenAI 兼容接口，返回模型文本。"""
    api_key = _ai_key(cfg)          # 库里存的是密文，取出时解密
    if not cfg.get("endpoint") or not api_key or not cfg.get("model"):
        raise HTTPException(400, "AI 尚未配置完整（接口地址 / API Key / 模型）")
    url = cfg["endpoint"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    try:
        r = httpx.post(url,
                       headers={"Authorization": f"Bearer {api_key}"},
                       json={"model": cfg["model"], "messages": messages,
                             "temperature": 0.2, "max_tokens": max_tokens},
                       timeout=30)
    except Exception as e:
        raise HTTPException(502, f"无法连接 AI 接口：{e}")
    if r.status_code != 200:
        raise HTTPException(502, f"AI 接口返回 {r.status_code}：{r.text[:120]}")
    data = r.json()
    return data["choices"][0]["message"]["content"]

@router.post("/api/ai/test")
def ai_test(body: Optional[AiConfigIn] = None,
            authorization: Optional[str] = Header(None)):
    """连通性测试：可直接携带表单中尚未保存的配置（空字段回落已保存值）。"""
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if body:
        if body.endpoint:
            cfg["endpoint"] = body.endpoint.strip()
        if body.model:
            cfg["model"] = body.model.strip()
        if body.apiKey and body.apiKey != "__clear__":
            # 仅覆盖内存副本用于试连（decrypt 遇明文会原样返回），不会写回存储
            cfg["apiKey"] = body.apiKey.strip()
    _ai_chat(cfg, [{"role": "user", "content": "连接测试，只需回复 OK"}], max_tokens=8)
    return {"ok": True}

class AiBookmarkIn(BaseModel):
    name: str = ""
    url: str = ""
    desc: str = ""
    cats: list = []   # [{id, name}] 供模型选择的分类列表

def _extract_json(text: str):
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return None
    import json
    try:
        return json.loads(m.group(0))
    except Exception:
        return None

@router.post("/api/ai/analyze-bookmark")
def ai_analyze_bookmark(body: AiBookmarkIn, authorization: Optional[str] = Header(None)):
    """AI 分析书签：推荐分类、生成一句话描述与标签。"""
    username = require_user(authorization)
    cfg = _ai_cfg(username)
    if not cfg.get("enabled"):
        raise HTTPException(400, "AI 智能未启用，请先在设置 → AI 智能中配置")
    cat_names = "、".join(c.get("name", "") for c in body.cats if c.get("name")) or "无"
    prompt = (
        "分析以下书签并返回严格 JSON（不要输出任何其他内容）：\n"
        f"名称：{body.name}\n网址：{body.url}\n已有描述：{body.desc}\n"
        f"可选分类：{cat_names}\n"
        '返回格式：{"cat": "最合适的分类名，无合适分类则为空字符串", '
        '"desc": "一句话描述（不超过20字）", '
        '"tags": ["标签1", "标签2", "标签3"]（2-4个，简短）}')
    text = _ai_chat(cfg, [{"role": "user", "content": prompt}])
    data = _extract_json(text)
    if not data:
        raise HTTPException(502, "AI 返回内容无法解析，请重试")
    # 分类名 → 分类 id（模型返回不在列表内则不采纳）
    cat_id = ""
    want = str(data.get("cat") or "").strip()
    for c in body.cats:
        if c.get("name") == want:
            cat_id = c.get("id", "")
            break
    tags = [str(t).strip() for t in (data.get("tags") or [])
            if str(t).strip()][:6]
    return {"catId": cat_id, "desc": str(data.get("desc") or "").strip()[:60],
            "tags": tags}

