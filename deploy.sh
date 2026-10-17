#!/bin/sh
#
# 部署 / 升级 chat2api 容器。
#
# 在 NAS 上**只做这件事**：拉镜像、替换容器、清理旧镜像。不做任何构建。
#
#   ./deploy.sh            拉取 latest 并重建（日常升级用这个）
#   ./deploy.sh status     只查看状态，不动任何东西
#   ./deploy.sh logs       跟踪日志
#
# 为什么需要脚本而不是直接敲 compose：
#
#   1. 固定容器名（container_name: chat2api）意味着重建时必须先停旧容器，
#      否则新容器拿不到这个名字。compose up -d 会处理，但如果上一次部署
#      中途失败，可能留下一个 <hash>_chat2api 的过渡容器占着名字。
#
#   2. 每次 pull 新镜像后，旧镜像会变成 <none>:<none>。它们不再被任何容器
#      引用，但会一直占空间。这里在成功切换后清理掉。
#
# 清理只删「悬空」镜像（dangling），也就是真的没有标签、没有容器引用的那些，
# 不会碰你在用的 latest 或其他容器的镜像。

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

if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$SUDO $DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="$SUDO docker-compose"
elif [ -x /usr/local/bin/docker-compose ]; then
  COMPOSE="$SUDO /usr/local/bin/docker-compose"
else
  echo "ERROR: 找不到 docker compose" >&2
  exit 1
fi

CONTAINER="chat2api"
IMAGE="ghcr.io/liangnianzhi/chat2api:latest"
PORT="${CHAT2API_PORT:-8082}"

# 过渡容器：compose 在「需重建但名字被占」时会先建一个 <短id>_<name>。
cleanup_transition_containers() {
  found=""
  for name in $($SUDO $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^[0-9a-f]{12}_${CONTAINER}$" || true); do
    found="$found $name"
  done
  if [ -n "$found" ]; then
    echo ">> 清理过渡容器:$found"
    for name in $found; do $SUDO $DOCKER rm -f "$name" >/dev/null 2>&1 || true; done
  fi
}

# 悬空镜像（<none>）：旧版本被替换后留下的，已无容器引用。
cleanup_dangling() {
  ids="$($SUDO $DOCKER images -f dangling=true -q 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    count="$(echo "$ids" | wc -l | tr -d ' ')"
    echo ">> 清理 $count 个悬空镜像（旧版本）"
    # shellcheck disable=SC2086
    $SUDO $DOCKER rmi $ids >/dev/null 2>&1 || echo "   （部分镜像仍被引用，已跳过）"
  else
    echo ">> 没有悬空镜像需要清理"
  fi
}

wait_healthy() {
  i=0
  while [ "$i" -lt 60 ]; do
    status="$($SUDO $DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo none)"
    if [ "$status" = "healthy" ]; then return 0; fi
    i=$((i + 1))
    sleep 3
  done
  return 1
}

case "${1:-up}" in
  status)
    echo "--- 容器 ---"
    $SUDO $DOCKER ps -a --filter "name=^${CONTAINER}$" \
      --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
    echo
    echo "--- 镜像 ---"
    $SUDO $DOCKER images "$IMAGE" --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' || true
    echo
    echo "--- 健康 ---"
    curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "   (无响应)"
    echo
    echo "--- 悬空镜像 ---"
    $SUDO $DOCKER images -f dangling=true --format 'table {{.ID}}\t{{.Size}}' || true
    ;;

  logs)
    $SUDO $DOCKER logs -f --tail 100 "$CONTAINER"
    ;;

  up|"")
    echo ">> 1/4 拉取镜像"
    $COMPOSE pull

    echo ">> 2/4 重建容器"
    # --remove-orphans 清掉 compose 已不认识的容器；up -d 会停旧容器再起新的。
    $COMPOSE up -d --remove-orphans

    echo ">> 3/4 等待健康检查"
    if wait_healthy; then
      echo "   容器 healthy"
    else
      echo "   !! 未在 180s 内变 healthy，以下是日志：" >&2
      $SUDO $DOCKER logs --tail 60 "$CONTAINER" 2>&1 || true
      exit 1
    fi

    echo ">> 4/4 清理旧镜像与过渡容器"
    cleanup_transition_containers
    cleanup_dangling

    echo
    echo "--- 结果 ---"
    $SUDO $DOCKER ps --filter "name=^${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}' || true
    echo -n "API 端口: "
    curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "(无响应)"
    echo
    echo "访问地址: http://<主机IP>:${PORT}"
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
