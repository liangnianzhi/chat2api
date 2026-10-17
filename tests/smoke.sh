#!/usr/bin/env bash
#
# Smoke test for the chat2api container.
#
# Runs against a freshly created container and reports PASS/FAIL per check.
# Used by .github/workflows/ci.yml, and runnable locally:
#
#   IMAGE=ghcr.io/liangnianzhi/chat2api:latest ./tests/smoke.sh
#
# No secrets are provisioned: deployment is zero-config, so the suite asserts
# that the console works with no credentials while the gateway API stays
# protected behind the secret the container generated for itself.

set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/liangnianzhi/chat2api:latest}"
CONTAINER="${CONTAINER:-chat2api-smoke}"
API_PORT="${API_PORT:-18080}"
UI_PORT="${UI_PORT:-18081}"
SIZE_BUDGET_MB="${SIZE_BUDGET_MB:-250}"
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
  # The container writes into the bind mount as uid 1000, which the runner user
  # may not be able to remove directly.
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
    -p "127.0.0.1:${API_PORT}:8080" \
    -p "127.0.0.1:${UI_PORT}:8081" \
    -v "$WORKDIR/data:/data" \
    "$IMAGE" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

in_container() { docker exec "$CONTAINER" sh -c "$1" 2>&1; }

# ---------------------------------------------------------------------------
info "准备：宿主目录属主故意设错，验证容器能自愈"
# ---------------------------------------------------------------------------
mkdir -p "$WORKDIR/data"
# 宿主普通用户创建的目录通常不是 uid 1000；entrypoint 必须自行修正。
chown "$(id -u):$(id -g)" "$WORKDIR/data" 2>/dev/null || true
start_container

# ---------------------------------------------------------------------------
info "启动与健康检查"
# ---------------------------------------------------------------------------
if wait_ready; then
  pass "容器在 120s 内就绪（数据卷属主已自动修正）"
else
  fail "容器未就绪"
  echo "---- 容器日志 ----"
  docker logs --tail 80 "$CONTAINER" 2>&1 | sed 's/^/      /'
  echo
  printf '\n\033[31m❌ SMOKE TEST FAILED（容器未就绪，提前退出）\033[0m\n'
  printf '失败项：\n%s\n' "$FAILURES"
  exit 1
fi

# ---------------------------------------------------------------------------
info "无头运行与管理台启动"
# ---------------------------------------------------------------------------
LOGS="$(docker logs "$CONTAINER" 2>&1 || true)"
grep -q 'electron shim active' <<<"$LOGS" \
  && pass "electron shim 已生效" || fail "未看到 'electron shim active'"
grep -q 'management console listening' <<<"$LOGS" \
  && pass "Web 管理台已监听" || fail "Web 管理台未启动"

if docker run --rm --entrypoint sh "$IMAGE" \
     -c 'command -v Xvfb || command -v chromium || command -v electron' 2>/dev/null | grep -q .; then
  fail "镜像里存在 Xvfb/Chromium/electron 可执行文件"
else
  pass "镜像内无 Xvfb / Chromium / electron 可执行文件"
fi

# ---------------------------------------------------------------------------
info "强制降权运行"
# ---------------------------------------------------------------------------
RUNNER_UID="$(in_container 'id -u')"
if [ "$RUNNER_UID" = "1000" ]; then
  pass "主进程以 uid 1000 运行（非 root）"
else
  fail "主进程 uid 为 $RUNNER_UID，预期 1000"
fi

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
if grep -q '^ok$' <<<"$WASM_OUT"; then
  pass "process.resourcesPath 可用且能定位 wasm"
else
  fail "wasm 路径解析失败：$WASM_OUT"
fi

# ---------------------------------------------------------------------------
info "OpenAI 兼容 API"
# ---------------------------------------------------------------------------
HEALTH="$(curl -fsS "http://127.0.0.1:${API_PORT}/health" || echo '')"
grep -q '"status":"running"' <<<"$HEALTH" \
  && pass "/health 返回 running" || fail "/health 异常: $HEALTH"

MODELS="$(curl -fsS "http://127.0.0.1:${API_PORT}/v1/models" || echo '')"
grep -q '"object":"list"' <<<"$MODELS" \
  && pass "/v1/models 返回 OpenAI 格式" || fail "/v1/models 异常: $MODELS"

# ---------------------------------------------------------------------------
info "管理台：无需任何登录"
# ---------------------------------------------------------------------------
UI_HTML="$(curl -fsS "http://127.0.0.1:${UI_PORT}/" || echo '')"
grep -q 'Chat2API 管理台' <<<"$UI_HTML" \
  && pass "管理台页面可访问" || fail "管理台页面内容异常"

if grep -q '管理密钥' <<<"$UI_HTML"; then
  fail "页面上仍有「管理密钥」输入框（已应移除）"
else
  pass "页面上没有登录/密钥输入"
fi

# 不带任何 Authorization 头，服务端应自行注入
CODE_UI_ACC="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_UI_ACC" = 200 ] \
  && pass "管理台代理无需凭据即返回 200（服务端已注入密钥）" \
  || fail "管理台代理应返回 200，实际 $CODE_UI_ACC"

# 白名单：不能变成任意转发器
CODE_RELAY="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v1/models")"
[ "$CODE_RELAY" = 404 ] \
  && pass "管理台拒绕非白名单路径（/v1/models -> 404）" \
  || fail "白名单外路径应 404，实际 $CODE_RELAY"

# ---------------------------------------------------------------------------
info "网关 API：仍然受密钥保护"
# ---------------------------------------------------------------------------
CODE_API_NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/v0/management/accounts")"
[ "$CODE_API_NOAUTH" = 401 ] \
  && pass "直连 8080 无凭据 -> 401" \
  || fail "直连 8080 无凭据应 401，实际 $CODE_API_NOAUTH"

SECRET_FILE="/data/.chat2api/.management-secret"
SECRET="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
if [ -n "$SECRET" ]; then
  pass "密钥已生成并写入 $SECRET_FILE"
else
  fail "未找到生成的密钥文件"
fi

MODE="$(in_container "stat -c '%a' $SECRET_FILE" | tr -d '\r\n')"
[ "$MODE" = 600 ] \
  && pass "密钥文件权限为 600" || fail "密钥文件权限为 $MODE，预期 600"

if [ -n "$SECRET" ]; then
  CODE_API_AUTH="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $SECRET" "http://127.0.0.1:${API_PORT}/v0/management/accounts")"
  [ "$CODE_API_AUTH" = 200 ] \
    && pass "直连 8080 带正确密钥 -> 200" \
    || fail "直连 8080 带正确密钥应 200，实际 $CODE_API_AUTH"
fi

# ---------------------------------------------------------------------------
info "账号写入与读取（经管理台）"
# ---------------------------------------------------------------------------
CREATE="$(curl -fsS -X POST "http://127.0.0.1:${UI_PORT}/v0/management/accounts" \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"deepseek","name":"smoke-account","credentials":{"token":"smoke-token-value"}}' \
  || echo '')"
grep -q '"success":true' <<<"$CREATE" \
  && pass "添加账号成功" || fail "添加账号失败: $CREATE"

LIST="$(curl -fsS "http://127.0.0.1:${UI_PORT}/v0/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$LIST" \
  && pass "账号出现在列表中" || fail "列表中未找到新账号: $LIST"

grep -q 'smoke-token-value' <<<"$LIST" \
  && fail "列表泄露了明文凭证" || pass "列表未泄露明文凭证（已掩码）"

# ---------------------------------------------------------------------------
info "客户端 API 密钥"
# ---------------------------------------------------------------------------
KEYRESP="$(curl -fsS -X POST "http://127.0.0.1:${UI_PORT}/v0/management/api-keys" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-client"}' || echo '')"
grep -q 'sk-mgmt-' <<<"$KEYRESP" \
  && pass "生成客户端 API 密钥" || fail "生成密钥失败: $KEYRESP"

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
if grep -q '^ok$' <<<"$CRYPTO_OUT"; then
  pass "加解密往返、无明文泄露、篡改可检测"
else
  fail "凭证加密自检失败：$CRYPTO_OUT"
fi

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

AFTER="$(curl -fsS "http://127.0.0.1:${UI_PORT}/v0/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$AFTER" \
  && pass "重启后账号仍在" || fail "重启后账号丢失: $AFTER"

SECRET_AFTER="$(in_container "cat $SECRET_FILE" | tr -d '\r\n')"
[ "$SECRET_AFTER" = "$SECRET" ] \
  && pass "重启后管理密钥不变（管理台无需重新登录）" \
  || fail "重启后管理密钥变化"

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
  docker logs --tail 60 "$CONTAINER" 2>&1 || true
  exit 1
fi
