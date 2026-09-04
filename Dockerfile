# 万事屋 OmniDesk · 自托管个人门户
# 构建：docker build -t omnihome:latest .
# 运行：docker compose up -d
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
# 阿里云 PyPI 镜像：NAS 在国内，直连官方源构建极慢甚至超时（部署文档硬性要求保留）
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com

COPY backend ./backend
COPY demo ./demo
COPY obsidian-plugin ./obsidian-plugin
# 浏览器扩展安装包（设置 → 功能设置 提供下载）；
# 用 glob 写法：文件缺失时构建不报错，接口会如实提示未附带。
# 注意：每次发版后需将最新 omnihome-extension.zip 放到构建目录根再构建镜像，
# 否则容器内仍是旧版扩展包。
COPY omnihome-extension.zi[p] ./

# 用户数据目录（宿主机卷挂载持久化；后端按相对路径解析到 /app/data）
RUN mkdir -p /app/data

EXPOSE 8000

ENV PYTHONUNBUFFERED=1

CMD ["python", "backend/main.py"]
