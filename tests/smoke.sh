#!/usr/bin/env bash
#
# Smoke test for the chat2api container.
#
#   IMAGE=ghcr.nju.edu.cn/liangnianzhi/chat2api:latest ./tests/smoke.sh
#
# Two modes:
#   default        start a throwaway container (CI does this)
#   VERIFY_URL=..  test an already-running deployment over HTTP, no docker needed

set -uo pipefail

IMAGE="${IMAGE:-ghcr.nju.edu.cn/liangnianzhi/chat2api:latest}"
CONTAINER="${CONTAINER:-chat2api-smoke}"
PORT="${PORT:-18082}"
SIZE_BUDGET_MB="${SIZE_BUDGET_MB:-300}"
VERIFY_URL="${VERIFY_URL:-}"
WORKDIR="$(mktemp -d)"

FAILED=0
FAILURES=""
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$*"
  FAILED=1
  [ -n "$FAILURES" ] && FAILURES="$FAILURES"$'\n'
  FAILURES="${FAILURES}  - $*"
  # 同时写进墓碑：CI 端拿不到 job log，能看到的只有这个文件。
  # 这里保留中文——注解不受 locale 影响，被 tr 吃掉的只是回显那一步。
  note "FAIL $*"
}
PHASE_NO=0
info() {
  PHASE_NO=$((PHASE_NO + 1))
  printf '\n\033[1m== %s\033[0m\n' "$*"
  note "PHASE $PHASE_NO"
}

cleanup() {
  if [ -z "$VERIFY_URL" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo rm -rf "$WORKDIR" 2>/dev/null || rm -rf "$WORKDIR" 2>/dev/null || true
  else
    rm -rf "$WORKDIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

BASE="http://127.0.0.1:${PORT}"

start_container() {
  mark start_container
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # 套件测的是「凭据模型本身」：把门 pin 成开，下面四十多条 401/403/415 断言才有意义。
  # 发布默认是关的（内网免登录），那一条由末尾的「局域网默认」阶段单独验证。
  #
  # 注释只能写在命令**前面**：\ 续行会把下一行接成同一行，那一行上的 # 会把
  # 后面所有参数一起吞掉——上一次就是这么把 -p/-v/-e/镜像全吞了，docker run 连
  # 容器都没建，墓碑只留下 'No such container'。
  local rc=0
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8082" \
    -v "$WORKDIR/data:/data" \
    -e "CHAT2API_REQUIRE_AUTH=${SMOKE_GATE:-1}" \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    "$IMAGE" >"$WORKDIR/run.log" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    # docker run 自己失败时，stderr 才是原因，而且它不会进 job log（匿名看不到）。
    note "docker run failed rc=$rc"
    tr -d '\r' <"$WORKDIR/run.log" 2>/dev/null | while IFS= read -r ln; do
      note "run: $ln"
    done
  fi
  mark start_container_done
}

wait_ready() {
  mark wait_ready
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  # 没就绪时必须留下现场：容器是没起来、起来就崩了、还是起来了但 /health 不答，
  # 三者的修法完全不同，而 stdout 在 CI 上读不到（匿名看不到 job log）。
  note "wait_ready TIMEOUT"
  note "state: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$CONTAINER" 2>/dev/null || echo 'no container')"
  docker logs --tail 30 "$CONTAINER" 2>&1 | tr -d '\r' | while IFS= read -r ln; do
    note "log: $ln"
  done
  return 1
}

# 进度落到文件，而不是只靠 stdout：卡住被外面 kill 掉时，缓冲里的输出会一起消失。
# CI 每一步都会把 $C2A_SMOKE_PROGRESS 的内容回显出来，所以这里是唯一可靠的墓碑。
PROGRESS_FILE="${C2A_SMOKE_PROGRESS:-}"
# 只要 ASCII：runner 的 C locale 下 `tr -cd '[:print:]'`（CI 里回显时用的）
# 会把中文整段删掉，上一轮墓碑就只剩 "== |== |== |"，等于没写。
note() {
  [ -n "$PROGRESS_FILE" ] || return 0
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$PROGRESS_FILE" 2>/dev/null
  return 0
}

# 每个可能阻塞的动作都留一对 marks：开始/结束。卡住时，最后一条 marks 就是
# 出事的地方，不需要再猜。
mark() { note "MARK $*"; }

# 任何一条 curl 都必须有上限：没有 --max-time 时，服务端一个挂住的 handler 就能
# 把整套 smoke 拖到墙钟上限。包一层，比在六十个调用点上逐个补参数可靠。
curl() { command curl --max-time 20 --connect-timeout 5 "$@"; }

# 同理包住 docker：客户端卡在不可中断等待里时 timeout 也未必杀得掉，但至少每条
# docker 命令都有上限，不会无声无息地占着整步。
docker() { command timeout -k 5 60 docker "$@"; }

# 心跳：如果墓碑停在某个 MARK 之后、却仍有 HEARTBEAT 持续出现，说明 shell 活着，
# 卡住的是那条子命令；如果连心跳也停了，说明整个进程被挂死或被杀了。
if [ -n "$PROGRESS_FILE" ]; then
  ( while :; do sleep 30; note "HEARTBEAT"; done ) &
  HEARTBEAT_PID=$!
fi

# docker exec 会一直等会话结束：容器没起来时它不是报错，而是永久阻塞。
# 之前整步 20 分钟被杀，就是死在这一句上，而且什么也没打印。
# 这里要防的是「子进程把父 shell 的 stdout 攥住」：docker exec 的会话若挂住，
# 命令替换就永远等不到 EOF，外层 timeout 再怎么管也管不到这一步（#182 卡了 20
# 分钟，墓碑停在 secret-read 就是它）。所以：
#   * 显式 </dev/null —— 谁都别去抢 stdin；
#   * 输出先落文件，再读文件 —— 命令替换只连着一个真正的文件，不连着 docker。
# 退出码照旧返回，调用方那套 `|| echo` 也不受影响。
in_container() {
  # 只记调用形状，不记内容：凭据类命令会把 secret 写进参数里。
  case "$1" in
    *management-secret*) mark "in_container: <secret-read>" ;;
    *) mark "in_container: $(printf '%s' "$1" | cut -c1-40 | tr -cd '[:alnum:] :/._-')" ;;
  esac
  EXEC_OUT="$(mktemp)"
  mark "IC mktemp ok"
  # 每一步都留痕：卡住时最后一条 mark 就是答案，不用再靠推理。
  # -k 5：SIGTERM 不理就 5 秒后 SIGKILL。
  timeout -k 5 20 docker exec "$CONTAINER" sh -c "$1" </dev/null >"$EXEC_OUT" 2>&1
  ec=$?
  mark "IC exec ec=$ec"
  if [ "$ec" = 124 ]; then
    mark "in_container TIMEOUT"
  fi
  cat "$EXEC_OUT"
  rm -f "$EXEC_OUT"
  return "$ec"
}

# --- access control -------------------------------------------------------
# Nothing but /health and the login page answers without a credential, so every
# call below carries one. API clients (curl, SDKs) present the management
# secret as a Bearer token; a browser trades the login page for a session
# cookie, and its state is kept in a jar.
SECRET_FILE="/data/.chat2api/.management-secret"
# 同一份文件在宿主机上的路径（容器把 $WORKDIR/data 挂到 /data）。
HOST_SECRET="$WORKDIR/data/.chat2api/.management-secret"
SECRET="${CHAT2API_MANAGEMENT_SECRET:-}"
COOKIE_JAR="$WORKDIR/cookies.txt"
: > "$COOKIE_JAR"
AUTH=()
JSON='Content-Type: application/json'

# 密钥文件在宿主机上也有一份（容器把 $WORKDIR/data 挂到 /data）。以 root 读它，
# 就完全不需要 docker exec —— #182/#183/#185 都是死在 exec 上。
read_host_secret() {
  [ -n "${HOST_SECRET:-}" ] || return 0
  if [ -r "$HOST_SECRET" ]; then
    tr -d '\r\n' < "$HOST_SECRET"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n cat "$HOST_SECRET" 2>/dev/null | tr -d '\r\n'
  fi
}

load_secret() {
  [ -n "$SECRET" ] && return 0
  if [ -n "$VERIFY_URL" ]; then
    if [ -r "$SECRET_FILE" ]; then
      SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
    fi
  else
    # 容器把 $WORKDIR/data 挂到 /data，所以密钥在宿主机上就是一份普通文件。
    # 先读它：不走 docker exec，这条路根本不会被 exec 会话挂住（#182/#183 就是
    # 死在 exec 上，20 分钟一动不动）。读不到才回退到 exec。
    mark "secret: host read"
    SECRET="$(read_host_secret)"
    if [ -z "$SECRET" ]; then
      mark "secret: exec fallback"
      SECRET="$(in_container "cat $SECRET_FILE" 2>/dev/null | tr -d '\r\n')"
    fi
  fi
  [ -n "$SECRET" ] && AUTH=(-H "Authorization: Bearer $SECRET")
  [ -n "$SECRET" ]
}

# A browser session: visiting the login page is what hands out the cookie.
open_session() {
  curl -s -c "$COOKIE_JAR" -o /dev/null "${BASE}/__login" 2>/dev/null || true
  grep -q 'c2a_session' "$COOKIE_JAR" 2>/dev/null
}

# code_of <curl ...> -> HTTP status only
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

# 失败时要把上下文打出来：只看一个 HTTP 码，看不出是网关没装好还是断言写错了。
# 响应体截到 200 字符，够看出错误类型，又不至于把整页 HTML 倒进 CI 日志。
clip() { printf '%s' "$1" | tr -d '\r' | head -c 200; }

if [ -n "$VERIFY_URL" ]; then
  info "验证已部署的实例：$VERIFY_URL"
  BASE="${VERIFY_URL%/}"
else
  info "准备：宿主目录属主故意设错，验证容器能自愈"
  mkdir -p "$WORKDIR/data"
  chown "$(id -u):$(id -g)" "$WORKDIR/data" 2>/dev/null || true
  start_container
fi

info "启动与健康检查"
if wait_ready; then
  pass "服务在 180s 内就绪"
else
  fail "服务未就绪"
  if [ -z "$VERIFY_URL" ]; then
    echo "---- 容器日志 ----"
    docker logs --tail 100 "$CONTAINER" 2>&1 | sed 's/^/      /'
  fi
  echo
  printf '\n\033[31m❌ SMOKE TEST FAILED（服务未就绪，提前退出）\033[0m\n'
  printf '失败项：\n%s\n' "$FAILURES"
  exit 1
fi

info "访问控制：默认拒绝，凭据分两类"
if load_secret; then
  pass "取得管理密钥（Bearer 凭据）"
else
  fail "拿不到管理密钥，后续需要凭据的断言都会失败"
fi

# 未鉴权必须被拒；这在改造前是敞开的（/__ipc 等于完整桌面 IPC）。
for probe in / /__preload.js /__ipc/events /management/accounts /stats /v1/models; do
  PC="$(code_of "${BASE}${probe}")"
  [ "$PC" = 401 ] && pass "无凭据 GET ${probe} -> 401" || fail "无凭据 GET ${probe} -> HTTP $PC（应为 401）"
done
PC="$(code_of -X POST "${BASE}/__ipc" -H "$JSON" -d '{"channel":"proxy:getStatus","args":[]}')"
[ "$PC" = 401 ] && pass "无凭据 POST /__ipc -> 401" || fail "无凭据 POST /__ipc -> HTTP $PC（应为 401）"

# 跨站：CORS 简单请求能绕过预检，但绕不过 Origin 校验。
for origin in "http://evil.example" "http://127.0.0.1:3000" "null"; do
  PC="$(code_of -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" -H "Origin: $origin" \
    -d '{"channel":"proxy:getStatus","args":[]}')"
  [ "$PC" = 403 ] && pass "跨站 Origin（$origin）-> 403" || fail "跨站 Origin（$origin）-> HTTP $PC（应为 403）"
done

# OpenAI 命名空间：机器客户端永远拿 JSON，不拿登录页（SDK 解析 HTML 会直接抛错）。
# 无凭据与错 key 两种分支都要覆盖 —— 后者是真实部署里最常见的那种。
for vprobe in "/v1/models" "/v1/models?stream=true"; do
  VC="$(code_of "${BASE}${vprobe}")"
  VT="$(curl -s -o /dev/null -w '%{content_type}' "${BASE}${vprobe}" 2>/dev/null || echo '')"
  [ "$VC" = 401 ] && pass "无凭据 GET ${vprobe} -> 401" || fail "无凭据 GET ${vprobe} -> HTTP $VC（应为 401）"
  case "$VT" in
    application/json*) pass "无凭据 GET ${vprobe} 返回 JSON（$VT）" ;;
    *) fail "无凭据 GET ${vprobe} 的 Content-Type 是 '$VT'（应为 application/json，不能是登录页）" ;;
  esac
done
for vprobe in "/v1/chat/completions" "/v1/embeddings" "/v1/completions"; do
  VC="$(code_of -X POST "${BASE}${vprobe}" -H "$JSON" -d '{"model":"deepseek-v4-flash","input":"ping"}')"
  VB="$(curl -s -X POST "${BASE}${vprobe}" -H "$JSON" -d '{"model":"deepseek-v4-flash","input":"ping"}' 2>/dev/null || echo '')"
  [ "$VC" = 401 ] && pass "无凭据 POST ${vprobe} -> 401" || fail "无凭据 POST ${vprobe} -> HTTP $VC（应为 401）"
  case "$VB" in
    *"<html"*|*"<HTML"*) fail "无凭据 POST ${vprobe} 返回了 HTML 登录页" ;;
    *invalid_api_key*) pass "无凭据 POST ${vprobe} 返回 OpenAI 错误体" ;;
    *'"error"'*) pass "无凭据 POST ${vprobe} 返回 JSON 错误" ;;
    *) fail "无凭据 POST ${vprobe} 响应异常: $(printf '%s' "$VB" | cut -c1-120)" ;;
  esac
done

# 错 key（有凭据但不是管理密钥）也必须是 JSON 401：这是真实部署里最常见的那一种。
WRONG_KEY='Bearer sk-wrong-not-the-management-secret'
for vprobe in "/v1/models" "/v1/models?stream=true"; do
  VC="$(code_of "${BASE}${vprobe}" -H "Authorization: $WRONG_KEY")"
  VT="$(curl -s -o /dev/null -w '%{content_type}' "${BASE}${vprobe}" -H "Authorization: $WRONG_KEY" 2>/dev/null || echo '')"
  [ "$VC" = 401 ] && pass "错 key GET ${vprobe} -> 401" || fail "错 key GET ${vprobe} -> HTTP $VC（应为 401）"
  case "$VT" in
    application/json*) pass "错 key GET ${vprobe} 返回 JSON（$VT）" ;;
    *) fail "错 key GET ${vprobe} 的 Content-Type 是 '$VT'（应为 application/json，不能是登录页）" ;;
  esac
done
# 错 key 不能把地址锁死：连打 5 次仍是 401，否则一次 key 轮换就会变成 429 风暴。
for _ in 1 2 3 4 5; do code_of "${BASE}/v1/models" -H "Authorization: $WRONG_KEY" >/dev/null; done
VC="$(code_of "${BASE}/v1/models" -H "Authorization: $WRONG_KEY")"
[ "$VC" = 401 ] && pass "连续错 key 后仍是 401（未锁定客户端地址）" || fail "连续错 key 后 -> HTTP $VC（应为 401）"

# 表单类型意味着请求可以不经预检由任意网页发起，直接拒绝。
for ctype in "application/x-www-form-urlencoded" "text/plain" "multipart/form-data; boundary=x"; do
  PC="$(code_of -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "Content-Type: $ctype" --data-binary '{} --x--')"
  [ "$PC" = 415 ] && pass "Content-Type ${ctype%%;*} -> 415" || fail "Content-Type ${ctype%%;*} -> HTTP $PC（应为 415）"
done

info "代理确实在运行，且上报的是公开端口"
HEALTH_JSON="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
PROXY_STATE="$(grep -oE '"status":"[a-z]+"' <<<"$HEALTH_JSON" | head -1 | cut -d'"' -f4)"
[ "$PROXY_STATE" = "running" ] \
  && pass "上游代理状态为 running" \
  || fail "上游代理状态为 '${PROXY_STATE:-无}'（应为 running）: $HEALTH_JSON"

STATUS_JSON="$(curl -sS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
  -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || echo '')"
ADVERTISED_PORT="$(grep -oE '"port":[0-9]+' <<<"$STATUS_JSON" | head -1 | grep -oE '[0-9]+')"
[ "$ADVERTISED_PORT" = "8082" ] \
  && pass "界面报告的端口是公开端口（8082）" \
  || fail "界面报告的端口是 '${ADVERTISED_PORT:-无}'，应为 8082"

info "OpenAI 兼容 API"
MODELS="$(curl -fsS "${BASE}/v1/models" "${AUTH[@]}" || echo '')"
grep -q '"object":"list"' <<<"$MODELS" \
  && pass "/v1/models 返回 OpenAI 格式" || fail "/v1/models 异常: $MODELS"

CHAT_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/chat/completions" \
  "${AUTH[@]}" -H "$JSON" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' 2>/dev/null)"
case "$CHAT_CODE" in
  200) pass "/v1/chat/completions 可用（200）" ;;
  401|429|503) pass "/v1/chat/completions 端点存在（$CHAT_CODE，无账号或需密钥属正常）" ;;
  *) fail "/v1/chat/completions 返回 $CHAT_CODE" ;;
esac

info "管理 API：/management 与 /v0/management 等价"
MGMT_ALIAS="$(curl -s -w '\n%{http_code}' "${AUTH[@]}" "${BASE}/management/accounts" || echo '')"
MGMT_UPSTREAM="$(curl -s -w '\n%{http_code}' "${AUTH[@]}" "${BASE}/v0/management/accounts" || echo '')"
ALIAS_CODE="$(tail -1 <<<"$MGMT_ALIAS")"
UPSTREAM_CODE="$(tail -1 <<<"$MGMT_UPSTREAM")"
[ "$ALIAS_CODE" = 200 ] \
  && pass "/management/accounts -> 200" || fail "/management/accounts -> HTTP $ALIAS_CODE"
[ "$ALIAS_CODE" = "$UPSTREAM_CODE" ] \
  && pass "两个前缀状态码一致（$ALIAS_CODE）" \
  || fail "前缀行为不一致: /management=$ALIAS_CODE /v0/management=$UPSTREAM_CODE"

info "上游原版界面"
# 界面属于「浏览器」一类：先向登录页登记一个会话，再带着它的 cookie 取页面。
open_session && pass "登录页下发会话 cookie" || fail "登录页未下发会话 cookie"
INDEX="$(curl -fsS -b "$COOKIE_JAR" "${BASE}/" || echo ''))"
NOAUTH_INDEX="$(code_of "${BASE}/")"
[ "$NOAUTH_INDEX" = 401 ] && pass "无会话时 / -> 401（不再对任意网络开放）" \
  || fail "无会话时 / -> HTTP $NOAUTH_INDEX（应为 401）"
BEARER_INDEX="$(code_of "${AUTH[@]}" "${BASE}/")"
[ "$BEARER_INDEX" = 401 ] && pass "API 令牌不能打开界面（/ -> 401）" \
  || fail "API 令牌打开界面返回 HTTP $BEARER_INDEX（应为 401）"
grep -q '/__preload.js' <<<"$INDEX" \
  && pass "页面已注入 preload 桥" || fail "页面缺少 /__preload.js"
grep -qi '<div id="root"\|<div id="app"' <<<"$INDEX" \
  && pass "根节点为 SPA 挂载点（上游界面）" || fail "页面结构不像上游前端"

ASSET="$(grep -oE '(src|href)="[^"]*/assets/[^"]+"' <<<"$INDEX" | head -1 | sed 's/.*="//;s/"$//')"
ASSET="${ASSET#./}"
case "$ASSET" in /*) ;; *) ASSET="/$ASSET" ;; esac
if [ -n "$ASSET" ]; then
  AC="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" "${BASE}${ASSET}")"
  [ "$AC" = 200 ] \
    && pass "前端静态资源可访问（$ASSET）" \
    || fail "静态资源 $ASSET -> HTTP $AC"
else
  fail "页面未引用任何 /assets/ 资源"
fi

info "登录页（网页登录的替代路径）"
LOGIN_HTML="$(curl -fsS "${BASE}/__login?provider=deepseek&providerId=deepseek" || echo '')"
# 按英文标识断言，不依赖会被 JSON 转义的中文文案。
grep -q 'userToken' <<<"$LOGIN_HTML" \
  && pass "/__login 返回带提供商指引的页面" \
  || fail "/__login 内容异常（缺少该提供商的取值指引）"
grep -q '/__login/finish' <<<"$LOGIN_HTML" \
  && pass "登录页会把凭证提交到 /__login/finish" \
  || fail "登录页缺少提交目标"

# 提交登录必须带上会话和 CSRF 令牌：会话 cookie 是 SameSite=Strict 的，
# 跨站表单既带不上 cookie，也猜不出这里的值。
CSRF="$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "${BASE}/__login" \
  | tr -d '\r\n' | sed -n 's/.*name="c2a-csrf-token" content="\([a-f0-9]*\)".*/\1/p' | head -1)"
[ -n "$CSRF" ] && pass "登录页给出 CSRF 令牌" || fail "登录页没有 CSRF 令牌"

NOAUTH_FINISH="$(code_of -X POST "${BASE}/__login/finish" -H "$JSON" -d '{}')"
[ "$NOAUTH_FINISH" = 401 ] && pass "无会话时 /__login/finish -> 401" \
  || fail "无会话时 /__login/finish -> HTTP $NOAUTH_FINISH（应为 401）"

NOCSRF_FINISH="$(code_of -X POST "${BASE}/__login/finish" -b "$COOKIE_JAR" -H "$JSON" -d '{}')"
[ "$NOCSRF_FINISH" = 403 ] && pass "缺 CSRF 令牌 -> 403" \
  || fail "缺 CSRF 令牌 -> HTTP $NOCSRF_FINISH（应为 403）"

# 缺参数必须拒。
BAD_FINISH="$(curl -s -X POST "${BASE}/__login/finish" -b "$COOKIE_JAR" -H "$JSON" \
  -H "X-C2A-CSRF: $CSRF" -d '{}' 2>/dev/null || echo '')"
grep -q '"ok":false' <<<"$BAD_FINISH" \
  && pass "缺参数提交被拒绝" || fail "缺参数提交未被拒绝: $BAD_FINISH"

# 无效凭证必须被上游验证拦下，而不是先存下再说。
INVALID_FINISH="$(curl -s -X POST "${BASE}/__login/finish" -b "$COOKIE_JAR" -H "$JSON" \
  -H "X-C2A-CSRF: $CSRF" \
  -d '{"providerId":"deepseek","providerType":"deepseek","credentials":{"token":"obviously-invalid-token-0001"}}' \
  2>/dev/null || echo '')"
if grep -q '"ok":false' <<<"$INVALID_FINISH"; then
  pass "无效凭证被拒绝（未写入账号）"
else
  fail "无效凭证未被拒绝: $INVALID_FINISH"
fi

if [ -z "$VERIFY_URL" ]; then
  info "网页登录不再报错，而是引导到登录页"
  # 容器里开不了 Electron 窗口；必须给出引导，而不是报窗口错误。
  IAL="$(curl -sS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
    -d '{"channel":"oauth:startInAppLogin","args":[{"providerId":"deepseek","providerType":"deepseek"}]}' \
    2>/dev/null || echo '')"
  # 断言机器可读标记，不匹配中文文案。
  if grep -q 'login_page_opened' <<<"$IAL"; then
    pass "startInAppLogin 返回引导（login_page_opened）"
  else
    fail "startInAppLogin 未返回引导: $IAL"
  fi
  grep -q '/__login' <<<"$IAL" \
    && pass "引导中包含登录页地址" \
    || fail "引导中没有登录页地址: $IAL"
  grep -qi 'BrowserWindow\|ENOTSUP' <<<"$IAL" \
    && fail "startInAppLogin 仍在报 GUI 不可用错误" \
    || pass "startInAppLogin 不再报 GUI 错误"

  info "只有一个对外端口，且 API 在进程内处理"
  LOGS="$(docker logs "$CONTAINER" 2>&1 || true)"
  grep -q 'electron shim active' <<<"$LOGS" \
    && pass "electron shim 已生效" || fail "未看到 'electron shim active'"

  PORTS="$(docker port "$CONTAINER" 2>/dev/null | awk '{print $3}' | sed 's/.*://' | sort -u | tr '\n' ' ')"
  PORT_COUNT="$(echo "$PORTS" | wc -w | tr -d ' ')"
  if [ "$PORT_COUNT" = "1" ] && [ "$(echo "$PORTS" | tr -d ' ')" = "${PORT}" ]; then
    pass "宿主机只有 1 个发布端口（$PORTS）"
  else
    fail "发布端口异常: $PORTS"
  fi

  grep -q 'captured the HTTP request handler' <<<"$LOGS" \
    && pass "已捕获上游 HTTP 请求处理器" || fail "未捕获处理器"
  grep -q 'API: served in-process, no second port' <<<"$LOGS" \
    && pass "API 由同一端口进程内处理" || fail "API 未走进程内处理"

  if in_container 'netstat -tln 2>/dev/null || ss -tln 2>/dev/null' | grep -q ':18090 '; then
    fail "容器内仍有 18090 在监听"
  else
    pass "容器内没有 18090 监听"
  fi

  if docker run --rm --entrypoint sh "$IMAGE" \
       -c 'command -v Xvfb || command -v chromium || command -v electron' 2>/dev/null | grep -q .; then
    fail "镜像里存在 Xvfb/Chromium/electron 可执行文件"
  else
    pass "镜像内无 Xvfb / Chromium / electron 可执行文件"
  fi

  info "时区默认为 Asia/Shanghai"
  TZ_ENV="$(in_container 'printf %s "$TZ"' | tr -d '\r\n')"
  [ "$TZ_ENV" = "Asia/Shanghai" ] && pass "TZ=$TZ_ENV" || fail "TZ=$TZ_ENV，预期 Asia/Shanghai"
  TZ_FILE="$(in_container 'readlink /etc/localtime' | tr -d '\r\n')"
  [[ "$TZ_FILE" == *"Shanghai"* ]] && pass "/etc/localtime -> $TZ_FILE" || fail "/etc/localtime 未指向上海"
  TZ_OFFSET="$(in_container 'date +%z' | tr -d '\r\n')"
  [ "$TZ_OFFSET" = "+0800" ] && pass "date +%z = $TZ_OFFSET" || fail "时区偏移 $TZ_OFFSET，预期 +0800"

  info "主进程已降权"
  SECRET_FILE="/data/.chat2api/.management-secret"
  RUNTIME_OWNER="$(stat -c '%u' "$HOST_SECRET" 2>/dev/null | tr -d '\r\n')"
  [ "$RUNTIME_OWNER" = "1000" ] \
    && pass "运行时文件属主为 1000" || fail "运行时文件属主为 $RUNTIME_OWNER，预期 1000"

  info "上游 wasm 依赖（DeepSeek/GLM 签名）"
  WASM_OUT="$(timeout -k 5 30 docker exec "$CONTAINER" node -e '
require("/app/shim/electron-shim.js");
const fs = require("fs"), path = require("path");
const p = process.resourcesPath;
if (typeof p !== "string") { console.error("resourcesPath is not a string: " + p); process.exit(1) }
const f = path.join(p, "sha3_wasm_bg.7b9ca65ddd.wasm");
if (!fs.existsSync(f)) { console.error("wasm missing at " + f); process.exit(1) }
console.log("ok");
' 2>&1)"
  grep -q '^ok$' <<<"$WASM_OUT" && pass "process.resourcesPath 可用且能定位 wasm" || fail "wasm 路径解析失败：$WASM_OUT"

  info "IPC 桥"
  PRELOAD="$(curl -fsS -b "$COOKIE_JAR" "${BASE}/__preload.js" || echo '')"
  PRELOAD_NOAUTH="$(code_of "${BASE}/__preload.js")"
  [ "$PRELOAD_NOAUTH" = 401 ] && pass "无会话时 /__preload.js -> 401（IPC 桥不再对外开放）" \
    || fail "无会话时 /__preload.js -> HTTP $PRELOAD_NOAUTH（应为 401）"
  grep -q 'contextBridge' <<<"$PRELOAD" && pass "preload 桥已就绪" || fail "preload 内容异常"
  grep -q '__c2a_require' <<<"$PRELOAD" && pass "preload 桥含 require 垫片" || fail "preload 缺少垫片"
  grep -q 'armPlaceholder' <<<"$PRELOAD" && pass "preload 桥含弹窗预开逻辑" || fail "preload 缺少弹窗处理"

  CODE_IPC="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/__ipc" \
    "${AUTH[@]}" -H "$JSON" -d '{"channel":"__no_such_channel__","args":[]}')"
  [ "$CODE_IPC" = 404 ] && pass "IPC 端点已就绪（未知 channel -> 404）" || fail "IPC 端点异常: HTTP $CODE_IPC"

  IPC_ACC="$(curl -fsS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
    -d '{"channel":"accounts:getAll","args":[false]}' || echo '')"
  grep -q '"ok":true' <<<"$IPC_ACC" && pass "IPC 桥能派发真实 channel" || fail "IPC 桥派发失败: $IPC_ACC"

  info "浏览器打开"
  SSE_FILE="$WORKDIR/sse.txt"
  : > "$SSE_FILE"
  ( curl -sS --max-time 15 -N "${AUTH[@]}" "${BASE}/__ipc/events" > "$SSE_FILE" 2>/dev/null & )
  sleep 2
  curl -fsS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
    -d '{"channel":"app:openExternal","args":["https://chat.deepseek.com"]}' >/dev/null 2>&1 || true
  sleep 3
  if grep -q 'chat.deepseek.com' "$SSE_FILE" 2>/dev/null; then
    pass "openExternal 事件会送达界面"
  else
    fail "openExternal 事件未到达事件流"
  fi

  info "生成的密钥"
  ON_DISK="$(read_host_secret)"
  [ -n "$ON_DISK" ] && pass "密钥已生成" || fail "未找到生成的密钥文件"
  [ "$ON_DISK" = "$SECRET" ] && pass "容器内的密钥就是我们用来鉴权的那一个" \
    || fail "容器密钥与用于鉴权的值不一致（请用 SECRET 显式指定）"
  MODE="$(stat -c '%a' "$HOST_SECRET" 2>/dev/null | tr -d '\r\n')"
  [ "$MODE" = 600 ] && pass "密钥文件权限为 600" || fail "密钥文件权限为 $MODE，预期 600"

  info "账号写入与读取"
  CREATE="$(curl -fsS -X POST "${BASE}/management/accounts" "${AUTH[@]}" \
    -H "$JSON" \
    -d '{"providerId":"deepseek","name":"smoke-account","credentials":{"token":"smoke-token-value"}}' || echo '')"
  grep -q '"success":true' <<<"$CREATE" && pass "添加账号成功" || fail "添加账号失败: $CREATE"

  LIST="$(curl -fsS "${AUTH[@]}" "${BASE}/management/accounts" || echo '')"
  grep -q 'smoke-account' <<<"$LIST" && pass "账号出现在列表中" || fail "列表中未找到新账号"
  grep -q 'smoke-token-value' <<<"$LIST" && fail "列表泄露了明文凭证" || pass "列表未泄露明文凭证"

  info "客户端 API 密钥"
  KEYRESP="$(curl -fsS -X POST "${BASE}/management/api-keys" "${AUTH[@]}" \
    -H "$JSON" -d '{"name":"smoke-client"}' || echo '')"
  grep -q 'sk-mgmt-' <<<"$KEYRESP" && pass "生成客户端 API 密钥" || fail "生成密钥失败: $KEYRESP"

  info "凭证加密（AES-256-GCM）"
  CRYPTO_OUT="$(timeout -k 5 30 docker exec "$CONTAINER" node -e '
const s = require("/app/shim/electron-shim.js");
const secret = "roundtrip-probe-value";
if (s.safeStorage.isEncryptionAvailable() !== true) { console.error("not available"); process.exit(1) }
const enc = s.safeStorage.encryptString(secret);
if (s.safeStorage.decryptString(enc) !== secret) { console.error("roundtrip failed"); process.exit(1) }
if (enc.toString("utf8").includes(secret)) { console.error("ciphertext contains plaintext"); process.exit(1) }
try {
  s.safeStorage.decryptString(Buffer.from(enc.toString("utf8").replace(/^v1:/, "v1:x")));
  console.error("tamper not detected"); process.exit(1);
} catch {}
console.log("ok");
' 2>&1)"
  grep -q '^ok$' <<<"$CRYPTO_OUT" && pass "加解密往返、无明文泄露、篡改可检测" || fail "凭证加密自检失败：$CRYPTO_OUT"

  timeout -k 5 20 docker exec "$CONTAINER" test -f /data/.chat2api/.safe-storage-key \
    && pass "加密密钥持久化在数据卷" || fail "加密密钥未落在数据卷"

  DATAJSON_OUT="$(timeout -k 5 30 docker exec "$CONTAINER" node -e '
const fs = require("fs");
try { JSON.parse(fs.readFileSync("/data/.chat2api/data.json", "utf8")); process.exit(1) }
catch { process.exit(0) }
' 2>&1)"
  [ -z "$DATAJSON_OUT" ] && pass "data.json 为密文" || fail "data.json 可直接解析为 JSON（应为密文）"

  info "重启后持久化"
  docker restart "$CONTAINER" >/dev/null
  if wait_ready; then pass "重启后服务就绪"; else fail "重启后服务未就绪"; fi

  load_secret || true
  AFTER="$(curl -fsS "${AUTH[@]}" "${BASE}/management/accounts" || echo '')"
  grep -q 'smoke-account' <<<"$AFTER" && pass "重启后账号仍在" || fail "重启后账号丢失"

  [ -n "$SECRET" ] && pass "重启后管理密钥不变（同一 Bearer 仍然可用）" || fail "重启后管理密钥丢失"
  RESTART_OWN="$(read_host_secret)"
  [ -n "$RESTART_OWN" ] && pass "重启后密钥文件仍在数据卷" || fail "重启后密钥文件丢失"

  RESTART_HEALTH="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
  RESTART_STATE="$(grep -oE '"status":"[a-z]+"' <<<"$RESTART_HEALTH" | head -1 | cut -d'"' -f4)"
  [ "$RESTART_STATE" = "running" ] \
    && pass "重启后代理状态仍为 running" || fail "重启后代理状态为 '${RESTART_STATE:-无}'"

  RESTART_STATUS="$(curl -sS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
    -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || echo '')"
  RESTART_PORT="$(grep -oE '"port":[0-9]+' <<<"$RESTART_STATUS" | head -1 | grep -oE '[0-9]+')"
  [ "$RESTART_PORT" = "8082" ] \
    && pass "重启后上报端口仍为 8082" || fail "重启后上报端口为 '${RESTART_PORT:-无}'"

  info "审计与限流状态可从 /health 读到（不必进容器翻日志）"
  # 先制造一次审计记录（错误的 Bearer），再读摘要。
  curl -s -o /dev/null -X POST "${BASE}/__ipc" -H "Authorization: Bearer wrong-value" \
    -H "$JSON" -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || true
  DIGEST="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
  grep -q '"required":true' <<<"$DIGEST" \
    && pass "/health 上报鉴权已启用" || fail "/health 未上报鉴权状态: $DIGEST"
  grep -q '\[audit\]' <<<"$DIGEST" \
    && pass "/health 附带最近的审计记录" || fail "/health 没有审计摘要"
  # The audit line names the endpoint and why it was refused, so an operator
  # reading /health alone can tell a brute-force attempt from a broken client.
  grep -q 'wrong-value' <<<"$DIGEST" \
    && fail "/health 审计摘要里出现了调用方提供的令牌原文" \
    || pass "/health 审计摘要不含调用方提供的令牌原文"
  grep -q 'invalid_bearer' <<<"$DIGEST" \
    && pass "审计摘要保留了拒绝原因（invalid_bearer）" || fail "审计摘要没有拒绝原因"
  grep -qF "$SECRET" <<<"$DIGEST" \
    && fail "/health 摘要里出现了管理密钥" || pass "/health 摘要不含管理密钥"


  info "结构化自检：探针不依赖凭据，坏了要说出来"
  # Docker HEALTHCHECK 就是这种调用者：不带任何凭据，必须能读到状态。
  PROBE_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null)"
  [ "$PROBE_CODE" = 200 ] \
    && pass "无凭据 GET /health -> 200" || fail "无凭据 GET /health -> HTTP ${PROBE_CODE}（应为 200）"
  for KEY in upstream store accounts lastSweepAt memoryMB warnings checks; do
    grep -q "\"${KEY}\":" <<<"$DIGEST" \
      && pass "/health 含 ${KEY}" || fail "/health 缺少 ${KEY}: $DIGEST"
  done
  grep -q '"readable":true' <<<"$DIGEST" && grep -q '"writable":true' <<<"$DIGEST" \
    && pass "/health 报告数据卷可读写" || fail "/health 数据卷自检失败: $DIGEST"
  grep -q '"fetchedAt":"' <<<"$DIGEST" \
    && pass "/health 报告上游抓取时间" || fail "/health 未报告上游抓取时间: $DIGEST"
  PROBE_WRITE="$(in_container 'touch /data/.rw-probe 2>/dev/null && rm -f /data/.rw-probe && echo ok' 2>/dev/null | tr -d '\r\n')"
  [ "$PROBE_WRITE" = ok ] \
    && pass "容器内 /data 可写（与 /health 结论一致）" \
    || fail "容器内 /data 不可写，但 /health 报告可写: $DIGEST"

  info "启动自检与日志轮转"
  # 重启过，日志要以当前容器的为准。
  LOGS="$(docker logs "$CONTAINER" 2>&1 || true)"
  grep -q '\[startup\] UPSTREAM_INFO' <<<"$LOGS" \
    && pass "启动时打印 UPSTREAM_INFO" || fail "启动日志里没有 UPSTREAM_INFO"
  grep -q '\[startup\] self-check done' <<<"$LOGS" \
    && pass "启动自检已执行" || fail "启动日志里没有 self-check done"
  # 一句模板查询在 Options 为空时只会返回空串，等于什么都不说。先把整个
  # LogConfig 抓下来：driver 是什么、options 有没有，失败时才分得清是「我们没
  # 传 --log-opt」还是「这台机器的默认 driver 不吃这个参数」。
  LOG_CFG="$(docker inspect -f '{{json .HostConfig.LogConfig}}' "$CONTAINER" 2>/dev/null || echo '')"
  LOG_MAX="$(grep -o '"max-size":"[^"]*"' <<<"$LOG_CFG" | head -1 | cut -d'"' -f4)"
  [ -n "$LOG_MAX" ] \
    && pass "日志轮转已生效（max-size=${LOG_MAX}）" \
    || fail "容器未配置日志轮转：LogConfig=${LOG_CFG:-无}"

  info "镜像体积预算"
  SIZE_BYTES="$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)"
  SIZE_MB=$(( SIZE_BYTES / 1048576 ))
  echo "      镜像体积: ${SIZE_MB} MB（预算 ${SIZE_BUDGET_MB} MB）"
  if [ "$SIZE_MB" -le "$SIZE_BUDGET_MB" ]; then
    pass "镜像体积在预算内"
  else
    fail "镜像体积 ${SIZE_MB} MB 超出预算 ${SIZE_BUDGET_MB} MB"
  fi

  info "凭据类断言：错误的凭据必须被挡，正确的必须放行"
  # 这一组是「凭据本身」的正反两面：前三条在容器内根本到不了上游，最后一条要真的派发一次。
  BEARER_IPC="$(code_of -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" \
    -d '{"channel":"proxy:getStatus","args":[]}')"
  [ "$BEARER_IPC" = 200 ] \
    && pass "正确 Bearer 调 /__ipc -> 200" \
    || fail "正确 Bearer 调 /__ipc -> HTTP $BEARER_IPC（应为 200）：$(clip "$(curl -sS -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || true)")"
  WRONG_BEARER="$(code_of -X POST "${BASE}/__ipc" -H "Authorization: Bearer wrong-value" -H "$JSON" \
    -d '{"channel":"proxy:getStatus","args":[]}')"
  [ "$WRONG_BEARER" = 401 ] \
    && pass "错误 Bearer -> 401" || fail "错误 Bearer -> HTTP $WRONG_BEARER（应为 401）"
  EVIL_ORIGIN="$(code_of -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "$JSON" -H "Origin: http://evil.example" \
    -d '{"channel":"proxy:getStatus","args":[]}')"
  [ "$EVIL_ORIGIN" = 403 ] \
    && pass "带 Origin: http://evil.example -> 403（跨站写不进来）" \
    || fail "带 Origin: http://evil.example -> HTTP $EVIL_ORIGIN（应为 403）"
  TEXT_POST="$(code_of -X POST "${BASE}/__ipc" "${AUTH[@]}" -H "Content-Type: text/plain" \
    --data-binary '{"channel":"proxy:getStatus","args":[]}')"
  [ "$TEXT_POST" = 415 ] \
    && pass "非 application/json 的 POST -> 415（挡掉免预检的表单提交）" \
    || fail "非 application/json 的 POST -> HTTP $TEXT_POST（应为 415）"

  info "请求日志与统计：失败原因要看得见"
  # 先制造一次请求，让统计至少有一条观测；失败是因为没有可用账号，正好验证分类。
  curl -s -o /dev/null -X POST "${BASE}/v1/chat/completions" "${AUTH[@]}" -H "$JSON" \
    -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' 2>/dev/null || true
  sleep 1
  # 用 management 前缀：兼容层对 /v0/ 与 /management 两种写法等价，顺带验证一次。
  STATS_BODY="$(curl -sS -D "$WORKDIR/stats.hdr" "${BASE}/management/statistics" "${AUTH[@]}" 2>/dev/null || echo '')"
  STATS_CODE="$(sed -n 's/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$WORKDIR/stats.hdr" 2>/dev/null | tail -1)"
  [ "$STATS_CODE" = 200 ] \
    && pass "/management/statistics -> 200" \
    || fail "/management/statistics -> HTTP ${STATS_CODE:-无}：$(clip "$STATS_BODY")"
  for KEY in p50 p95 byCategory; do
    grep -q "\"${KEY}\":" <<<"$STATS_BODY" \
      && pass "统计含 ${KEY}" || fail "统计缺少 ${KEY}：$(clip "$STATS_BODY")"
  done
  # byCategory 可以是空数组（干净实例没有失败），但字段本身必须在——面板靠它区分
  # 「这一版没有失败」和「这一版没有分类能力」。
  grep -q '"category":' <<<"$STATS_BODY" \
    && pass "byCategory 已有分类记录" \
    || pass "byCategory 为空（干净实例，没有可分类的失败）"
  # 值可以为空（干净实例没有日志），但那个头说明「这个响应确实出自我们的聚合层」。
  grep -qi '^x-c2a-observability: statistics' "$WORKDIR/stats.hdr" 2>/dev/null \
    && pass "统计响应由观察层接管（X-C2A-Observability: statistics）" \
    || fail "统计响应缺少 X-C2A-Observability 头，实际头部：$(clip "$(cat "$WORKDIR/stats.hdr" 2>/dev/null)")"
  # 分类要能和失败对得上：刚打过一发没有账号的 completions 请求，分类里应当出现它的类别，
  # 而且必须是我们定义过的七个之一，不是随手编的字符串。
  CLASSES="$(grep -oE '"category":"[a-z0-9-]+"' <<<"$STATS_BODY" | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
  if [ -n "${CLASSES// /}" ]; then
    BAD_CLASS=""
    for c in $CLASSES; do
      case "$c" in
        auth|captcha|rate-limit|network|provider-5xx|client-error|unknown) ;;
        *) BAD_CLASS="$c" ;;
      esac
    done
    [ -z "$BAD_CLASS" ] \
      && pass "失败分类都取自约定枚举（${CLASSES% }）" \
      || fail "统计出现了约定外的分类：$BAD_CLASS"
  fi

  info "账号自愈：装没装、开没开，都要说出来"
  HEAL="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
  if grep -q 'selfheal' <<<"$HEAL" || grep -qi 'self-heal' <<<"$HEAL"; then
    pass "/health 报告了账号自愈的状态"
  else
    fail "/health 既不报自愈状态、也不报警告——未安装必须显式可见：$(clip "$HEAL")"
  fi
  grep -q '"installed":true' <<<"$HEAL" \
    && pass "/health 显示自愈已安装" \
    || fail "/health 没有 installed:true（自愈层没接上？）：$(clip "$HEAL")"
  grep -q '"enabled":true' <<<"$HEAL" \
    && pass "/health 显示自愈已启用" \
    || fail "/health 没有 enabled:true（检查 CHAT2API_SELFHEAL 是否为 0）：$(clip "$HEAL")"
  # 装上了不等于接好了：哪条接缝没挂上，也要能在同一个响应里看到。
  SEAMS="$(grep -oE '"(requestPath|accountPicker|balancer|routeObserver|tokenCaches|reasonPatches|missing)":[^,}]*' <<<"$HEAL" | tr '\n' ' ')"
  if grep -q '"missing":\[\]' <<<"$HEAL"; then
    pass "自愈的接缝全部接上（missing 为空）"
  else
    fail "自愈有接缝没接上：${SEAMS:-/health 里没有 missing 字段}"
  fi

  info "账号：假 token 必须被判定为坏，并反映到状态上"
  # 这条会真的去问一次上游，所以要求容器有外网；没有网络时上游明确回 networkError，
  # 按设计这时**不该**把账号打成 error，我们要能分辨这两种结局而不是一律失败。
  # 用 provider 列表里真实存在的一个 provider，而不是猜一个 id。
  PROVIDER_ID="$(curl -fsS "${BASE}/management/providers" "${AUTH[@]}" 2>/dev/null \
    | tr '{' '\n' | grep -oE '"id":"[a-z0-9-]+"' | head -1 | cut -d'"' -f4)"
  PROVIDER_ID="${PROVIDER_ID:-deepseek}"
  ACCT_NAME="smoke-invalid-${PROVIDER_ID}"
  CREATED="$(curl -sS -X POST "${BASE}/management/accounts" "${AUTH[@]}" -H "$JSON" \
    -d "{\"providerId\":\"${PROVIDER_ID}\",\"name\":\"${ACCT_NAME}\",\"credentials\":{\"token\":\"obviously-invalid-token-0001\"}}" \
    2>/dev/null || echo '')"
  ACCT_ID="$(grep -oE '"id":"[^"]+"' <<<"$CREATED" | head -1 | cut -d'"' -f4)"
  if [ -n "$ACCT_ID" ]; then
    pass "建立待验证账号（$ACCT_NAME）"
    VALIDATED="$(curl -sS --max-time 25 -X POST "${BASE}/management/accounts/${ACCT_ID}/validate" "${AUTH[@]}" \
      2>/dev/null || echo '')"
    case "$VALIDATED" in
      *'"valid":false'*) pass "假 token 的账号被判为无效" ;;
      *'"networkError":true'*)
        pass "上游不可达（networkError），按设计不改账号状态——分类为瞬时失败"
        echo "      响应：$(clip "$VALIDATED")" ;;
      *) fail "validate 结果异常：$(clip "$VALIDATED")" ;;
    esac
    if [ -n "$VALIDATED" ] && ! grep -q '"networkError":true' <<<"$VALIDATED"; then
      STATE_JSON="$(curl -fsS "${BASE}/management/accounts/${ACCT_ID}" "${AUTH[@]}" 2>/dev/null || echo '')"
      grep -q '"status":"error"' <<<"$STATE_JSON" \
        && pass "账号状态已变为 error" || fail "账号状态未变为 error：$(clip "$STATE_JSON")"
    fi
    DELETED="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "${BASE}/management/accounts/${ACCT_ID}" "${AUTH[@]}")"
    [ "$DELETED" = 200 ] && pass "清理待验证账号" || fail "删除账号 -> HTTP $DELETED（冒烟会留下垃圾账号）"
    curl -fsS "${BASE}/management/accounts" "${AUTH[@]}" 2>/dev/null | grep -q "$ACCT_NAME" \
      && fail "待验证账号仍在列表里" || pass "列表里已没有待验证账号"
  else
    fail "建立待验证账号失败：$(clip "$CREATED")"
  fi
fi

info "局域网默认：发布出去的就是「不登录」"
# 上面的 401/403 断言之所以成立，是因为 start_container 把门 pin 开了。
# 这里按发布默认（不设 CHAT2API_REQUIRE_AUTH）再起一次，确认开箱即用。
if SMOKE_GATE=0 start_container >/dev/null 2>&1 && wait_ready; then
  pass "门关闭时容器仍然就绪（/health 200）"
  CODE="$(code_of "${BASE}/")"
  [ "$CODE" = 200 ] \
    && pass "无凭据 GET / -> 200（内网默认，不再要登录）" \
    || fail "无凭据 GET / -> HTTP $CODE（应为 200）"
  CODE="$(code_of "${BASE}/v1/models")"
  [ "$CODE" = 200 ] \
    && pass "无凭据 GET /v1/models -> 200" \
    || fail "无凭据 GET /v1/models -> HTTP $CODE（应为 200）"
  # 跨站请求不是身份问题，是 CSRF：门关了也必须挡住。
  CODE="$(code_of -X POST "${BASE}/__ipc" -H "$JSON" -H "Origin: http://evil.example" \
    -d '{"channel":"proxy:getStatus","args":[]}')"
  [ "$CODE" = 403 ] \
    && pass "门关闭时跨站 Origin 仍被拒 -> 403" \
    || fail "门关闭时跨站 Origin -> HTTP $CODE（应为 403）"
else
  fail "门关闭时容器 60 秒内没有就绪"
fi

if [ "$FAILED" = 0 ]; then
  printf '\n\033[32m✅ SMOKE TEST PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[31m❌ SMOKE TEST FAILED\033[0m\n'
  printf '失败项：\n%s\n' "$FAILURES"
  if [ -z "$VERIFY_URL" ]; then
    echo "---- 容器日志 ----"
    docker logs --tail 80 "$CONTAINER" 2>&1 || true
  fi
  exit 1
fi
