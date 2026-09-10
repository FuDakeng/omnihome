"""万事屋 · 路由公共辅助"""
from fastapi import HTTPException
import storage


def _require_admin(username: str):
    cfg = storage.get_config()
    if cfg["users"].get(username, {}).get("role") != "admin":
        raise HTTPException(403, "仅管理员可执行该操作")

