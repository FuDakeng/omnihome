#!/usr/bin/env bash
# 万事屋 OmniDesk · 镜像构建与导出脚本
# 用法：
#   ./build-image.sh          构建当前架构镜像（本机验证）
#   ./build-image.sh export   分别构建 amd64 / arm64 镜像并导出为 tar，
#                             按 NAS 架构选一个用 docker load 导入
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=omnihome
# 版本号唯一来源：backend/app_version.py（与 /api/about 保持一致）
VERSION=$(python3 - <<'PY'
import re
print(re.search(r'VERSION\s*=\s*"([^"]+)"', open('backend/app_version.py').read()).group(1))
PY
)
TAG="${VERSION}"
echo ">> 当前版本：v${VERSION}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未检测到 docker，请先安装 Docker Desktop（或将源码包拷到 NAS 上构建）" >&2
  exit 1
fi

if [ "${1:-}" = "export" ]; then
  docker buildx create --name omni-builder --use >/dev/null 2>&1 || docker buildx use omni-builder
  docker buildx inspect --bootstrap >/dev/null
  for ARCH in amd64 arm64; do
    OUT="${IMAGE}-${TAG}-linux-${ARCH}.tar"
    echo ">> 构建 linux/${ARCH} 镜像并导出到 ${OUT} ..."
    docker buildx build --platform "linux/${ARCH}" \
      -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" \
      --output "type=docker,dest=${OUT}" .
  done
  echo ">> 完成。按 NAS 架构（uname -m）选对应 tar："
  echo "   x86_64 → ${IMAGE}-${TAG}-linux-amd64.tar；aarch64 → ${IMAGE}-${TAG}-linux-arm64.tar"
  echo "   传到 NAS 后执行: docker load -i <tar 文件>"
else
  docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .
  echo ">> 构建完成：${IMAGE}:${TAG}（同时打了 ${IMAGE}:latest）"
fi
