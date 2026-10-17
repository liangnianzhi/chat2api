#!/bin/sh
#
# 升级 chat2api 镜像。
#
# 容器本身由群晖（Container Manager / 套件里的 Docker）根据 compose 创建，
# 所以这里**不重建容器**，只做镜像相关的事：
#
#   1. 拉取 latest
#   2. 等你在群晖里把旧容器「重置 / 重新创建」
#   3. 确认新容器健康
#   4. 清理被替换下来的旧镜像
#
# 用法：
#
#   ./deploy.sh            完整流程（会等你在群晖里重置容器）
#   ./deploy.sh pull       只拉镜像
#   ./deploy.sh wait       只等健康 + 清理旧镜像（重置完再跑这个）
#   ./deploy.sh status     只查看状态
#   ./deploy.sh logs       跟踪日志
#
# 为什么要等：docker pull 只换掉镜像，正在跑的容器仍用旧镜像。群晖里「重置」
# 会按 compose 用新镜像重建容器——这一步在群晖界面上做，脚本无法可靠代劳。

set -eu

cd "$(dirname "$0")"

if command -v docker >/dev/null 2>&1; then
  DOCKER="docker"
elif [ -x /usr/local/bin/docker ]; then
  DOCKER="/usr/local/bin/docker"
else
  echo "ERROR: 找不到 docker" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    echo "ERROR: 非 root 且无 sudo" >&2; exit 1
  fi
fi

IMAGE="ghcr.io/liangnianzhi/chat2api:latest"
CONTAINER="${CHAT2API_CONTAINER:-chat2api}"
PORT="${CHAT2API_PORT:-8082}"
TIMEOUT="${CHAT2API_WAIT_SECONDS:-300}"

container_status() {
  $SUDO "$DOCKER" inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing
}

container_health() {
  $SUDO "$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$CONTAINER" 2>/dev/null || echo missing
}

# 容器当前实际使用的镜像 ID
container_image() {
  $SUDO "$DOCKER" inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || echo none
}

# 悬空镜像（<none>）：被替换下来、已无容器引用的旧版本。
cleanup_dangling() {
  ids="$($SUDO "$DOCKER" images -f dangling=true -q 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    count="$(echo "$ids" | wc -l | tr -d ' ')"
    echo ">> 清理 $count 个旧镜像（<none>，已无容器引用）"
    # shellcheck disable=SC2086
    $SUDO "$DOCKER" rmi $ids >/dev/null 2>&1 || echo "   （部分镜像仍被占用，已跳过）"
  else
    echo ">> 没有需要清理的旧镜像"
  fi
}

do_pull() {
  echo ">> 拉取 $IMAGE"
  $SUDO "$DOCKER" pull "$IMAGE"
}

do_wait() {
  before="$1"
  echo ">> 等待容器使用新镜像"
  echo "   请到群晖「容器管理器」里把 $CONTAINER 重置 / 重新创建（动作 → 重置）"
  echo "   在此之前，正在运行的容器仍然是旧镜像。"
  echo

  elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    now="$(container_image)"

    if [ "$now" != "$before" ] && [ "$now" != "none" ]; then
      status="$(container_status)"
      health="$(container_health)"

      if [ "$status" = "running" ]; then
        if [ "$health" = "healthy" ]; then
          echo "   容器已用新镜像重建，状态 healthy（用时 ${elapsed}s）"
          echo
          echo "--- 结果 ---"
          $SUDO "$DOCKER" ps --filter "name=^${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}' || true
          echo -n "API 端口 127.0.0.1:${PORT}/health: "
          curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "(无响应)"
          echo
          cleanup_dangling
          return 0
        fi
        echo "   ...容器已重建，健康检查：${health}"
      else
        echo "   ...容器已重建，状态：${status}"
      fi
    fi

    sleep 5
    elapsed=$((elapsed + 5))
    # 每 30 秒提示一次，避免刷屏
    if [ $((elapsed % 30)) -eq 0 ]; then
      echo "   ...仍在等待（已 ${elapsed}s，容器镜像未变或尚未健康）"
    fi
  done

  echo "!! 等待超时（${TIMEOUT}s）。" >&2
  echo "   如果你已经在群晖里重置过容器，下面是当前状态：" >&2
  do_status >&2
  exit 1
}

do_status() {
  echo "--- 容器 ---"
  $SUDO "$DOCKER" ps -a --filter "name=^${CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
  echo
  echo "--- 镜像 ---"
  $SUDO "$DOCKER" images "$IMAGE" \
    --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' || true
  echo
  echo "--- 容器使用的镜像 vs latest ---"
  echo "   容器: $(container_image)"
  echo "   latest: $($SUDO "$DOCKER" image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo none)"
  echo
  echo "--- 健康 ---"
  curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "   (无响应)"
  echo
  echo "--- 旧镜像（<none>）---"
  $SUDO "$DOCKER" images -f dangling=true --format 'table {{.ID}}\t{{.Size}}' || true
}

case "${1:-up}" in
  pull)
    do_pull
    ;;

  wait)
    do_wait "$(container_image)"
    ;;

  status)
    do_status
    ;;

  logs)
    $SUDO "$DOCKER" logs -f --tail 100 "$CONTAINER"
    ;;

  up|"")
    before="$(container_image)"
    do_pull
    do_wait "$before"
    echo
    echo "访问地址: http://<主机IP>:${PORT}"
    ;;

  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
