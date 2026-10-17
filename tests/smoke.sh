#!/usr/bin/env bash
#
# Smoke test for the chat2api container.
#
# Runs against a freshly created container and reports PASS/FAIL per check.
# Used by .github/workflows/ci.yml, and runnable locally:
#
#   IMAGE=ghcr.io/liangnianzhi/chat2api:latest ./tests/smoke.sh
#
# Deployment is zero-config and single-port on 8082.

set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/liangnianzhi/chat2api:latest}"
CONTAINER="${CONTAINER:-chat2api-smoke}"
PORT="${PORT:-18082}"
SIZE_BUDGET_MB="${SIZE_BUDGET_MB:-300}"
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
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if command -v sudo >/dev/null 2>&1; then
    sudo rm -rf "$WORKDIR" 2>/dev/null || rm -rf "$WORKDIR" 2>/dev/null || true
  else
    rm -rf "$WORKDIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:8082" \
    -v "$WORKDIR/data:/data" \
    "$IMAGE" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

in_container() { docker exec "$CONTAINER" sh -c "$1" 2>&1; }

# ---------------------------------------------------------------------------
info "准备：宿主目录属主故意设错，验证容器能自愈"
# ---------------------------------------------------------------------------
mkdir -p "$WORKDIR/data"
chown "$(id -u):$(id -g)" "$WORKDIR/data" 2>/dev/null || true
start_container

# ---------------------------------------------------------------------------
info "启动与健康检查"
# ---------------------------------------------------------------------------
if wait_ready; then
  pass "容器在 180s 内就绪（数据卷属主已自动修正）"
else
  fail "容器未就绪"
  echo "---- 容器日志 ----"
  docker logs --tail 100 "$CONTAINER" 2>&1 | sed 's/^/      /'
  echo
  printf '\n\033[31m❌ SMOKE TEST FAILED（容器未就绪，提前退出）\033[0m\n'
  printf '失败项：\n%s\n' "$FAILURES"
  exit 1
fi

# ---------------------------------------------------------------------------
info "只有一个对外端口"
# ---------------------------------------------------------------------------
LOGS="$(docker logs "$CONTAINER" 2>&1 || true)"
grep -q 'electron shim active' <<<"$LOGS" \
  && pass "electron shim 已生效" || fail "未看到 'electron shim active'"
grep -q '\[front\] Chat2API ready on http://0.0.0.0:8082' <<<"$LOGS" \
  && pass "对外只监听 8082" || fail "未在 8082 就绪"

PORTS="$(docker port "$CONTAINER" 2>/dev/null | awk '{print $3}' | sort -u | tr '\n' ' ')"
if [ "$(echo "$PORTS" | wc -w)" = "1" ] && [[ "$PORTS" == *":${PORT}"* ]]; then
  pass "宿主机只有 1 个发布端口（$PORTS）"
else
  fail "发布端口异常: $PORTS"
fi

if docker run --rm --entrypoint sh "$IMAGE" \
     -c 'command -v Xvfb || command -v chromium || command -v electron' 2>/dev/null | grep -q .; then
  fail "镜像里存在 Xvfb/Chromium/electron 可执行文件"
else
  pass "镜像内无 Xvfb / Chromium / electron 可执行文件"
fi

# ---------------------------------------------------------------------------
info "时区默认为 Asia/Shanghai"
# ---------------------------------------------------------------------------
# 静默回退到 UTC 只会在日志时间戳上发现，所以直接问容器。
TZ_ENV="$(in_container 'printf %s "$TZ"' | tr -d '\r\n')"
[ "$TZ_ENV" = "Asia/Shanghai" ] \
  && pass "TZ=$TZ_ENV" || fail "TZ=$TZ_ENV，预期 Asia/Shanghai"

TZ_FILE="$(in_container 'readlink /etc/localtime' | tr -d '\r\n')"
[[ "$TZ_FILE" == *"Shanghai"* ]] \
  && pass "/etc/localtime -> $TZ_FILE" || fail "/etc/localtime 未指向上海：$TZ_FILE"

# 偏移应为 +0800
TZ_OFFSET="$(in_container 'date +%z' | tr -d '\r\n')"
[ "$TZ_OFFSET" = "+0800" ] \
  && pass "date +%z = $TZ_OFFSET" || fail "时区偏移为 $TZ_OFFSET，预期 +0800"

# ---------------------------------------------------------------------------
info "主进程已降权"
# ---------------------------------------------------------------------------
SECRET_FILE="/data/.chat2api/.management-secret"
RUNTIME_OWNER="$(in_container "stat -c '%u' $SECRET_FILE" | tr -d '\r\n')"
[ "$RUNTIME_OWNER" = "1000" ] \
  && pass "运行时文件属主为 1000（主进程已降权到 node）" \
  || fail "运行时文件属主为 $RUNTIME_OWNER，预期 1000"

# ---------------------------------------------------------------------------
info "上游 wasm 依赖（DeepSeek/GLM 签名）"
# ---------------------------------------------------------------------------
WASM_OUT="$(docker exec "$CONTAINER" node -e '
require("/app/shim/electron-shim.js");
const fs = require("fs"), path = require("path");
const p = process.resourcesPath;
if (typeof p !== "string") { console.error("resourcesPath is not a string: " + p); process.exit(1) }
const f = path.join(p, "sha3_wasm_bg.7b9ca65ddd.wasm");
if (!fs.existsSync(f)) { console.error("wasm missing at " + f); process.exit(1) }
console.log("ok");
' 2>&1)"
grep -q '^ok$' <<<"$WASM_OUT" \
  && pass "process.resourcesPath 可用且能定位 wasm" \
  || fail "wasm 路径解析失败：$WASM_OUT"

# ---------------------------------------------------------------------------
info "上游原版界面（由 IPC 桥驱动）"
# ---------------------------------------------------------------------------
INDEX="$(curl -fsS "http://127.0.0.1:${PORT}/" || echo '')"
grep -q '/__preload.js' <<<"$INDEX" \
  && pass "页面已注入 preload 桥" || fail "页面缺少 /__preload.js"
grep -qi '<div id="root"\|<div id="app"' <<<"$INDEX" \
  && pass "根节点为 SPA 挂载点（上游界面）" || fail "页面结构不像上游前端"

PRELOAD="$(curl -fsS "http://127.0.0.1:${PORT}/__preload.js" || echo '')"
grep -q 'contextBridge' <<<"$PRELOAD" \
  && pass "preload 桥已就绪（含 contextBridge）" || fail "preload 内容异常"
grep -q '__c2a_require' <<<"$PRELOAD" \
  && pass "preload 桥含 require 垫片" || fail "preload 缺少垫片"

ASSET="$(grep -oE '(src|href)="[^"]*/assets/[^"]+"' <<<"$INDEX" | head -1 | sed 's/.*="//;s/"$//')"
ASSET="${ASSET#./}"
case "$ASSET" in /*) ;; *) ASSET="/$ASSET" ;; esac
if [ -n "$ASSET" ]; then
  AC="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${ASSET}")"
  [ "$AC" = 200 ] \
    && pass "前端静态资源可访问（$ASSET）" \
    || fail "静态资源 $ASSET -> HTTP $AC"
else
  fail "页面未引用任何 /assets/ 资源"
fi

CODE_IPC="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/__ipc" \
  -H 'Content-Type: application/json' -d '{"channel":"__no_such_channel__","args":[]}')"
[ "$CODE_IPC" = 404 ] \
  && pass "IPC 端点已就绪（未知 channel -> 404）" \
  || fail "IPC 端点异常: HTTP $CODE_IPC"

IPC_ACC="$(curl -fsS -X POST "http://127.0.0.1:${PORT}/__ipc" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"accounts:getAll","args":[false]}' || echo '')"
grep -q '"ok":true' <<<"$IPC_ACC" \
  && pass "IPC 桥能派发真实 channel（accounts:getAll）" \
  || fail "IPC 桥派发失败: $IPC_ACC"

# ---------------------------------------------------------------------------
info "浏览器打开（OAuth 登录依赖这条链路）"
# ---------------------------------------------------------------------------
SSE_FILE="$WORKDIR/sse.txt"
: > "$SSE_FILE"
( curl -sS --max-time 15 -N "http://127.0.0.1:${PORT}/__ipc/events" > "$SSE_FILE" 2>/dev/null & )
sleep 2

curl -fsS -X POST "http://127.0.0.1:${PORT}/__ipc" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"app:openExternal","args":["https://chat.deepseek.com"]}' >/dev/null 2>&1 || true

sleep 3
if grep -q 'chat.deepseek.com' "$SSE_FILE" 2>/dev/null; then
  pass "openExternal 事件会送达界面（可打开登录页）"
else
  fail "openExternal 事件未到达事件流：$(head -c 200 "$SSE_FILE" 2>/dev/null)"
fi

QUEUED_OUT="$(docker exec "$CONTAINER" node -e '
const s = require("/app/shim/electron-shim.js");
s.shell.openExternal("https://queued.example/probe")
  .then(() => console.log("queued"))
  .catch((e) => console.log("error:" + e.message));
' 2>&1)"
if grep -q 'queued' <<<"$QUEUED_OUT"; then
  pass "无订阅者时的打开请求会被保留（不静默丢弃）"
else
  fail "排队逻辑异常: $QUEUED_OUT"
fi

# ---------------------------------------------------------------------------
info "同一端口上的两个 API"
# ---------------------------------------------------------------------------
HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health" || echo '')"
grep -q '"status":"running"' <<<"$HEALTH" \
  && pass "/health 返回 running" || fail "/health 异常: $HEALTH"

MODELS="$(curl -fsS "http://127.0.0.1:${PORT}/v1/models" || echo '')"
grep -q '"object":"list"' <<<"$MODELS" \
  && pass "/v1/models 经同一端口返回 OpenAI 格式" || fail "/v1/models 异常: $MODELS"

# ---------------------------------------------------------------------------
info "管理 API：/management 与 /v0/management 等价"
# ---------------------------------------------------------------------------
MGMT_ALIAS="$(curl -s -w '\n%{http_code}' "http://127.0.0.1:${PORT}/management/accounts" || echo '')"
MGMT_UPSTREAM="$(curl -s -w '\n%{http_code}' "http://127.0.0.1:${PORT}/v0/management/accounts" || echo '')"

ALIAS_CODE="$(tail -1 <<<"$MGMT_ALIAS")"
UPSTREAM_CODE="$(tail -1 <<<"$MGMT_UPSTREAM")"
[ "$ALIAS_CODE" = 200 ] \
  && pass "/management/accounts -> 200" || fail "/management/accounts -> HTTP $ALIAS_CODE"
[ "$ALIAS_CODE" = "$UPSTREAM_CODE" ] \
  && pass "两个前缀状态码一致（$ALIAS_CODE）" \
  || fail "前缀行为不一致: /management=$ALIAS_CODE /v0/management=$UPSTREAM_CODE"

ALIAS_KEYS="$(head -n -1 <<<"$MGMT_ALIAS" | grep -oE '"[a-zA-Z]+":' | sort -u | tr -d '\n')"
UPSTREAM_KEYS="$(head -n -1 <<<"$MGMT_UPSTREAM" | grep -oE '"[a-zA-Z]+":' | sort -u | tr -d '\n')"
[ "$ALIAS_KEYS" = "$UPSTREAM_KEYS" ] \
  && pass "两个前缀返回相同结构" \
  || fail "返回结构不一致: alias=[$ALIAS_KEYS] upstream=[$UPSTREAM_KEYS]"

# ---------------------------------------------------------------------------
info "生成的密钥"
# ---------------------------------------------------------------------------
SECRET="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
[ -n "$SECRET" ] \
  && pass "密钥已生成并写入 $SECRET_FILE" || fail "未找到生成的密钥文件"

MODE="$(in_container "stat -c '%a' $SECRET_FILE" | tr -d '\r\n')"
[ "$MODE" = 600 ] \
  && pass "密钥文件权限为 600" || fail "密钥文件权限为 $MODE，预期 600"

# ---------------------------------------------------------------------------
info "账号写入与读取"
# ---------------------------------------------------------------------------
CREATE="$(curl -fsS -X POST "http://127.0.0.1:${PORT}/management/accounts" \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"deepseek","name":"smoke-account","credentials":{"token":"smoke-token-value"}}' \
  || echo '')"
grep -q '"success":true' <<<"$CREATE" \
  && pass "添加账号成功（经 /management）" || fail "添加账号失败: $CREATE"

LIST="$(curl -fsS "http://127.0.0.1:${PORT}/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$LIST" \
  && pass "账号出现在列表中" || fail "列表中未找到新账号: $LIST"

grep -q 'smoke-token-value' <<<"$LIST" \
  && fail "列表泄露了明文凭证" || pass "列表未泄露明文凭证（已掩码）"

# ---------------------------------------------------------------------------
info "凭证加密（AES-256-GCM）"
# ---------------------------------------------------------------------------
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
grep -q '^ok$' <<<"$CRYPTO_OUT" \
  && pass "加解密往返、无明文泄露、篡改可检测" \
  || fail "凭证加密自检失败：$CRYPTO_OUT"

if docker exec "$CONTAINER" test -f /data/.chat2api/.safe-storage-key; then
  pass "加密密钥持久化在数据卷"
else
  fail "加密密钥未落在数据卷"
fi

DATAJSON_OUT="$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
try { JSON.parse(fs.readFileSync("/data/.chat2api/data.json", "utf8")); process.exit(1) }
catch { process.exit(0) }
' 2>&1)"
[ -z "$DATAJSON_OUT" ] \
  && pass "data.json 为密文" || fail "data.json 可直接解析为 JSON（应为密文）"

# ---------------------------------------------------------------------------
info "重启后持久化"
# ---------------------------------------------------------------------------
docker restart "$CONTAINER" >/dev/null
if wait_ready; then pass "重启后容器就绪"; else fail "重启后容器未就绪"; fi

AFTER="$(curl -fsS "http://127.0.0.1:${PORT}/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$AFTER" \
  && pass "重启后账号仍在" || fail "重启后账号丢失: $AFTER"

SECRET_AFTER="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
[ "$SECRET_AFTER" = "$SECRET" ] \
  && pass "重启后管理密钥不变" || fail "重启后管理密钥变化"

# ---------------------------------------------------------------------------
info "镜像体积预算"
# ---------------------------------------------------------------------------
SIZE_BYTES="$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)"
SIZE_MB=$(( SIZE_BYTES / 1048576 ))
echo "      镜像体积: ${SIZE_MB} MB（预算 ${SIZE_BUDGET_MB} MB）"
if [ "$SIZE_MB" -le "$SIZE_BUDGET_MB" ]; then
  pass "镜像体积在预算内"
else
  fail "镜像体积 ${SIZE_MB} MB 超出预算 ${SIZE_BUDGET_MB} MB"
fi

# ---------------------------------------------------------------------------
if [ "$FAILED" = 0 ]; then
  printf '\n\033[32m✅ SMOKE TEST PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[31m❌ SMOKE TEST FAILED\033[0m\n'
  printf '失败项：\n%s\n' "$FAILURES"
  echo "---- 容器日志 ----"
  docker logs --tail 80 "$CONTAINER" 2>&1 || true
  exit 1
fi
