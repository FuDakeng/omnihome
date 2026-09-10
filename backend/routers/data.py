"""万事屋 · 存储引擎 / 备份 / 扩展包"""
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
import io as _io
import zipfile as _zipfile

router = APIRouter()
from routers.common import _require_admin

DEFAULT_BACKUP_CFG = {"auto": False, "intervalHours": 24, "keep": 10,
                      "lastAuto": 0}

def _backup_cfg(username: str) -> dict:
    cfg = dict(DEFAULT_BACKUP_CFG)
    cfg.update(storage.user_json(username, "backup.json", {}))
    return cfg

@router.get("/api/data/stats")
def data_stats(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    stats = storage.storage_stats(username)
    backups = sorted(storage.backup_dir(username).glob("*.zip"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    stats["backupList"] = [
        {"name": p.name, "size": p.stat().st_size,
         "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime))}
        for p in backups[:20]]
    stats["backupCfg"] = _backup_cfg(username)
    stats["engine"] = storage.engine()
    return stats

class StorageIn(BaseModel):
    engine: str        # file | sqlite | db
    url: str = ""      # engine=db 时为 SQLAlchemy 连接串

def _mask_url(url: str) -> str:
    """回显连接串时隐藏密码。"""
    return re.sub(r"://([^:/@]+):[^@]+@", r"://\1:****@", url or "")

def _parse_db_url(url: str) -> dict:
    """把 SQLAlchemy 连接串拆解为表单字段（不含密码明文）。"""
    from sqlalchemy.engine import make_url
    u = make_url(url)
    drv = (u.drivername or "").lower()
    db_type = "postgresql" if drv.startswith("postgresql") else "mysql"
    return {"dbType": db_type, "host": u.host or "", "port": u.port or 0,
            "username": u.username or "", "database": u.database or "",
            "hasPassword": u.password is not None}

def _resolve_db_url(url: str) -> str:
    """密码留空且其余连接信息与已保存配置一致时，复用已保存的密码；
    否则要求显式提供密码（避免误把掩码串 / 无密串提交入库）。"""
    from sqlalchemy.engine import make_url
    try:
        u = make_url(url)
    except Exception:
        raise HTTPException(400, "数据库连接信息格式不正确")
    if u.password:
        return url
    old = storage.storage_cfg().get("url", "")
    if old:
        try:
            o = make_url(old)
            if ((o.drivername, o.host, o.port, o.username, o.database) ==
                    (u.drivername, u.host, u.port, u.username, u.database)):
                return o.render_as_string(hide_password=False)
        except Exception:
            pass
    raise HTTPException(400, "请填写数据库密码")

@router.get("/api/data/storage")
def get_storage(authorization: Optional[str] = Header(None)):
    require_user(authorization)
    st = storage.storage_cfg()
    resp = {"engine": storage.engine(),
            "url": _mask_url(st.get("url", "")),
            "sqliteFile": str(storage.SQLITE_FILE)}
    if st.get("url"):
        try:
            resp["dbCfg"] = _parse_db_url(st["url"])
        except Exception:
            pass
    return resp

class StorageTestIn(BaseModel):
    engine: str = "db"
    url: str = ""

@router.post("/api/data/storage-test")
def test_storage(body: StorageTestIn, authorization: Optional[str] = Header(None)):
    """仅测试目标数据库连接（不迁移，仅管理员）。"""
    username = require_user(authorization)
    _require_admin(username)
    try:
        url = _resolve_db_url(body.url.strip()) if body.engine == "db" else body.url.strip()
        storage.test_db_conn(url)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"连接失败：{e}")
    return {"ok": True}

@router.post("/api/data/storage")
def switch_storage(body: StorageIn, authorization: Optional[str] = Header(None)):
    """测试目标连接 → 迁移全部用户数据 → 切换引擎（仅管理员）。"""
    username = require_user(authorization)
    _require_admin(username)
    try:
        url = (_resolve_db_url(body.url.strip()) if body.engine == "db"
               else body.url.strip())
        moved = storage.migrate_storage(body.engine, url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"迁移失败：{e}")
    return {"ok": True, "engine": storage.engine(), "moved": moved}

class BackupCfgIn(BaseModel):
    auto: bool = False
    intervalHours: int = 24
    keep: int = 10

@router.put("/api/data/backup-config")
def put_backup_cfg(body: BackupCfgIn, authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    cfg = _backup_cfg(username)
    cfg["auto"] = bool(body.auto)
    cfg["intervalHours"] = min(max(int(body.intervalHours), 1), 24 * 30)
    cfg["keep"] = min(max(int(body.keep), 1), 100)
    storage.save_user_json(username, "backup.json", cfg)
    return cfg

@router.post("/api/data/backup")
def do_backup(authorization: Optional[str] = Header(None)):
    username = require_user(authorization)
    path = storage.create_backup(username, "backup")
    storage.prune_backups(username, _backup_cfg(username).get("keep", 10))
    return {"ok": True, "name": path.name,
            "size": path.stat().st_size}

@router.get("/api/data/backup/{name}")
def download_backup(name: str, authorization: Optional[str] = Header(None),
                    token: Optional[str] = None):
    username = require_user(authorization, token)
    if not re.match(r"^[\w\-\.]+\.zip$", name):
        raise HTTPException(400, "非法文件名")
    path = storage.backup_dir(username) / name
    if not path.exists():
        raise HTTPException(404, "备份不存在")
    return FileResponse(str(path), filename=name)

EXTENSION_ZIP = storage.ROOT / "omnihome-extension.zip"

@router.get("/api/extension/check")
def extension_check():
    """扩展安装包是否可用（随部署包分发时存在），附带包内扩展版本号。"""
    if not EXTENSION_ZIP.exists():
        return {"available": False, "size": 0, "version": ""}
    version = ""
    try:
        import zipfile as _zf
        with _zf.ZipFile(str(EXTENSION_ZIP)) as z:
            # 包内路径可能是 manifest.json 或 ./manifest.json，按后缀匹配兜底
            name = next((n for n in z.namelist()
                         if n.lstrip('./').split('/')[-1] == 'manifest.json'), None)
            if name:
                version = json.loads(z.read(name)).get("version", "")
    except Exception:
        pass   # 版本读取失败不影响可用性判断
    return {"available": True, "size": EXTENSION_ZIP.stat().st_size, "version": version}

PLUGIN_DIR = storage.ROOT / "obsidian-plugin" / "omnihome-sync"

def _plugin_zip_bytes():
    if not PLUGIN_DIR.is_dir():
        return None, ""
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as z:
        for p in sorted(PLUGIN_DIR.rglob("*")):
            if p.is_file() and p.name != ".DS_Store":
                z.write(p, "omnihome-sync/" + str(p.relative_to(PLUGIN_DIR)))
    version = ""
    try:
        version = json.loads((PLUGIN_DIR / "manifest.json").read_text("utf-8")).get("version", "")
    except Exception:
        pass
    return buf.getvalue(), version

@router.get("/api/plugin/check")
def plugin_check():
    data, version = _plugin_zip_bytes()
    if not data:
        return {"available": False, "size": 0, "version": ""}
    return {"available": True, "size": len(data), "version": version}

class RestoreIn(BaseModel):
    name: str

@router.post("/api/data/restore")
def restore_backup(body: RestoreIn, authorization: Optional[str] = Header(None)):
    """用指定备份覆盖当前用户数据（备份文件本身不受影响）。"""
    username = require_user(authorization)
    if not re.match(r"^[\w\-\.]+\.zip$", body.name or ""):
        raise HTTPException(400, "非法备份名")
    try:
        count = storage.restore_backup(username, body.name)
    except FileNotFoundError:
        raise HTTPException(404, "备份不存在")
    except Exception as e:
        raise HTTPException(500, f"恢复失败：{e}")
    return {"ok": True, "restored": count}

IMPORT_BACKUP_MAX = 80 * 1024 * 1024

@router.post("/api/data/import")
async def import_backup_file(file: UploadFile = File(...),
                             authorization: Optional[str] = Header(None)):
    """上传导出的 zip，校验后写入 backups 并覆盖当前用户数据。"""
    import io as _io
    import zipfile as _zf
    username = require_user(authorization)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    if len(raw) > IMPORT_BACKUP_MAX:
        raise HTTPException(400, "备份文件过大（上限 80MB）")
    try:
        zf = _zf.ZipFile(_io.BytesIO(raw))
        names = zf.namelist()
    except Exception:
        raise HTTPException(400, "不是有效的 zip 备份")
    for n in names:
        norm = n.replace("\\", "/").lstrip("/")
        if n.startswith("/") or ".." in norm.split("/") or norm.startswith("backups/"):
            raise HTTPException(400, f"非法路径：{n}")
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = storage.backup_dir(username) / f"import-{ts}.zip"
    dest.write_bytes(raw)
    try:
        count = storage.restore_backup(username, dest.name)
    except Exception as e:
        raise HTTPException(500, f"恢复失败：{e}")
    storage.prune_backups(username, _backup_cfg(username).get("keep", 10))
    return {"ok": True, "restored": count, "name": dest.name}

@router.get("/api/data/export")
def export_all(authorization: Optional[str] = Header(None),
               token: Optional[str] = None):
    username = require_user(authorization, token)
    path = storage.create_backup(username, "export")
    return FileResponse(str(path), filename=f"omnihome-{username}-export.zip")

class WipeIn(BaseModel):
    password: str = ""

@router.delete("/api/data/wipe")
def wipe_data(body: WipeIn = Body(...),
              authorization: Optional[str] = Header(None)):
    """清空当前用户全部数据（保留账号与偏好）：需输入登录密码确认。"""
    username = require_user(authorization)
    u = storage.get_config()["users"].get(username)
    if not u or not verify_password(body.password, u["password"]):
        raise HTTPException(400, "登录密码不正确，无法清空数据")
    storage.wipe_user_data(username)
    return {"ok": True}

