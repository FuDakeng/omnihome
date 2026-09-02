# OmniHome 万事屋 · NAS Docker 部署说明

> 版本号以 `backend/app_version.py` 为准（镜像会同时打 `omnihome:<版本号>` 与 `omnihome:latest`）。
> 应用内「设置中心 → 关于」可查看当前版本与完整更新日志。

服务端口 8000，数据全部存放在容器内 `/app/data`（通过卷持久化）。
本目录下的 `docker-compose.nas.yml` 同时支持两条路线：有源码就本地构建，有镜像就用镜像。

## 路线 A：源码包直接在 NAS 上构建（推荐，NAS 支持 SSH 时）

1. 将 `omnihome-nas-deploy.tar.gz` 解压到 NAS，例如 `/volume1/docker/omnihome`：

```bash
mkdir -p /volume1/docker/omnihome
tar -xzf omnihome-nas-deploy.tar.gz -C /volume1/docker/omnihome
```

2. SSH 登录 NAS，执行：

```bash
cd /volume1/docker/omnihome
docker compose -f docker-compose.nas.yml up -d --build
```

3. 浏览器访问 `http://<NAS_IP>:8000`，首次打开注册账号（第一个注册的用户即管理员）。

## 路线 B：在 Mac / PC 上构建镜像、导出 tar 导入 NAS（NAS 不方便构建时）

1. 在本机（需安装 Docker Desktop）执行：

```bash
./build-image.sh export
```

会生成 `omnihome-<版本号>-linux-amd64.tar` 与 `omnihome-<版本号>-linux-arm64.tar`。

2. 查看 NAS 架构（SSH 执行 `uname -m`）：`x86_64` 选 amd64，`aarch64` 选 arm64。
3. 把对应 tar 和 `docker-compose.nas.yml` 拷到 NAS，执行：

```bash
docker load -i omnihome-<版本号>-linux-amd64.tar   # 按架构与版本号替换文件名
docker compose -f docker-compose.nas.yml up -d     # 已有镜像，不加 --build
```

## 数据与备份

- 所有用户数据（账号、笔记、书签、偏好、仪表盘布局、备份）都在挂载的 `./data` 目录，备份该目录即可完整迁移。
- 升级：重新构建/导入新镜像后 `docker compose up -d` 重建容器，`data/` 不动则不丢数据。
- 存储引擎默认为文件（每用户一个目录）。可在「设置 → 数据与存储」切换为 SQLite / MySQL / PostgreSQL，切换时自动双向迁移。

## 可选：Docker 容器监控

「系统监控」页的 Docker 监控区需要读取宿主机 Docker 接口，且**仅管理员可见、默认关闭**
（管理员在「设置 → 功能设置」中开启）。启用容器监控需两步：

1. 取消 `docker-compose.nas.yml` 中 `docker.sock` 挂载行的注释；
2. 重建容器：`docker compose -f docker-compose.nas.yml up -d`。

群晖需先在 Container Manager 中确认 `/var/run/docker.sock` 存在；若不存在，
容器监控会自动降级为提示信息，其余功能不受影响。

## 群晖 Container Manager 图形界面方式

1. 项目 → 新建 → 上传/粘贴 `docker-compose.nas.yml` 内容（用路线 B 镜像时不需要 build 段）
2. 将 `./data` 改为实际存储路径，如 `/volume1/docker/omnihome/data`
3. 构建并启动，端口 8000
