#!/usr/bin/env bash
#
# Smoke test for the Chat2API gateway container.
#
# Runs against an already-started container and reports PASS/FAIL per check.
# Used by .github/workflows/ci.yml, and runnable locally:
#
#   IMAGE=chat2api-gateway:latest ./tests/smoke.sh
#
# It intentionally avoids jq and other extras: GitHub runners have them, minimal
# hosts may not, and grep is enough for the shapes being asserted.

set -uo pipefail

IMAGE="${IMAGE:-chat2api-gateway:latest}"
CONTAINER="${CONTAINER:-chat2api-smoke}"
API_PORT="${API_PORT:-18080}"
UI_PORT="${UI_PORT:-18081}"
SECRET="${SECRET:-smoke-secret-$$}"
NEW_SECRET="${NEW_SECRET:-smoke-rotated-$$}"
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
    -e CHAT2API_MANAGEMENT_SECRET="$1" \
    "$IMAGE" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
info "准备：数据卷与容器"
# ---------------------------------------------------------------------------
mkdir -p "$WORKDIR/data"
chmod 777 "$WORKDIR/data"
start_container "$SECRET"

# ---------------------------------------------------------------------------
info "启动与健康检查"
# ---------------------------------------------------------------------------
if wait_ready; then
  pass "容器在 120s 内就绪"
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

# 只给了管理密钥、没设任何开关，管理 API 应自动启用。
# 用功能行为判定而不是匹配日志文案：未启用时管理路由为 404，
# 启用而未鉴权为 401。（日志文案会随重构变化，行为不会。）
CODE_AUTO="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_AUTO" = 401 ] \
  && pass "仅凭密钥自动启用了管理 API（未鉴权 -> 401，而非 404）" \
  || fail "管理 API 未自动启用，实际 $CODE_AUTO"

# 无头构建不应出现 Chromium / Xvfb 相关依赖
if docker run --rm --entrypoint sh "$IMAGE" \
     -c 'command -v Xvfb || command -v chromium || command -v electron' 2>/dev/null | grep -q .; then
  fail "镜像里存在 Xvfb/Chromium/electron 可执行文件"
else
  pass "镜像内无 Xvfb / Chromium / electron 可执行文件"
fi

# ---------------------------------------------------------------------------
info "上游 wasm 依赖（DeepSeek/GLM 签名）"
# ---------------------------------------------------------------------------
# 编译后的 bundle 通过 process.resourcesPath 定位 sha3 wasm；该属性只在 Electron
# 中存在，纯 Node 下为 undefined，path.join 会直接抛错。此项确保 shim 已定义它
# 且 wasm 确实在对应目录里，否则首个真实 DeepSeek 请求才会暴露问题。
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
info "管理 API 鉴权"
# ---------------------------------------------------------------------------
CODE_NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_NOAUTH" = 401 ] \
  && pass "无密钥访问管理 API -> 401" || fail "无密钥应返回 401，实际 $CODE_NOAUTH"

CODE_BADAUTH="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer wrong-secret' "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_BADAUTH" = 401 ] \
  && pass "错误密钥 -> 401" || fail "错误密钥应返回 401，实际 $CODE_BADAUTH"

CODE_OK="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $SECRET" "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_OK" = 200 ] \
  && pass "正确密钥 -> 200" || fail "正确密钥应返回 200，实际 $CODE_OK"

# ---------------------------------------------------------------------------
info "Web 管理台"
# ---------------------------------------------------------------------------
UI_HTML="$(curl -fsS "http://127.0.0.1:${UI_PORT}/" || echo '')"
grep -q 'Chat2API 管理台' <<<"$UI_HTML" \
  && pass "管理台页面可访问" || fail "管理台页面内容异常"

# 代理白名单：不能变成任意转发器
CODE_RELAY="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v1/models")"
[ "$CODE_RELAY" = 404 ] \
  && pass "管理台拒绕非白名单路径（/v1/models -> 404）" \
  || fail "白名单外路径应 404，实际 $CODE_RELAY"

# ---------------------------------------------------------------------------
info "账号写入与读取"
# ---------------------------------------------------------------------------
CREATE="$(curl -fsS -X POST "http://127.0.0.1:${UI_PORT}/v0/management/accounts" \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"providerId":"deepseek","name":"smoke-account","credentials":{"token":"smoke-token-value"}}' \
  || echo '')"
grep -q '"success":true' <<<"$CREATE" \
  && pass "添加账号成功" || fail "添加账号失败: $CREATE"

LIST="$(curl -fsS -H "Authorization: Bearer $SECRET" \
  "http://127.0.0.1:${UI_PORT}/v0/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$LIST" \
  && pass "账号出现在列表中" || fail "列表中未找到新账号: $LIST"

grep -q 'smoke-token-value' <<<"$LIST" \
  && fail "列表泄露了明文凭证" || pass "列表未泄露明文凭证（已掩码）"

# ---------------------------------------------------------------------------
info "客户端 API 密钥"
# ---------------------------------------------------------------------------
KEYRESP="$(curl -fsS -X POST "http://127.0.0.1:${UI_PORT}/v0/management/api-keys" \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
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

# 密钥必须落在数据卷上，否则重启后无法解密旧数据
if docker exec "$CONTAINER" test -f /data/.chat2api/.safe-storage-key; then
  pass "加密密钥持久化在数据卷"
else
  fail "加密密钥未落在数据卷"
fi

# data.json 必须是密文。用 JSON.parse 判定而非字节启发式，否则二进制数据可能误判。
DATAJSON_OUT="$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
try { JSON.parse(fs.readFileSync("/data/.chat2api/data.json", "utf8")); process.exit(1) }
catch { process.exit(0) }
' 2>&1)"
if [ -z "$DATAJSON_OUT" ]; then
  pass "data.json 为密文"
else
  fail "data.json 可直接解析为 JSON（应为密文）"
fi

# ---------------------------------------------------------------------------
info "重启后配置与账号持久化"
# ---------------------------------------------------------------------------
docker restart "$CONTAINER" >/dev/null
if wait_ready; then pass "重启后容器就绪"; else fail "重启后容器未就绪"; fi

AFTER="$(curl -fsS -H "Authorization: Bearer $SECRET" \
  "http://127.0.0.1:${UI_PORT}/v0/management/accounts" || echo '')"
grep -q 'smoke-account' <<<"$AFTER" \
  && pass "重启后账号仍在" || fail "重启后账号丢失: $AFTER"

# ---------------------------------------------------------------------------
info "管理密钥改自环境变量"
# ---------------------------------------------------------------------------
start_container "$NEW_SECRET"
if wait_ready; then pass "换密钥后容器就绪"; else fail "换密钥后容器未就绪"; fi

CODE_NEW="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $NEW_SECRET" "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
CODE_OLD="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $SECRET" "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_NEW" = 200 ] \
  && pass "新密钥生效（环境变量优先）" || fail "新密钥应生效，实际 $CODE_NEW"
[ "$CODE_OLD" = 401 ] \
  && pass "旧密钥已失效" || fail "旧密钥应失效，实际 $CODE_OLD"

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
