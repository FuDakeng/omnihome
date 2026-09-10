"""万事屋 · 功能路由（聚合入口）

域实现见 routers/。保持历史 import：`from routes import router`，
以及测试用的 AI_FILE / _ai_* 。
"""
from routers import router  # noqa: F401
from routers.ai import AI_FILE, _ai_cfg, _ai_key, _ai_public  # noqa: F401
