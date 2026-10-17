#!/bin/sh
# Chat2API 网关 —— 运维脚本
#
# 镜像由 GitHub Actions 构建并推送到 ghcr.io/liangnianzhi/chat2api:latest，
# 正常情况下只需 pull，不必本地构建。本地源码构建仍可用（build / build-offline）。
#
# 兼容群晖 DSM 7（docker 在 /usr/local/bin 且需要 root），也适用于普通 Linux。
#
# 用法:
#   ./manage.sh up            启动（缺失时自动拉取镜像）
#   ./manage.sh pull          拉取最新镜像
#   ./manage.sh update        拉取最新镜像并重启
#   ./manage.sh down          停止
#   ./manage.sh restart       重启
#   ./manage.sh logs          跟踪日志
#   ./manage.sh status        容器 + 健康状态
#   ./manage.sh test          冒烟测试 API 与管理台
#   ./manage.sh version       当前运行的上游版本
#   ./manage.sh keygen        生成管理密钥
#   ./manage.sh fixdata       修复数据卷属主
#   ./manage.sh backup        备份数据卷
#   ./manage.sh shell         进入容器
#   ./manage.sh doctor        诊断
#
#   ./manage.sh build         本地从上游源码完整构建（可复现，较慢）
#   ./manage.sh build-offline 本地离线组装（快，需自备 .build/app-runtime.tgz）

set -eu

if command -v docker >/dev/null 2>&1; then
  DOCKER="docker"
elif [ -x /usr/local/bin/docker ]; then
  DOCKER="/usr/local/bin/docker"
else
  echo "ERROR: 未找到 docker。" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"
  else echo "ERROR: 非 root 且无 sudo。" >&2; exit 1; fi
fi
dk() { $SUDO $DOCKER "$@"; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

CONTAINER="chat2api"
# 与 docker-compose.yml 中的 image 保持一致，这样本地构建的结果
# 会被 compose 直接使用，不需要再拉取。
IMAGE="ghcr.io/liangnianzhi/chat2api:latest"

if dk compose version >/dev/null 2>&1; then
  COMPOSE="dk compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="$SUDO docker-compose"
elif [ -x /usr/local/bin/docker-compose ]; then
  COMPOSE="$SUDO /usr/local/bin/docker-compose"
else
  COMPOSE=""
fi
compose() {
  if [ -z "$COMPOSE" ]; then echo "ERROR: 未找到 docker compose。" >&2; exit 1; fi
  if [ "$COMPOSE" = "dk compose" ]; then dk compose "$@"; else $COMPOSE "$@"; fi
}

API_PORT=8080
UI_PORT=8081
if [ -f .env ]; then
  v=$(grep -E '^CHAT2API_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  [ -n "${v:-}" ] && API_PORT="$v"
  v=$(grep -E '^CHAT2API_UI_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  [ -n "${v:-}" ] && UI_PORT="$v"
fi

# 容器以 uid 1000 运行。若宿主卷属主不对，启动会直接失败：
#   EACCES: permission denied, mkdir '/data/.chat2api'
# （群晖 btrfs 卷挂载带 noacl/synoacl，走 DSM 自有 ACL，光靠 rwx 位不够。）
prepare_data() {
  mkdir -p "$SCRIPT_DIR/data"
  if [ "$(id -u)" = "0" ] || [ -n "$SUDO" ]; then
    $SUDO chown -R 1000:1000 "$SCRIPT_DIR/data" 2>/dev/null || true
    $SUDO chmod -R u+rwX "$SCRIPT_DIR/data" 2>/dev/null || true
  fi
}

image_exists() {
  dk image inspect "$IMAGE" >/dev/null 2>&1
}

case "${1:-}" in
  pull)
    echo ">> 拉取 ${IMAGE}"
    dk pull "$IMAGE"
    ;;

  up)
    prepare_data
    if image_exists; then
      echo ">> 使用本地已有镜像启动"
    else
      echo ">> 本地无镜像，compose 会自动拉取"
    fi
    compose up -d
    echo ">> 已启动，等待健康检查..."
    sleep 8
    "$0" status
    "$0" test || true
    echo
    echo ">> 管理台: http://<主机IP>:${UI_PORT}"
    ;;

  update)
    echo ">> 拉取最新镜像并重启"
    dk pull "$IMAGE"
    prepare_data
    compose up -d
    "$0" version
    ;;

  down)    compose down ;;
  restart) compose restart ;;
  logs)    dk logs -f --tail 100 "$CONTAINER" ;;

  status)
    echo "--- 容器 ------------------------------------------------------"
    dk ps -a --filter "name=^${CONTAINER}$" \
      --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
    echo
    echo "--- 镜像 ------------------------------------------------------"
    dk images "$IMAGE" --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' || true
    echo
    echo "--- 健康检查 --------------------------------------------------"
    curl -fsS "http://127.0.0.1:${API_PORT}/health" 2>/dev/null && echo || echo "  (无响应)"
    echo
    echo "--- 资源占用 --------------------------------------------------"
    dk stats --no-stream --format \
      'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "$CONTAINER" 2>/dev/null || true
    ;;

  test)
    echo "--- OpenAI API: GET /v1/models --------------------------------"
    KEY=""
    if [ -f .env ]; then KEY=$(grep -E '^CHAT2API_API_KEY=' .env | tail -1 | cut -d= -f2- || true); fi
    if [ -n "$KEY" ]; then
      curl -fsS -H "Authorization: Bearer $KEY" "http://127.0.0.1:${API_PORT}/v1/models" && echo || echo "  FAILED"
    else
      curl -fsS "http://127.0.0.1:${API_PORT}/v1/models" && echo || echo "  (可能需要 API 密钥，去管理台生成)"
    fi
    echo
    echo "--- Web 管理台: GET / -----------------------------------------"
    code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then echo "  HTTP 200 — 打开 http://<主机IP>:${UI_PORT}"
    else echo "  HTTP $code （管理台未就绪？）"; fi
    ;;

  version)
    echo "--- 镜像中的上游版本 ------------------------------------------"
    dk exec "$CONTAINER" cat /app/UPSTREAM_INFO 2>/dev/null || echo "  (容器未运行)"
    ;;

  keygen)
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
    else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo; fi
    ;;

  fixdata)
    echo ">> 修正数据卷属主为 1000:1000 ..."
    prepare_data
    $SUDO ls -lan "$SCRIPT_DIR/data" 2>/dev/null | head -5
    echo ">> 执行 ./manage.sh restart 生效"
    ;;

  backup)
    STAMP=$(date +%Y%m%d-%H%M%S)
    OUT="chat2api-data-${STAMP}.tar.gz"
    echo ">> 备份 ./data -> ${OUT}"
    echo ">> 内含凭证加密密钥，请妥善保管"
    $SUDO tar -czf "$OUT" -C "$SCRIPT_DIR" data
    ls -lh "$OUT"
    ;;

  shell)  dk exec -it "$CONTAINER" sh ;;

  doctor)
    echo "--- 容器状态 --------------------------------------------------"
    dk inspect -f 'Status={{.State.Status}} Restarts={{.RestartCount}} Health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo "(无容器)"
    echo "--- 启动错误（若有）------------------------------------------"
    dk inspect -f '{{.State.Error}}' "$CONTAINER" 2>/dev/null || true
    echo
    echo "--- 最近 40 行日志 --------------------------------------------"
    dk logs --tail 40 "$CONTAINER" 2>&1 || true
    echo
    echo "--- 数据卷 ----------------------------------------------------"
    $SUDO ls -lan "$SCRIPT_DIR/data" 2>/dev/null || echo "(无 data 目录)"
    echo "    （属主应为 1000:1000，否则执行 ./manage.sh fixdata）"
    ;;

  # ---- 以下为可选的本地构建（正常不需要） ---------------------------------
  build)
    echo ">> 本地完整构建（从上游源码编译），产物标记为 ${IMAGE}"
    echo ">> 这台机器上可能很慢；CI 上约 3-5 分钟"
    dk build -t "$IMAGE" .
    dk images "$IMAGE" --format '>> 完成: {{.Repository}}:{{.Tag}}  {{.Size}}'
    ;;

  build-offline)
    if [ ! -f .build/app-runtime.tgz ]; then
      echo "ERROR: 缺少 .build/app-runtime.tgz" >&2
      echo "请先按 .offline.Dockerfile 头部说明导出一份。" >&2
      exit 1
    fi
    echo ">> 离线组装（复用 .build/app-runtime.tgz）"
    dk build -f .offline.Dockerfile -t "$IMAGE" .
    dk images "$IMAGE" --format '>> 完成: {{.Repository}}:{{.Tag}}  {{.Size}}'
    ;;

  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
