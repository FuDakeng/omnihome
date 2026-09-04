# 万事屋 OmniHome · Docker 部署说明

> 版本号以 `backend/app_version.py` 为准。应用内「设置中心 → 关于」可查看完整更新日志。
> NAS 用户建议看 `DEPLOY-NAS.md`（含群晖 Container Manager 图形界面方式）。

## 一、准备

将 `omnihome-deploy.tar.gz` 解压到任意目录，例如 `/opt/omnihome`：

```bash
mkdir -p /opt/omnihome
tar -xzf omnihome-deploy.tar.gz -C /opt/omnihome
```

解压后结构：

```
omnihome/
├── Dockerfile
├── docker-compose.yml        # 通用：从源码构建
├── docker-compose.nas.yml    # NAS：可用镜像，也可构建
├── build-image.sh            # 构建并导出 amd64 / arm64 镜像（需 Docker Desktop）
├── requirements.txt
├── backend/                  # FastAPI 后端（含每日单词词库 backend/data/words.json）
├── demo/                     # 前端静态资源
├── omnihome-extension.zip    # 浏览器扩展安装包（可在应用内下载，勿删）
├── DEPLOY.md / DEPLOY-NAS.md
└── data/                     # 空目录占位：用户数据会生成在这里，勿删
```

> 部署包**不含任何用户数据**。首次启动时 `data/` 下会自动生成 `config.json`
> 与各用户目录，第一个注册的账号即为管理员。

## 二、构建与启动

```bash
cd /opt/omnihome
docker compose up -d --build
```

- 访问 `http://<主机IP>:8000`
- 首次打开进入**注册页**，创建的第一个账号为管理员
- 修改端口：编辑 `docker-compose.yml` 中 `"8000:8000"` 的左侧端口

若没有 compose 插件，等价命令：

```bash
docker build -t omnihome:latest .
docker run -d --name omnihome --restart unless-stopped \
  -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e TZ=Asia/Shanghai \
  omnihome:latest
```

## 三、数据与备份

- 全部用户数据在 `./data/`（账号、笔记、书签、偏好、仪表盘布局、保险库密文、备份 zip），备份该目录即可完整迁移
- 应用内「设置中心 → 数据与存储」支持定时自动备份、手动备份（zip）与整体导出
- 升级版本：替换 `backend/` 与 `demo/` 后 `docker compose up -d --build`，`data/` 保持不动
- **关于加密主密钥**：`./data/secret.key` 用于加密保存 AI 接口密钥，首次启动自动生成（权限 600）。
  它与用户数据分开放置，因此只拿到数据库或 `data/users/` 是无法解密的。
  整站迁移请连同整个 `data/` 目录一起备份；若只搬走用户数据而丢失该文件，
  已保存的 AI 密钥将无法解密，此时按「未配置」处理，在设置里重新填写即可，不影响其它数据

## 四、Obsidian 同步（可选）

0.2.27 起提供 Obsidian 双向同步插件，把门户知识库同步到 Obsidian 仓库（桌面 / 移动端）。

- **无需额外挂载目录**：笔记继续存于 storage 抽象层（NAS 上是 PostgreSQL 的 `bm_notes` 表），`path`（`文件夹/标题.md`）只是逻辑寻址，**不落物理 `.md` 镜像**。因此 `docker-compose.yml` 的挂载与备份策略完全不变，`data/` 备份已涵盖同步数据。
- **API Key 存于 `config.json`**：服务端只存 Key 的 sha256 哈希（`config.json` 的 `syncKeys`），明文不可逆推。备份 `data/` 时一并涵盖；重置 / 吊销后旧 Key 立即失效。
- **移动端 / 公网访问安全**：手机在外网访问 NAS 门户时，需让门户可从公网到达（DDNS / 内网穿透，如 frp、Cloudflare Tunnel、Tailscale Funnel）。**强烈建议在反向代理上启用 HTTPS**——`X-API-Key` 是明文请求头，HTTP 明文传输有泄露风险。插件用 Obsidian `requestUrl` 发请求，绕过浏览器 CORS，跨域 / 移动端均可用。
- 门户「设置 → 功能设置 → Obsidian 插件同步」可下载插件 zip（镜像需包含 `obsidian-plugin/` 目录）。
- 详细操作见 `docs/Obsidian同步插件-用户使用指南.md`，服务端 API 见 `docs/Obsidian同步插件-服务端API.md`，插件源码见 `obsidian-plugin/omnihome-sync/`。

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 系统监控入口不显示 | 该功能仅管理员可见且默认关闭：管理员在「设置 → 功能设置」中开启 |
| 监控页提示"无法连接 Docker" | 确认 `/var/run/docker.sock` 已挂载且存在；无 socket 时容器监控自动降级，其余功能不受影响 |
| 忘记管理员密码 | 停止容器后删除 `data/config.json` 与对应用户目录，重新注册（会清空全部数据，请先备份） |
| 天气城市修改 | 仪表盘天气横条 → 位置设置 → 手动搜索城市；或一键定位（需 HTTPS / localhost） |
| 会话全部失效 | 会话存于内存，服务重启后需重新登录，属预期行为 |
| 浏览器扩展下载提示未找到 | 部署包根目录需保留 `omnihome-extension.zip`；扩展安装方式见包内 README |
