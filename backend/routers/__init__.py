"""域路由聚合。"""
from fastapi import APIRouter

from routers.auth import router as auth_router
from routers.settings import router as settings_router
from routers.monitor import router as monitor_router
from routers.weather import router as weather_router
from routers.bookmarks import router as bookmarks_router
from routers.notes import router as notes_router
from routers.notes_vault import router as notes_vault_router
from routers.notes_share import router as notes_share_router
from routers.sync import router as sync_router
from routers.workspace import router as workspace_router
from routers.ai import router as ai_router
from routers.data import router as data_router

router = APIRouter()
for r in (auth_router, settings_router, monitor_router, weather_router,
          bookmarks_router, notes_vault_router, notes_router, notes_share_router, sync_router,
          workspace_router, ai_router, data_router):
    router.include_router(r)
