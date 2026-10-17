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
  FAILURES="${FAILURES}${FAILURES:+
}  - $*"
}
info() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

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
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8082" \
    -v "$WORKDIR/data:/data" \
    "$IMAGE" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 90); do
    if curl -fsS "${BASE}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

in_container() { docker exec "$CONTAINER" sh -c "$1" 2>&1; }

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

info "代理确实在运行，且上报的是公开端口"
HEALTH_JSON="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
PROXY_STATE="$(grep -oE '"status":"[a-z]+"' <<<"$HEALTH_JSON" | head -1 | cut -d'"' -f4)"
[ "$PROXY_STATE" = "running" ] \
  && pass "上游代理状态为 running" \
  || fail "上游代理状态为 '${PROXY_STATE:-无}'（应为 running）: $HEALTH_JSON"

STATUS_JSON="$(curl -sS -X POST "${BASE}/__ipc" -H 'Content-Type: application/json' \
  -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || echo '')"
ADVERTISED_PORT="$(grep -oE '"port":[0-9]+' <<<"$STATUS_JSON" | head -1 | grep -oE '[0-9]+')"
[ "$ADVERTISED_PORT" = "8082" ] \
  && pass "界面报告的端口是公开端口（8082）" \
  || fail "界面报告的端口是 '${ADVERTISED_PORT:-无}'，应为 8082"

info "OpenAI 兼容 API"
MODELS="$(curl -fsS "${BASE}/v1/models" || echo '')"
grep -q '"object":"list"' <<<"$MODELS" \
  && pass "/v1/models 返回 OpenAI 格式" || fail "/v1/models 异常: $MODELS"

CHAT_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' 2>/dev/null)"
case "$CHAT_CODE" in
  200) pass "/v1/chat/completions 可用（200）" ;;
  401|429|503) pass "/v1/chat/completions 端点存在（$CHAT_CODE，无账号或需密钥属正常）" ;;
  *) fail "/v1/chat/completions 返回 $CHAT_CODE" ;;
esac

info "管理 API：/management 与 /v0/management 等价"
MGMT_ALIAS="$(curl -s -w '\n%{http_code}' "${BASE}/management/accounts" || echo '')"
MGMT_UPSTREAM="$(curl -s -w '\n%{http_code}' "${BASE}/v0/management/accounts" || echo '')"
ALIAS_CODE="$(tail -1 <<<"$MGMT_ALIAS")"
UPSTREAM_CODE="$(tail -1 <<<"$MGMT_UPSTREAM")"
[ "$ALIAS_CODE" = 200 ] \
  && pass "/management/accounts -> 200" || fail "/management/accounts -> HTTP $ALIAS_CODE"
[ "$ALIAS_CODE" = "$UPSTREAM_CODE" ] \
  && pass "两个前缀状态码一致（$ALIAS_CODE）" \
  || fail "前缀行为不一致: /management=$ALIAS_CODE /v0/management=$UPSTREAM_CODE"

info "上游原版界面"
INDEX="$(curl -fsS "${BASE}/" || echo '')"
grep -q '/__preload.js' <<<"$INDEX" \
  && pass "页面已注入 preload 桥" || fail "页面缺少 /__preload.js"
grep -qi '<div id="root"\|<div id="app"' <<<"$INDEX" \
  && pass "根节点为 SPA 挂载点（上游界面）" || fail "页面结构不像上游前端"

ASSET="$(grep -oE '(src|href)="[^"]*/assets/[^"]+"' <<<"$INDEX" | head -1 | sed 's/.*="//;s/"$//')"
ASSET="${ASSET#./}"
case "$ASSET" in /*) ;; *) ASSET="/$ASSET" ;; esac
if [ -n "$ASSET" ]; then
  AC="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}${ASSET}")"
  [ "$AC" = 200 ] \
    && pass "前端静态资源可访问（$ASSET）" \
    || fail "静态资源 $ASSET -> HTTP $AC"
else
  fail "页面未引用任何 /assets/ 资源"
fi

info "登录页（网页登录的替代路径）"
LOGIN_HTML="$(curl -fsS "${BASE}/__login?provider=deepseek&providerId=deepseek" || echo '')"
grep -q 'userToken' <<<"$LOGIN_HTML" \
  && pass "/__login 返回带提供商指引的页面" \
  || fail "/__login 内容异常（缺少该提供商的注取指引）"

# 未授权调用不得直接写入账号：缺参数应拒。
BAD_FINISH="$(curl -s -X POST "${BASE}/__login/finish" -H 'Content-Type: application/json' \
  -d '{}' 2>/dev/null || echo '')"
grep -q '"ok":false' <<<"$BAD_FINISH" \
  && pass "缺参数提交被拒绝" || fail "缺参数提交未被拒绝: $BAD_FINISH"

# 无效凭证必须被上游验证抦下，而不是先存下再说。
INVALID_FINISH="$(curl -s -X POST "${BASE}/__login/finish" -H 'Content-Type: application/json' \
  -d '{"providerId":"deepseek","providerType":"deepseek","credentials":{"token":"obviously-invalid-token"}}' \
  2>/dev/null || echo '')"
if grep -q '"ok":false' <<<"$INVALID_FINISH"; then
  pass "无效凭证被验证拒绝（未写入账号）"
else
  fail "无效凭证未被拒绝: $INVALID_FINISH"
fi

if [ -z "$VERIFY_URL" ]; then
  info "网页登录不再报错，而是引导到登录页"
  # 容器里开不了 Electron 窗口；这条必须给出一条引导，而不是报窗口错误。
  IAL="$(curl -sS -X POST "${BASE}/__ipc" -H 'Content-Type: application/json' \
    -d '{"channel":"oauth:startInAppLogin","args":[{"providerId":"deepseek","providerType":"deepseek"}]}' \
    2>/dev/null || echo '')"
  if grep -q '登录页\|\/__login' <<<"$IAL"; then
    pass "startInAppLogin 返回引导（指向登录页）"
  else
    fail "startInAppLogin 未返回引导: $IAL"
  fi
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
  RUNTIME_OWNER="$(in_container "stat -c '%u' $SECRET_FILE" | tr -d '\r\n')"
  [ "$RUNTIME_OWNER" = "1000" ] \
    && pass "运行时文件属主为 1000" || fail "运行时文件属主为 $RUNTIME_OWNER，预期 1000"

  info "上游 wasm 依赖（DeepSeek/GLM 签名）"
  WASM_OUT="$(docker exec "$CONTAINER" node -e '
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
  PRELOAD="$(curl -fsS "${BASE}/__preload.js" || echo '')"
  grep -q 'contextBridge' <<<"$PRELOAD" && pass "preload 桥已就绪" || fail "preload 内容异常"
  grep -q '__c2a_require' <<<"$PRELOAD" && pass "preload 桥含 require 垫片" || fail "preload 缺少垫片"
  grep -q 'armPlaceholder' <<<"$PRELOAD" && pass "preload 桥含弹窗预开逻辑" || fail "preload 缺少弹窗处理"

  CODE_IPC="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/__ipc" \
    -H 'Content-Type: application/json' -d '{"channel":"__no_such_channel__","args":[]}')"
  [ "$CODE_IPC" = 404 ] && pass "IPC 端点已就绪（未知 channel -> 404）" || fail "IPC 端点异常: HTTP $CODE_IPC"

  IPC_ACC="$(curl -fsS -X POST "${BASE}/__ipc" -H 'Content-Type: application/json' \
    -d '{"channel":"accounts:getAll","args":[false]}' || echo '')"
  grep -q '"ok":true' <<<"$IPC_ACC" && pass "IPC 桥能派发真实 channel" || fail "IPC 桥派发失败: $IPC_ACC"

  info "浏览器打开"
  SSE_FILE="$WORKDIR/sse.txt"
  : > "$SSE_FILE"
  ( curl -sS --max-time 15 -N "${BASE}/__ipc/events" > "$SSE_FILE" 2>/dev/null & )
  sleep 2
  curl -fsS -X POST "${BASE}/__ipc" -H 'Content-Type: application/json' \
    -d '{"channel":"app:openExternal","args":["https://chat.deepseek.com"]}' >/dev/null 2>&1 || true
  sleep 3
  if grep -q 'chat.deepseek.com' "$SSE_FILE" 2>/dev/null; then
    pass "openExternal 事件会送达界面"
  else
    fail "openExternal 事件未到达事件流"
  fi

  info "生成的密钥"
  SECRET="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
  [ -n "$SECRET" ] && pass "密钥已生成" || fail "未找到生成的密钥文件"
  MODE="$(in_container "stat -c '%a' $SECRET_FILE" | tr -d '\r\n')"
  [ "$MODE" = 600 ] && pass "密钥文件权限为 600" || fail "密钥文件权限为 $MODE，预期 600"

  info "账号写入与读取"
  CREATE="$(curl -fsS -X POST "${BASE}/management/accounts" \
    -H 'Content-Type: application/json' \
    -d '{"providerId":"deepseek","name":"smoke-account","credentials":{"token":"smoke-token-value"}}' || echo '')"
  grep -q '"success":true' <<<"$CREATE" && pass "添加账号成功" || fail "添加账号失败: $CREATE"

  LIST="$(curl -fsS "${BASE}/management/accounts" || echo '')"
  grep -q 'smoke-account' <<<"$LIST" && pass "账号出现在列表中" || fail "列表中未找到新账号"
  grep -q 'smoke-token-value' <<<"$LIST" && fail "列表泄露了明文凭证" || pass "列表未泄露明文凭证"

  info "客户端 API 密钥"
  KEYRESP="$(curl -fsS -X POST "${BASE}/management/api-keys" \
    -H 'Content-Type: application/json' -d '{"name":"smoke-client"}' || echo '')"
  grep -q 'sk-mgmt-' <<<"$KEYRESP" && pass "生成客户端 API 密钥" || fail "生成密钥失败: $KEYRESP"

  info "凭证加密（AES-256-GCM）"
  CRYPTO_OUT="$(docker exec "$CONTAINER" node -e '
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

  docker exec "$CONTAINER" test -f /data/.chat2api/.safe-storage-key \
    && pass "加密密钥持久化在数据卷" || fail "加密密钥未落在数据卷"

  DATAJSON_OUT="$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
try { JSON.parse(fs.readFileSync("/data/.chat2api/data.json", "utf8")); process.exit(1) }
catch { process.exit(0) }
' 2>&1)"
  [ -z "$DATAJSON_OUT" ] && pass "data.json 为密文" || fail "data.json 可直接解析为 JSON（应为密文）"

  info "重启后持久化"
  docker restart "$CONTAINER" >/dev/null
  if wait_ready; then pass "重启后服务就绪"; else fail "重启后服务未就绪"; fi

  AFTER="$(curl -fsS "${BASE}/management/accounts" || echo '')"
  grep -q 'smoke-account' <<<"$AFTER" && pass "重启后账号仍在" || fail "重启后账号丢失"

  SECRET_AFTER="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
  [ "$SECRET_AFTER" = "$SECRET" ] && pass "重启后管理密钥不变" || fail "重启后管理密钥变化"

  RESTART_HEALTH="$(curl -fsS "${BASE}/health" 2>/dev/null || echo '')"
  RESTART_STATE="$(grep -oE '"status":"[a-z]+"' <<<"$RESTART_HEALTH" | head -1 | cut -d'"' -f4)"
  [ "$RESTART_STATE" = "running" ] \
    && pass "重启后代理状态仍为 running" || fail "重启后代理状态为 '${RESTART_STATE:-无}'"

  RESTART_STATUS="$(curl -sS -X POST "${BASE}/__ipc" -H 'Content-Type: application/json' \
    -d '{"channel":"proxy:getStatus","args":[]}' 2>/dev/null || echo '')"
  RESTART_PORT="$(grep -oE '"port":[0-9]+' <<<"$RESTART_STATUS" | head -1 | grep -oE '[0-9]+')"
  [ "$RESTART_PORT" = "8082" ] \
    && pass "重启后上报端口仍为 8082" || fail "重启后上报端口为 '${RESTART_PORT:-无}'"

  info "镜像体积预算"
  SIZE_BYTES="$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)"
  SIZE_MB=$(( SIZE_BYTES / 1048576 ))
  echo "      镜像体积: ${SIZE_MB} MB（预算 ${SIZE_BUDGET_MB} MB）"
  if [ "$SIZE_MB" -le "$SIZE_BUDGET_MB" ]; then
    pass "镜像体积在预算内"
  else
    fail "镜像体积 ${SIZE_MB} MB 超出预算 ${SIZE_BUDGET_MB} MB"
  fi
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
