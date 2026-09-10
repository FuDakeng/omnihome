"""万事屋 · 后端主程序
FastAPI 应用：静态资源 + 路由挂载 + 备份守护。
运行: python3 backend/main.py  （或 uvicorn backend.main:app）
"""
import os
import threading
import time
from typing import Optional

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

import storage
import app_version

app = FastAPI(title="万事屋 API", version=app_version.VERSION)

BUILD_TIME = time.strftime("%Y-%m-%d %H:%M")
START_TIME = time.time()

from sessions import require_user  # noqa: E402
import applog  # noqa: E402
applog.set_start(START_TIME)

from routes import router  # noqa: E402
app.include_router(router)

# ---------- 静态资源（前端） ----------
FRONTEND_DIR = storage.ROOT / "demo"
app.mount("/demo", StaticFiles(directory=str(FRONTEND_DIR)), name="demo-static")


def _safe_under(root, rel: str):
    """拒绝 .. 穿越，返回解析后的绝对路径或 None。"""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    path = (root / rel).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


@app.get("/")
def index():
    from webassets import render_index
    html = render_index(FRONTEND_DIR, app_version.VERSION)
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/js/{path:path}")
def js(path: str):
    p = _safe_under(FRONTEND_DIR / "js", path)
    if p is None:
        from fastapi import HTTPException
        raise HTTPException(404, "not found")
    r = FileResponse(str(p))
    r.headers["Cache-Control"] = "public, max-age=31536000"
    return r


@app.get("/css/{path:path}")
def css(path: str):
    p = _safe_under(FRONTEND_DIR / "css", path)
    if p is None:
        from fastapi import HTTPException
        raise HTTPException(404, "not found")
    r = FileResponse(str(p))
    r.headers["Cache-Control"] = "public, max-age=31536000"
    return r


@app.get("/views/{path:path}")
def views(path: str):
    p = _safe_under(FRONTEND_DIR / "views", path)
    if p is None:
        from fastapi import HTTPException
        raise HTTPException(404, "not found")
    r = FileResponse(str(p))
    r.headers["Cache-Control"] = "public, max-age=31536000"
    return r


@app.middleware("http")
async def _applog_http(request: Request, call_next):
    path = request.url.path or ""
    if not path.startswith("/api/"):
        return await call_next(request)
    t0 = time.time()
    user = applog.user_from_headers(
        request.headers.get("authorization") or "",
        request.headers.get("x-api-key") or "",
        request.query_params.get("token") or "",
    )
    safe = applog._safe_path(path, request.url.query or "")
    try:
        response = await call_next(request)
        ms = int((time.time() - t0) * 1000)
        applog.record_http(request.method, safe, response.status_code, ms, user)
        return response
    except Exception:
        ms = int((time.time() - t0) * 1000)
        import traceback as _tb
        applog.record_exception(request.method, safe, user, _tb.format_exc())
        applog.record_http(request.method, safe, 500, ms, user)
        raise


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https: http:; "
        "font-src 'self' data:; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def _backup_daemon():
    lock_path = storage.DATA_DIR / "backup-daemon.lock"
    try:
        import fcntl
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(lock_path, "a+")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    while True:
        time.sleep(600)
        try:
            users = list(storage.get_config().get("users", {}))
            for name in users:
                cfg = storage.user_json(name, "backup.json", {})
                if not cfg.get("auto"):
                    continue
                interval = max(1, int(cfg.get("intervalHours", 24))) * 3600
                if time.time() - (cfg.get("lastAuto") or 0) < interval:
                    continue
                storage.create_backup(name, "autobackup")
                storage.prune_backups(name, int(cfg.get("keep", 10)))
                cfg["lastAuto"] = int(time.time())
                storage.save_user_json(name, "backup.json", cfg)
        except Exception:
            pass


def _start_backup_daemon():
    for t in threading.enumerate():
        if getattr(t, "name", "") == "omni-backup":
            return
    threading.Thread(target=_backup_daemon, name="omni-backup",
                     daemon=True).start()


_start_backup_daemon()
storage.ensure_db()


@app.get("/api/about")
def about():
    import platform
    days = int((time.time() - START_TIME) // 86400)
    hours = int((time.time() - START_TIME) % 86400 // 3600)
    return {
        "name": "万事屋", "version": app_version.VERSION,
        "stage": app_version.STAGE,
        "build": BUILD_TIME, "python": platform.python_version(),
        "uptime": f"{days} 天 {hours} 小时",
        "changelog": app_version.CHANGELOG,
        "developer": "JeanLaw",
    }


@app.get("/api/about/logs")
def about_logs(authorization: Optional[str] = Header(None),
               token: Optional[str] = Query(None)):
    """导出运行诊断 zip：系统信息 + 本人同步日志 + API 访问/异常（密钥已打码）。"""
    username = require_user(authorization, token)
    is_admin = storage.get_config().get("users", {}).get(username, {}).get("role") == "admin"
    data = applog.build_zip(username, is_admin, extra_system={"build": BUILD_TIME})
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="omnihome-logs.zip"'},
    )


if __name__ == "__main__":
    import uvicorn
    workers = int(os.environ.get("UVICORN_WORKERS") or "1")
    if workers > 1:
        uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=workers)
    else:
        uvicorn.run(app, host="0.0.0.0", port=8000)
