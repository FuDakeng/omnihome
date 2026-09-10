---
name: omnihome-test
description: >-
  Runs OmniHome (万事屋) regression tests for the current round of changes
  before delivery. Use when delivering, shipping, bumping VERSION, committing
  a release, the user asks to test, or sync / about / applog / Obsidian plugin
  code changed.
---

# 万事屋交付前测试

发版、提交、推送之前必须先跑本轮相关测试；失败则修到绿，不得升版本或 push。

## 默认安全套件（交付必跑）

在仓库根目录：

```bash
cd backend && python3 _sync_regress.py
```

仓库根目录也可用（安装 pytest 后）：

```bash
pip install -r requirements.lock.txt pytest
pytest
```

- FastAPI TestClient，数据写临时目录，**不碰** 真实 `data/`，无需已启动的服务。
- file + sqlite 双引擎。退出码非 0 即失败。
- `pytest` 会再跑一遍 `_sync_regress.py` 与密钥箱脚本，并检查 VERSION / 前端组装。

本轮若改了同步、审批、关于页日志导出、Obsidian 插件协议，必须等这套全绿。

## 不要默认跑的

- `backend/_api_regress.py`：需要 `127.0.0.1:8000` 上的活服务，且会 wipe `test` 用户。仅当本轮改了书签/认证/备份等且主人明确要求时，才对**本地可丢弃实例**跑。
- 不要对 NAS / 生产数据跑 wipe 类脚本。

## 按改动选跑

| 本轮改动 | 命令 |
|---|---|
| 同步 / 审批 / `/api/about/logs` / 插件协议 | `python3 backend/_sync_regress.py` |
| 仅 LiveMD / 前端文案，无 API 契约变化 | 仍跑默认套件作回归；浏览器能开则点一下相关界面 |
| 插件 `main.js` / `manifest.json` | 默认套件 + 确认 `PLUGIN_VERSION` 与 `manifest.json` 一致 |

## 失败处理

1. 看脚本打印的 `FAIL` 行，修代码或补断言（不要为了绿灯改宽本应失败的行为）。
2. 再跑同一命令直到 `全部通过`。
3. 然后才允许改 `backend/app_version.py` / `CHANGELOG.md`、commit、`git push origin main`。
