#!/bin/sh
#
# 运维入口：拉镜像、重建容器、查状态、看日志、改端口、本地重建。
#
# 本脚本只负责一件事：让升级与排障在群晖上可重复执行。容器仍由 compose 定义，
# 镜像地址、端口、数据卷只有一处来源。
#
# 用法：
#
#   ./deploy.sh                 升级：拉取镜像并重建容器（不需要再去群晖界面点重置）
#   ./deploy.sh upgrade         同上
#   ./deploy.sh pull            只拉镜像，不动正在跑的容器
#   ./deploy.sh restart         重启容器（不拉镜像）
#   ./deploy.sh status          打印容器/镜像/健康/端口摘要
#   ./deploy.sh logs [行数]     跟踪日志（默认 100 行历史）
#   ./deploy.sh port N          改公开端口为 N，同步 compose 并重建容器
#   ./deploy.sh build [tag]     本机构建镜像并打印体积（默认 <镜像>:local-<时间戳>）
#                               构建前会先校验所有源文件『1.5 秒内两次 stat 一致』，
#                               防止把队友半写状态的文件打进镜像（见下方闸门注释）
#   ./deploy.sh rebuild [tag]   构建后立刻用只读副本自测
#   ./deploy.sh verify [tag]    只用只读副本自测（默认当前镜像）
#   ./deploy.sh wait            等容器用上新镜像（旧流程，供手动重置后使用）
#
# 环境变量：
#
#   CHAT2API_CONTAINER     容器名（默认 chat2api）
#   CHAT2API_PORT          公开端口（默认读 compose，其次 8082）
#   CHAT2API_IMAGE         镜像地址（默认读 compose）
#   CHAT2API_COMPOSE_FILE  compose 文件名（默认自动查找）
#   CHAT2API_WAIT_SECONDS  等待健康上限秒数（默认 120）
#   CHAT2API_VERIFY_PORT   副本自测端口（默认 18089）
#   STABLE_INTERVAL        落盘稳定检测的间隔秒数（默认 1.5）
#   STABLE_ROUNDS          最多等几轮（默认 5）
#
set -eu

# 先把脚本自己的路径记下来再 cd。只写 cd "$(dirname "$0")" 是不行的：
# 那之后 $0 可能是相对路径，而 help/未知命令两处要用 sed 读自己开头的注释；
# 一旦 cd 让它失效，`./deploy.sh --help` 就只剩一句 sed 报错。
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SELF=$SELF_DIR/$(basename -- "$0")
cd "$SELF_DIR"

# ------------------------------------------------------------------ #
# 基础探测：docker 可能在 PATH 里，也可能只有 /usr/local/bin/docker
# ------------------------------------------------------------------ #
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
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "ERROR: 非 root 且无 sudo" >&2
    exit 1
  fi
fi

CONTAINER="${CHAT2API_CONTAINER:-chat2api}"
TIMEOUT="${CHAT2API_WAIT_SECONDS:-120}"
VERIFY_PORT="${CHAT2API_VERIFY_PORT:-18089}"

# docker compose 插件与独立的 docker-compose 二进制都支持，优先插件。
COMPOSE_BIN=""
COMPOSE_KIND=""
detect_compose() {
  if [ -n "$COMPOSE_KIND" ]; then return 0; fi
  if $SUDO "$DOCKER" compose version >/dev/null 2>&1; then
    COMPOSE_BIN="$SUDO $DOCKER compose"
    COMPOSE_KIND="plugin"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN="$SUDO docker-compose"
    COMPOSE_KIND="standalone"
    return 0
  fi
  COMPOSE_KIND="none"
  return 1
}

compose() {
  # shellcheck disable=SC2086
  $COMPOSE_BIN "$@"
}

# compose 文件里若引用了 external 网络，网络不存在时 compose 会直接失败。
# 升级前先查一次，给出人能读懂的提示；只读不写。
preflight_network() {
  [ -n "$COMPOSE_FILE" ] || return 0
  nets="$(sed -n '/^networks:/,$p' "$COMPOSE_FILE" | sed -n 's/^  \([A-Za-z0-9_.-]*\):[[:space:]]*$/\1/p')"
  for n in $nets; do
    if ! $SUDO "$DOCKER" network inspect "$n" >/dev/null 2>&1; then
      echo "!! external 网络 ${n} 不存在：compose 会启动失败。" >&2
      echo "   群晖上一般到「控制面板 → 网络 → Docker」或先建一个同名网络即可。" >&2
      return 1
    fi
  done
  return 0
}

COMPOSE_FILE=""
find_compose_file() {
  if [ -n "${CHAT2API_COMPOSE_FILE:-}" ]; then
    if [ -f "$CHAT2API_COMPOSE_FILE" ]; then
      COMPOSE_FILE="$CHAT2API_COMPOSE_FILE"
      return 0
    fi
    return 1
  fi
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [ -f "$f" ]; then COMPOSE_FILE="$f"; return 0; fi
  done
  return 1
}
if ! find_compose_file; then
  echo "ERROR: 当前目录找不到 compose 文件（docker-compose.yml / compose.yml）" >&2
  exit 1
fi

# ------------------------------------------------------------------ #
# 从 compose 读配置：镜像地址与端口只有一处来源
# ------------------------------------------------------------------ #
image_from_compose() {
  sed -n 's/^[[:space:]]*image:[[:space:]]*\(.*\)$/\1/p' "$COMPOSE_FILE" | head -1 | tr -d "'"
}

# 取第一个 host:container 端口映射里的 host 部分（去掉前导 - 和引号）。
# 写成两条普通替换，避免 GNU 专有的 \+ 与 \? 语法：容器里的 sed 也能跑。
# 字符类里只匹配双引号，不匹配单引号：POSIX sh 在引号里嵌引号极易写错，
# 而 compose 里的端口写法几乎都是 "8082:8082"。
port_from_compose() {
  sed -n 's/^[[:space:]]*-[[:space:]]*["]//p' "$COMPOSE_FILE" \
    | sed -n 's/^\([0-9][0-9]*\):[0-9][0-9]*["].*/\1/p' \
    | head -1
}

# ------------------------------------------------------------------ #
# 镜像与端口：compose 是唯一来源，读不到就明说，不静默兜底
# ------------------------------------------------------------------ #
IMAGE="${CHAT2API_IMAGE:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="$(image_from_compose)"
  if [ -z "$IMAGE" ]; then
    IMAGE="ghcr.nju.edu.cn/liangnianzhi/chat2api:latest"
    echo "!! ${COMPOSE_FILE} 里没读到 image，退回默认 ${IMAGE}" >&2
    echo "   若这不是预期值，请检查 compose 的 image 行，或用 CHAT2API_IMAGE 指定" >&2
  fi
fi

PORT="${CHAT2API_PORT:-}"
if [ -z "$PORT" ]; then
  PORT="$(port_from_compose)"
  if [ -z "$PORT" ]; then
    PORT=8082
    echo "!! ${COMPOSE_FILE} 里没读到 host 端口映射，摘要按 ${PORT} 显示" >&2
    echo "   若实际端口不同，请用 CHAT2API_PORT 指定" >&2
  fi
fi

# ------------------------------------------------------------------ #
# 容器状态
# ------------------------------------------------------------------ #
container_status() {
  # 容器不存在不是错误，是最常见的正常情况（首次部署/已删除）：
  # 这里故意吞掉 inspect 的报错，改由调用方看到明确的 missing。
  $SUDO "$DOCKER" inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing
}

container_health() {
  $SUDO "$DOCKER" inspect \
    -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$CONTAINER" 2>/dev/null || echo missing
}

container_image() {
  $SUDO "$DOCKER" inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || echo none
}

latest_image() {
  # 镜像还没 pull 过时返回 none：do_status 靠它区分"已拉新镜像未重建"。
  $SUDO "$DOCKER" image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo none
}

image_size() {
  # 体积读不到就是 0，摘要里显示 0MB 比整段失败有用。
  $SUDO "$DOCKER" image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0
}

# 用容器 IP 而不是 127.0.0.1：群晖上宿主机访问容器端口不保证通，容器 IP 一定通。
container_ip() {
  $SUDO "$DOCKER" inspect \
    -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$CONTAINER" 2>/dev/null | awk '{print $1}'
}

# 纯 shell 从 /health 的 JSON 里取字段，不依赖 python3 / jq。
#
# 为什么不用 python3：这个脚本既在群晖宿主机上跑（自带 python3），也在容器
# 里跑（镜像基于 alpine，没有 python3）。缺 python3 的环境上这段解析会静默
# 失败，摘要变成空白——比报错还难发现。改用只在 JSON 文本上做匹配的 shell
# 函数：/health 是我们自己输出的扁平 JSON、键名固定，够用了，且任何 POSIX
# shell 下行为一致。
#
# json_scalar <json> <key> [<parent-key>]
#   返回 KEY 之后的标量值（字符串去掉引号）；给了 parent-key 时先定位
#   该父键对应的子对象，再在它后面找 KEY。
json_scalar() {
  _js_rest=$(printf '%s' "$1" | tr -d "\n")
  if [ -n "${3:-}" ]; then
    _js_rest=$(printf '%s' "$_js_rest" | sed -n "s/.*\"${3:-}\":{//")
  fi
  printf '%s' "$_js_rest" | sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p; s/.*\"$2\": *\([^,}\"]*\)[,}].*/\1/p" | head -n 1
}

# 一行人看的 /health 摘要。取不到的字段就不写，不猜。
summarize_health() {
  _sm_raw="$1"
  [ -n "$_sm_raw" ] || { echo "/health 没有响应"; return 0; }
  _sm_status=$(json_scalar "$_sm_raw" status)
  _sm_up=$(json_scalar "$_sm_raw" uptime)
  _sm_ver=$(json_scalar "$_sm_raw" version upstream)
  _sm_total=$(json_scalar "$_sm_raw" total accounts)
  _sm_active=$(json_scalar "$_sm_raw" active accounts)
  _sm_error=$(json_scalar "$_sm_raw" error accounts)
  _sm_rss=$(json_scalar "$_sm_raw" rss memoryMB)
  _sm_writable=$(json_scalar "$_sm_raw" writable store)
  _sm_line="status=${_sm_status:-?}"
  [ -n "$_sm_up" ] && _sm_line="$_sm_line | uptime=${_sm_up}s"
  [ -n "$_sm_ver" ] && _sm_line="$_sm_line | upstream=${_sm_ver}"
  if [ -n "$_sm_total" ]; then
    _sm_acc="accounts=${_sm_total}"
    if [ -n "$_sm_active" ]; then
      _sm_acc="$_sm_acc(active ${_sm_active}"
      if [ -n "$_sm_error" ] && [ "$_sm_error" != 0 ]; then
        _sm_acc="$_sm_acc, error ${_sm_error}"
      fi
      _sm_acc="$_sm_acc)"
    fi
    _sm_line="$_sm_line | $_sm_acc"
  fi
  if [ -n "$_sm_rss" ]; then
    _sm_line="$_sm_line | rss=${_sm_rss}MB"
  fi
  if [ "$_sm_writable" = false ]; then
    _sm_line="$_sm_line | STORE-NOT-WRITABLE"
  fi
  printf '%s\n' "$_sm_line"
}
cleanup_dangling() {
  ids="$($SUDO "$DOCKER" images -f dangling=true -q)"
  if [ -n "$ids" ]; then
    count=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
    echo ">> 清理 ${count} 个旧镜像（<none>，已无容器引用）"
    # shellcheck disable=SC2086
    $SUDO "$DOCKER" rmi $ids >/dev/null || echo "   !! 有镜像仍被占用，未删除（不影响运行）" >&2
  else
    echo ">> 没有需要清理的旧镜像"
  fi
}

wait_healthy() {
  label=$1
  elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    status=$(container_status)
    health=$(container_health)
    if [ "$status" = running ] && [ "$health" = healthy ]; then
      echo "   ${label}已 healthy（用时 ${elapsed}s）"
      return 0
    fi
    case "$status" in
      exited|dead)
        echo "   ${label}状态 ${status}，不再等待" >&2
        return 1
        ;;
    esac
    sleep 3
    elapsed=$((elapsed + 3))
    if [ $((elapsed % 30)) -eq 0 ]; then
      echo "   ...${label}仍在等待（${elapsed}s，status=${status} health=${health}）"
    fi
  done
  echo "   ${label}等待健康超时（${TIMEOUT}s）" >&2
  return 1
}

# ------------------------------------------------------------------ #
# 构建前的一致性闸门：源文件『落盘稳定』才能进构建上下文
#
# 踩过两次的真实故障：stage 目录是在别人（selfheal / security / obs）正
# 在写文件的那一秒抓的，于是镜像里装进去的是半写版本 —— /health 里一条
# warning 修不掉，查了半天才发现是旧快照，不是代码没修好。
#
# 规则（shell 实现，不依赖任何外部命令）：
#   1) 每个待拷文件在 1.5 秒间隔内 stat 两次，size 与 mtime 必须一致；
#   2) 不一致就等下一轮，最多等 MAX_ROUNDS 轮（默认 5 轮 ≈ 7.5 秒）；
#   3) 仍不一致 → 直接失败，不带着半写文件去 build。
#   4) 构建结束后可用 check_stable <dir> 再核一次 size。
#
# 用法： ./deploy.sh build 会在 build 之前自动跑一次；
#        check_stable shim/selfheal.js shim/health.js ...  传文件列表。
# ------------------------------------------------------------------ #
STABLE_INTERVAL=${STABLE_INTERVAL:-1.5}
STABLE_ROUNDS=${STABLE_ROUNDS:-5}

# 取 '<size> <mtime>'，不依赖 GNU stat 的参数差异（群晖是 BusyBox 风格）
file_stamp() {
  if [ ! -f "$1" ]; then
    echo MISSING
    return 0
  fi
  ls -ln "$1" | awk '{print $5, $8}'
}

# check_stable <file>...  返回 0 = 全部稳定；1 = 有文件不稳或缺失
check_stable() {
  _round=0
  while [ "$_round" -lt "$STABLE_ROUNDS" ]; do
    _round=$((_round + 1))
    _bad=0
    for _f in "$@"; do
      _a=$(file_stamp "$_f")
      sleep "$STABLE_INTERVAL"
      _b=$(file_stamp "$_f")
      if [ "$_a" != "$_b" ]; then
        echo "   .. 还在写: $_f ($_a -> $_b)" >&2
        _bad=1
      elif [ "$_a" = "MISSING" ]; then
        echo "!! 缺少文件: $_f" >&2
        return 1
      fi
    done
    if [ "$_bad" -eq 0 ]; then
      return 0
    fi
  done
  echo "!! 等待 $_round 轮后文件仍在变化，已中止构建（请确认写文件的队友已经落盘）" >&2
  return 1
}

# 交给 check_stable 的文件清单：shim + webui + compose（都是人手改的）
build_inputs() {
  for _d in shim webui tests; do
    [ -d "$_d" ] || continue
    find "$_d" -type f 2>/dev/null | sort
  done
  for _f in Dockerfile docker-compose.yml package.json UPSTREAM.lock; do
    [ -f "$_f" ] && echo "$_f"
  done
}
# ------------------------------------------------------------------ #
# 本地重建镜像（不 push、不动 latest）
#
# ./deploy.sh build [tag]   只构建 + 打印体积，不起任何容器
#
# 默认 tag 是 <镜像名>:local-<短时间戳>，绝不覆盖 compose 里在用的 :latest：
# 本地构建出来的东西没进过 CI，覆盖 latest 之后 ./deploy.sh upgrade 会静默地
# 把这份本地镜像当成"最新"再用一次。
# ------------------------------------------------------------------ #
do_build() {
  tag="${1:-}"
  if [ -z "$tag" ]; then
    tag="${IMAGE%:*}:local-$(date +%Y%m%d%H%M%S)"
  fi
  # 构建前先确认所有输入文件都写完了（两轮 stat 一致）。
  # 这一条来自两次真实故障：别人正在写文件时抓 stage，镜像里进了半写版本。
  echo ">> 检查源文件是否已落盘稳定（间隔 ${STABLE_INTERVAL}s，最多 ${STABLE_ROUNDS} 轮）"
  # shellcheck disable=SC2046
  _inputs=$(build_inputs)
  _n=$(printf '%s\n' "$_inputs" | grep -c . || true)
  echo "   待检查文件: ${_n} 个（shim/ webui/ tests/ + Dockerfile docker-compose.yml package.json UPSTREAM.lock）"
  # shellcheck disable=SC2086
  if ! check_stable $_inputs; then
    echo "!! 源文件未稳定，构建已取消；等队友回一句『文件已就位』再跑" >&2
    return 1
  fi
  # 闸门通过后把 size/mtime 快照落盘，便于事后追溯「这个镜像用的是哪一版源码」。
  _snap=/volume1/docker/chat2api/tmp/build-snapshot-$(date +%Y%m%d%H%M%S).txt
  if printf '%s\n' "$_inputs" | while IFS= read -r _f; do
       [ -n "$_f" ] || continue
       printf '%s %s\n' "$(file_stamp "$_f")" "$_f"
     done > "$_snap" 2>/dev/null; then
    echo "   源码快照: ${_snap}"
  else
    echo "   (源码快照写入失败，不影响构建)" >&2
  fi
  echo ">> 构建镜像 ${tag}"
  echo "   构建目录: $(pwd)（Dockerfile）"
  $SUDO "$DOCKER" build -t "$tag" . || { echo "!! 构建失败" >&2; exit 1; }
  bytes=$($SUDO "$DOCKER" image inspect "$tag" --format '{{.Size}}' 2>/dev/null || echo 0)
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  echo ">> 镜像体积: $((bytes / 1024 / 1024))MB（${bytes} bytes）"
  echo ">> tag: ${tag}"
  echo "   验证: ./deploy.sh verify ${tag}"
  echo "   替换生产容器前请先在副本上验证，验证通过再改 compose 的 image 或 ./deploy.sh restart。"
}

do_pull() {
  echo ">> 拉取 ${IMAGE}"
  $SUDO "$DOCKER" pull "$IMAGE"
}

do_upgrade() {
  before=$(container_image)
  do_pull
  echo ">> 用 compose 重建容器（镜像已更新）"
  if ! detect_compose; then
    echo "!! 没有 docker compose 可用，退回旧流程：请在群晖「容器管理器」里重置 ${CONTAINER}" >&2
    do_wait "$before"
    return $?
  fi
  echo "   compose 命令: ${COMPOSE_KIND}（$COMPOSE_FILE）"
  preflight_network || return 1
  # 不用 --remove-orphans：同一 project 下手动创建的容器会被一并清掉。
  if ! compose -f "$COMPOSE_FILE" up -d --force-recreate "$CONTAINER"; then
    echo "!! compose up 失败，容器可能仍在运行旧镜像，请检查上面的报错" >&2
    return 1
  fi
  if ! wait_healthy "容器"; then
    echo "!! 新容器未能在 ${TIMEOUT}s 内 healthy，最近的日志：" >&2
    $SUDO "$DOCKER" logs --tail 40 "$CONTAINER" >&2 || true
    return 1
  fi
  do_report
  cleanup_dangling
}

# 兼容旧流程：docker pull 之后由人工在群晖里重置容器。
do_wait() {
  before=$1
  echo ">> 等待容器使用新镜像"
  echo "   请到群晖「容器管理器」里把 ${CONTAINER} 重置 / 重新创建（动作 → 重置）"
  echo "   在此之前，正在运行的容器仍然是旧镜像。"
  echo
  elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    now=$(container_image)
    if [ "$now" != "$before" ] && [ "$now" != none ]; then
      status=$(container_status)
      health=$(container_health)
      if [ "$status" = running ] && [ "$health" = healthy ]; then
        echo "   容器已用新镜像重建，状态 healthy（用时 ${elapsed}s）"
        do_report
        cleanup_dangling
        return 0
      fi
      echo "   ...容器已重建，status=${status} health=${health}"
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "!! 等待超时（${TIMEOUT}s）。" >&2
  do_status >&2
  exit 1
}

do_restart() {
  echo ">> 重启 ${CONTAINER}"
  $SUDO "$DOCKER" restart "$CONTAINER"
  if ! wait_healthy "容器"; then
    $SUDO "$DOCKER" logs --tail 40 "$CONTAINER" >&2 || true
    return 1
  fi
  do_report
}

# 人类可读摘要：容器用的哪个镜像、健康与否、上游版本、账号数、内存。
do_report() {
  bytes=$(image_size)
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  mb=$((bytes / 1024 / 1024))
  echo
  echo "--- 结果 ---"
  echo "   容器:   ${CONTAINER}  status=$(container_status)  health=$(container_health)"
  echo "   镜像:   ${IMAGE}（${mb}MB）"
  echo "   端口:   http://<主机IP>:${PORT}"
  body="$(curl -sS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    ip=$(container_ip)
    if [ -n "$ip" ]; then
      body="$(curl -sS --max-time 5 "http://${ip}:${PORT}/health" 2>/dev/null || true)"
    fi
  fi
  if [ -n "$body" ]; then
    echo "   健康:   $(summarize_health "$body")"
  else
    echo "   健康:   /health 无响应（容器可能仍在启动）"
  fi
}

do_status() {
  echo "--- 容器 ---"
  $SUDO "$DOCKER" ps -a --filter "name=^${CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
  echo
  echo "--- 镜像（${IMAGE}）---"
  $SUDO "$DOCKER" images "$IMAGE" \
    --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' || true
  echo
  echo "--- 容器使用的镜像 vs latest ---"
  echo "   容器:   $(container_image)"
  echo "   latest: $(latest_image)"
  if [ "$(container_image)" = "$(latest_image)" ]; then
    echo "   → 一致（已使用最新镜像）"
  else
    echo "   → 不一致（已拉取新镜像但容器还没重建）：./deploy.sh restart"
  fi
  echo
  echo "--- 健康（${PORT}）---"
  # 群晖的 NAT 规则不保证宿主机访问 127.0.0.1:PORT 能到容器（实测不通），
  # 所以两条路都试：先试容器 IP，再退回宿主机回环。
  body=
  ip=$(container_ip)
  if [ -n "$ip" ]; then
    # 故意不用 -f：/health 自检失败时回 503，而响应体恰恰是排障最需要的东西。
    body="$(curl -sS --max-time 5 "http://${ip}:${PORT}/health" 2>/dev/null || true)"
  fi
  if [ -z "$body" ]; then
    body="$(curl -sS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
  fi
  if [ -n "$body" ]; then
    echo "   $(summarize_health "$body")"
  else
    echo "   /health 无响应；容器 healthcheck 最近记录："
    $SUDO "$DOCKER" inspect --format '{{json .State.Health}}' "$CONTAINER" 2>/dev/null | cut -c1-400 || true
  fi
  echo
  echo "--- compose ---"
  if detect_compose; then
    echo "   ${COMPOSE_KIND}（$COMPOSE_FILE）"
  else
    echo "   未安装 docker compose（升级只能用旧流程，或在群晖界面重置容器）"
  fi
  echo
  echo "--- 旧镜像（<none>）---"
  $SUDO "$DOCKER" images -f dangling=true --format 'table {{.ID}}\t{{.Size}}' || true
}

do_logs() {
  lines=${1:-100}
  case "$lines" in ''|*[!0-9]*) lines=100 ;; esac
  $SUDO "$DOCKER" logs -f --tail "$lines" "$CONTAINER"
}

# ------------------------------------------------------------------ #
# 改端口：只改 compose 里那一条映射，然后重建容器
# ------------------------------------------------------------------ #
do_port() {
  new=${1:-}
  case "$new" in ''|*[!0-9]*) echo "用法: ./deploy.sh port <1-65535>" >&2; exit 2 ;; esac
  if [ "$new" -lt 1 ] || [ "$new" -gt 65535 ]; then
    echo "ERROR: 端口必须是 1-65535" >&2
    exit 2
  fi
  if $SUDO "$DOCKER" ps --format '{{.Names}} {{.Ports}}' | grep -q "0.0.0.0:${new}->"; then
    echo "ERROR: 端口 ${new} 已被占用" >&2
    exit 1
  fi

  old="$(port_from_compose)"
  if [ -z "$old" ]; then
    echo "!! compose 里没找到 host 端口映射，无法安全改写，已中止" >&2
    exit 1
  fi
  if [ "$old" = "$new" ]; then
    echo ">> 端口已经是 ${new}，无需修改"
    PORT=$new
    do_report
    return 0
  fi

  # 只替换第一条 host:container 映射里的 host 部分，其余字节原样保留。
  awk -v newport="$new" '
    !done && /^[[:space:]]*-[[:space:]]*"[0-9][0-9]*:[0-9][0-9]*"/ {
      sub(/"[0-9][0-9]*:/, "\"" newport ":")
      done = 1
    }
    { print }
  ' "$backup" > "$COMPOSE_FILE"

  PORT=$new
  written="$(port_from_compose)"
  if [ "$written" != "$new" ]; then
    echo "!! compose 自动改写失败，已恢复备份" >&2
    cp "$backup" "$COMPOSE_FILE"
    exit 1
  fi
  echo ">> compose 端口已改为 ${new}（原 ${old}）"

  if detect_compose; then
    if ! compose -f "$COMPOSE_FILE" up -d --force-recreate "$CONTAINER"; then
      echo "!! 重建失败；compose 已保留新端口，回滚: cp ${backup} ${COMPOSE_FILE}" >&2
      exit 1
    fi
    wait_healthy "容器" || true
  else
    echo ">> 没有 docker compose，请在群晖界面里重置容器以应用新端口"
  fi
  do_report
  echo "   （healthcheck 走容器内 127.0.0.1，与公开端口无关，无需改动）"
}

# ------------------------------------------------------------------ #
# 本地重建镜像 + 只读副本自测
#
# 绝不碰生产容器：副本用独立名字、独立端口、独立数据目录，数据是生产目录的拷贝。
# ------------------------------------------------------------------ #
do_verify_copy() {
  name="${CONTAINER}-verify"
  image="${1:-${VERIFY_IMAGE:-$IMAGE}}"
  src_data="$(pwd)/data"
  verify_data="$(pwd)/tmp/verify-data"

  mkdir -p "$(pwd)/tmp"
  if [ -d "$verify_data" ]; then
    echo ">> 复用已存在的副本数据目录 ${verify_data}"
  else
    echo ">> 拷贝一份数据目录（副本专用，避免污染生产）"
    mkdir -p "$verify_data"
    if [ -d "$src_data" ]; then
      cp -a "$src_data/." "$verify_data/" || echo "   !! 数据目录拷贝未完整成功，副本可能缺少账号配置" >&2
    fi
    $SUDO chown -R 1000:1000 "$verify_data" || echo "   !! chown 副本数据目录失败（容器内 uid 1000 可能写不了 /data）" >&2
  fi

  net_arg=''
  if $SUDO "$DOCKER" network inspect personal >/dev/null 2>&1; then net_arg="--network personal"; fi

  echo ">> 启动只读副本容器 ${name}（镜像 ${image}，127.0.0.1:${VERIFY_PORT}）"
  if ! $SUDO "$DOCKER" rm -f "$name" >/dev/null; then
    echo "   !! 旧副本容器 ${name} 未删除成功（可能仍在运行，端口 ${VERIFY_PORT} 会冲突）" >&2
  fi
  # shellcheck disable=SC2086
  $SUDO "$DOCKER" run -d --name "$name" $net_arg \
    -p "127.0.0.1:${VERIFY_PORT}:8082" \
    -v "${verify_data}:/data" \
    "$image" >/dev/null

  ok=0
  body=''
  elapsed=0
  while [ "$elapsed" -lt 90 ]; do
    # 同样不用 -f：503 的响应体里才有 checks，判断看 body 里的 status 字段。
    if body=$(curl -sS --max-time 3 "http://127.0.0.1:${VERIFY_PORT}/health" 2>/dev/null) && [ -n "$body" ]; then
      ok=1
      break
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  if [ "$ok" = 1 ]; then
    echo ">> /health: $(printf '%s' "$body" | cut -c1-600)"
    # 取 status 用纯 shell 解析：镜像里没有 python3，脚本也要能在容器内跑。
    code=$(json_scalar "$body" status)
    if [ -n "$code" ] && [ "$code" != running ]; then
      echo "!! 副本自检 status=${code}，判定不通过" >&2
      ok=0
    fi
  fi

  if [ "$ok" != 1 ]; then
    echo "!! 副本未通过自检，最近日志：" >&2
    $SUDO "$DOCKER" logs --tail 60 "$name" >&2 || true
  fi

  echo ">> 清理副本容器与数据目录"
  # 群晖上 docker rm 偶发不返回：后台执行后轮询确认（最多 20s）。
  nohup $SUDO "$DOCKER" rm -f "$name" >/dev/null 2>&1 &
  waited=0
  while [ "$waited" -lt 20 ]; do
    if ! $SUDO "$DOCKER" container inspect "$name" >/dev/null 2>&1; then break; fi
    sleep 2
    waited=$((waited + 2))
  done
  rm -rf "$verify_data"

  if [ "$ok" != 1 ]; then exit 1; fi
  echo ">> 副本自检通过"
}

do_rebuild() {
  tag="${1:-}"
  if [ -z "$tag" ]; then
    tag="${IMAGE%:*}:local-$(date +%Y%m%d%H%M%S)"
  fi
  echo ">> 用 Dockerfile 构建 ${tag}"
  $SUDO "$DOCKER" build -t "$tag" . || { echo "!! 构建失败" >&2; exit 1; }
  # 体积读不到就是 0，摘要里显示 0MB 比整段失败有用。
  bytes=$($SUDO "$DOCKER" image inspect "$tag" --format '{{.Size}}' 2>/dev/null || echo 0)
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  echo ">> 镜像体积: $((bytes / 1024 / 1024))MB（${bytes} bytes）"
  do_verify_copy "$tag"

}

case "${1:-upgrade}" in
  pull)    do_pull ;;
  wait)    do_wait "$(container_image)" ;;
  upgrade|up|"")
    do_upgrade
    echo
    echo "访问地址: http://<主机IP>:${PORT}"
    ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs "${2:-100}" ;;
  port)    do_port "${2:-}" ;;
  build)   do_build "${2:-}" ;;
  rebuild)
    do_rebuild "${2:-}"
    echo
    echo "如需用新镜像替换生产容器: ./deploy.sh restart"
    ;;
  verify)  do_verify_copy "${2:-}" ;;
  help|-h|--help)
    sed -n '2,34p' "$SELF" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "ERROR: 未知命令 ${1}" >&2
    echo >&2
    sed -n '2,34p' "$SELF" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
