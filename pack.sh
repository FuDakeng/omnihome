#!/usr/bin/env bash
# 万事屋 OmniHome · 部署包打包脚本
# 用法：./pack.sh
#
# 产出两个包（均不含任何用户数据，可安全外发）：
#   omnihome-deploy.tar.gz       通用源码包：含全部文档与两个 compose，适合任意机器从源码构建
#   omnihome-nas-deploy.tar.gz   NAS 精简包：只含 NAS 部署必需文件（去掉 Mac 专用的
#                                build-image.sh 与开发文档 demo/DESIGN.md）
#
# 版本号唯一来源：backend/app_version.py（与 /api/about 保持一致）
# 打包前请确保 backend/app_version.py 的 VERSION 与 CHANGELOG 已同步更新。
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(/usr/bin/python3 - <<'PY'
import re
print(re.search(r'VERSION\s*=\s*"([^"]+)"', open('backend/app_version.py').read()).group(1))
PY
)
echo ">> 版本 v${VERSION}"

# 后端源码自动收集 backend 下全部非测试 .py（含子包 routers/ store/）＋ 词库。
# 不要改回手工罗列：v0.2.3 就是因手写清单漏了 secretbox.py，
# 导致容器启动即 ModuleNotFoundError 陷入崩溃循环。
SRC=($(find backend -name '*.py' ! -name '_*' | sort) backend/data/words.json)
# 前端源码：壳层 + CSS 拆分 + ESM + views 片段
DEMO=()
while IFS= read -r f; do DEMO+=("$f"); done < <(
  find demo -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.md' \) | sort
)

# 打包：先 staging 再归档，确保包内没有 .DS_Store / __pycache__ / 用户数据
# $1 = 输出包名，其余 = 待打包文件
pack(){
  local out="$1"; shift
  local stage; stage=$(mktemp -d)
  mkdir -p "$stage/data"           # 空数据目录占位：解包后卷挂载目录存在且属主正确
  local item
  for item in "$@"; do
    mkdir -p "$stage/$(dirname "$item")"
    cp -R "$item" "$stage/$(dirname "$item")/"
  done
  find "$stage" \( -name '.DS_Store' -o -name '._*' -o -name '*.pyc' \) -delete 2>/dev/null || true
  find "$stage" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  tar -czf "$out" -C "$stage" .
  rm -rf "$stage"
}

rm -f omnihome-deploy.tar.gz omnihome-nas-deploy.tar.gz

echo ">> 打包通用源码包 omnihome-deploy.tar.gz"
pack omnihome-deploy.tar.gz \
  Dockerfile requirements.txt requirements.lock.txt CHANGELOG.md .dockerignore \
  docker-compose.yml docker-compose.nas.yml docker-compose.tls.yml Caddyfile \
  build-image.sh \
  omnihome-extension.zip \
  DEPLOY.md DEPLOY-NAS.md \
  "${SRC[@]}" "${DEMO[@]}"

echo ">> 打包 NAS 精简包 omnihome-nas-deploy.tar.gz"
pack omnihome-nas-deploy.tar.gz \
  Dockerfile requirements.txt requirements.lock.txt CHANGELOG.md .dockerignore \
  docker-compose.nas.yml \
  omnihome-extension.zip \
  DEPLOY-NAS.md \
  "${SRC[@]}" "${DEMO[@]}"

echo
echo ">> 产出："
ls -lh omnihome-deploy.tar.gz omnihome-nas-deploy.tar.gz | awk '{printf "   %-32s %s\n", $9, $5}'

echo
echo ">> 校验：包内不应出现任何用户数据或加密主密钥"
local_fail=0
for f in omnihome-deploy.tar.gz omnihome-nas-deploy.tar.gz; do
  bad=$(tar -tzf "$f" | grep -E 'data/users/|data/config\.json|secret\.key|\.db$|nohup\.out' || true)
  if [ -n "$bad" ]; then
    echo "   ✗ $f 含用户数据或主密钥：" && echo "$bad" && local_fail=1
  else
    printf "   ✓ %-28s 干净（%s 项）\n" "$f" "$(tar -tzf "$f" | wc -l | tr -d ' ')"
  fi
done

# 解包后真正 import 一遍所有后端模块。
# 这是最后一道防线：只要漏打包任何一个被 import 的模块，
# 容器就会在启动瞬间 ModuleNotFoundError 并陷入重启循环。
echo
echo ">> 校验：解包后后端模块可正常导入"
IMPORT_CHECK='
import importlib, pathlib, sys
bad = []
for p in sorted(pathlib.Path(".").glob("*.py")):
    if p.stem.startswith("_"):
        continue
    try:
        importlib.import_module(p.stem)
    except Exception as e:
        bad.append("      %s: %s: %s" % (p.name, type(e).__name__, e))
if bad:
    print("\n".join(bad))
    sys.exit(1)
'
for f in omnihome-deploy.tar.gz omnihome-nas-deploy.tar.gz; do
  tmp=$(mktemp -d)
  tar -xzf "$f" -C "$tmp"
  if (cd "$tmp/backend" && /usr/bin/python3 -c "$IMPORT_CHECK" >/dev/null 2>"$tmp/imp.log"); then
    printf "   ✓ %-28s 后端模块导入正常\n" "$f"
  else
    echo "   ✗ $f 后端模块导入失败（容器会启动即崩溃）："
    sed 's/^/       /' "$tmp/imp.log" | tail -8
    local_fail=1
  fi
  rm -rf "$tmp"
done

[ "$local_fail" -eq 0 ] || exit 1
