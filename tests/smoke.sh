# 强制降权运行
# ---------------------------------------------------------------------------
# 不能用 `docker exec id -u`：镜像没有设置 USER，exec 默认以 root 进入，
# 那只反映 exec 的身份，与主进程无关。改看运行时产物的属主——文件由网关进程
# 写入，属主即该进程的 uid，这才是降权真正生效的证据。
RUNTIME_OWNER="$(in_container "stat -c '%u' /data/.chat2api/.management-secret" | tr -d '\r\n')"
if [ "$RUNTIME_OWNER" = "1000" ]; then
  pass "运行时文件属主为 1000（主进程已降权到 node）"
else
  fail "运行时文件属主为 $RUNTIME_OWNER，预期 1000"
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

CODE_UI_ACC="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${UI_PORT}/v0/management/accounts")"
[ "$CODE_UI_ACC" = 200 ] \
  && pass "管理台代理无需凭据即返回 200（服务端已注入密钥）" \
  || fail "管理台代理应返回 200，实际 $CODE_UI_ACC"

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
