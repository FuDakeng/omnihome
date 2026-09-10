# 万事屋 OmniHome

**个人门户 · 一站式自托管工作台**

万事屋（OmniHome）是一个自托管的个人门户应用：把笔记、书签、计划、日历、文件保险库、容器监控、天气、词库等日常数字生活工具集中到一个地方，支持多用户、浏览器扩展、外部数据库存储，适合部署在 NAS 或个人服务器上。

> 原名 OmniDesk，现已更名为 **OmniHome / 万事屋**。

---

## ✨ 功能特性

### 📝 知识库（笔记）
- Markdown 编辑器：编辑 / 分屏 / 预览三种模式
- 实时渲染链接与表格、大纲侧栏、查找替换、撤销/重做
- 笔记仓库：默认仓库 + 系统内置仓库，可自建并切换；回收站按仓库与文件夹层级展示
- 目录树 + 拖拽导入 + 附件预览与上传
- Obsidian 插件按仓库双向同步（设置 → 功能设置）

### 🔖 书签管理
- 书签分类、图标自动识别（后端代理获取）
- **导入 / 导出**（Netscape HTML 格式，兼容主流浏览器）
- 浏览器扩展双向同步（见下文）

### 📅 计划与日历
- 今日计划组件（按月归档）
- 日历联动：点击日期直接编辑计划

### 🗄️ 保险库与演示
- 私密文件保险库
- 演示 / 展示工具集（含实时 Markdown 渲染等）

### 📊 系统监控（管理员专属）
- 容器资源监控：CPU / 内存 / 网络真实速率 / 物理硬盘
- 容器筛选、曲线图、合计指标、内存饼图
- 支持远程 Docker（通过 docker.sock 只读挂载）

### 🌤️ 其他
- 顶栏天气横条（点击查看详情）
- 词库、工具箱等实用小模块
- 多用户账号体系（支持开放注册开关、头像自定义）
- AI 接口密钥 **加密落库存储**（Fernet/AES-128-CBC + HMAC-SHA256）

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.11 · FastAPI · SQLAlchemy |
| 前端 | 原生 HTML/CSS/JS（无打包器；ESM + hash 路由）|
| 存储 | 文件引擎 / SQLite / MySQL / PostgreSQL（可切换，自动迁移）|
| 会话 | `data/sessions.sqlite`（WAL，可多 worker 共享）|
| 加密 | cryptography (Fernet) |
| 部署 | Docker（官方镜像 python:3.11-slim）；公网用 `docker-compose.tls.yml` |

---

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 构建
docker build -t omnihome:latest .

# 运行（端口 8000，数据目录可自行修改）
docker run -d --name omnihome --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/data:/app/data \
  -e TZ=Asia/Shanghai \
  omnihome:latest
```

> 默认**不**挂载 `docker.sock`。需要容器监控时再加上 `-v /var/run/docker.sock:/var/run/docker.sock:ro`。

### 方式二：Docker Compose

```bash
docker compose up -d
```

### 方式三：本地运行（开发）

```bash
pip install -r requirements.lock.txt
python3 backend/main.py
# 或 uvicorn backend.main:app --port 8000
```

---

## ⚙️ 配置

### 存储引擎（config.json → `storage` 段）

| 引擎 | 说明 |
|---|---|
| `file`（默认）| 数据存 `/app/data/users/<用户名>/` 的 JSON/Markdown 文件 |
| `sqlite` | 单文件数据库 |
| `mysql` / `postgresql` | 外部数据库，切换时自动迁移全部用户数据 |

示例（PostgreSQL）：
```json
{
  "storage": {
    "engine": "db",
    "url": "postgresql+psycopg2://user:pass@host:5432/omnihome"
  }
}
```

### 系统监控开关
- 默认关闭；登录后到 **设置 → 功能设置** 开启（仅管理员可用）

### 开放注册
- 设置 → 用户与账号 →「开放新用户注册」开关（默认关闭）

---

## 🧩 浏览器扩展

设置 → 功能设置 → **下载浏览器扩展**（部署包根目录需含 `omnihome-extension.zip`）。

功能：书签栏与万事屋**双向同步**（全量镜像、分类与顺序一致）。

**手动安装**（以 Chrome 为例）：
1. 解压 `omnihome-extension.zip`
2. 打开 `chrome://extensions` → 开启「开发者模式」
3. 加载已解压的扩展程序 → 选择解压目录

---

## 📁 目录结构

```
├── backend/                 # FastAPI 后端
│   ├── main.py              # 应用工厂、静态资源、CSP
│   ├── routers/             # 按域拆分的 API
│   ├── store/               # 存储引擎内部（file/db 迁移）
│   ├── sessions.py          # 口令 + SQLite 会话
│   ├── secretbox.py         # AI 密钥加密（Fernet）
│   ├── app_version.py       # VERSION；CHANGELOG.md 由它读取
│   └── data/                # 内置数据（词库等）
├── demo/                    # 生产前端（原生 ESM，无打包器）
│   ├── index.html           # 壳层；views 由服务端注入
│   ├── views/               # 主视图与弹层片段
│   ├── css/                 # theme + 按功能拆分的 components
│   └── js/                  # boot.js 入口 + notes/ 子模块 + vendor
├── CHANGELOG.md
├── Dockerfile
├── docker-compose.yml       # 通用部署（默认不挂 docker.sock）
├── docker-compose.tls.yml   # Caddy HTTPS 示例
├── Caddyfile
├── requirements.lock.txt
└── omnihome-extension.zip   # 浏览器扩展安装包（可选，随包分发）
```

---

## 🔄 版本管理

- 版本号唯一来源：`backend/app_version.py`（`VERSION` / `STAGE`），更新日志在仓库根 `CHANGELOG.md`
- 镜像同时打 `omnihome:<版本>` 与 `omnihome:latest` 双标签
- 应用内「设置 → 关于」查看完整更新日志
- 静态资源 `?v=` 由服务端按 VERSION 注入，不要手改 HTML 里的版本戳

## 📄 子项目

- `omnihome-extension/`（或 `extension/`）— 浏览器扩展源码
- `DEPLOY.md` — 通用部署文档
- `DEPLOY-NAS.md` — NAS 部署专属文档

---

## ⚠️ 注意事项

- **扩展打包**：每次发版需将最新 `omnihome-extension.zip` 放构建目录根再构建镜像，否则容器内仍是旧版
- **密钥安全**：AI 接口密钥加密落库；`*.pem`（扩展签名私钥）**切勿提交到代码仓库**
- 容器监控需要时再挂 `docker.sock`（compose 里取消注释）；公网务必 HTTPS（见 `docker-compose.tls.yml`）

## 📜 许可证

私有项目 · 作者 [Jean](mailto:jeanlaw@example.com)