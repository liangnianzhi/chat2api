# Chat2API 无头网关（含 Web 管理台）
# =============================================================================
# 上游: https://github.com/wxs0625/Chat2API-WXS  (GPL-3.0)
#
# 只对外一个端口：
#   GET /              -> 上游原版前端界面（out/renderer）
#   POST /__ipc        -> 把界面的 IPC 调用派发给上游自己的 ipcMain.handle
#   /v1、/health        -> 转发给回环上的网关
#   /management/*      -> 改写成 /v0/management/* 后转发（更好记的管理入口）
#
# 源码获取
# --------
# 默认从 codeload 下载上游 tarball。网络受限时（例如 NAS 上 codeload 很慢），
# 把同一个文件放到 build/upstream-src.tar.gz 即可跳过下载：
#
#   mkdir -p build
#   curl -fsSL -o build/upstream-src.tar.gz \
#     https://codeload.github.com/wxs0625/Chat2API-WXS/tar.gz/main
#   docker build -t chat2api:latest .
#
# 该文件是构建输入，.dockerignore 已排除它（来自 build/ 的都会进 COPY，但只有
# 名字匹配的那个会被当作源码包）。
# =============================================================================

ARG NODE_VERSION=20-alpine

# ---------------------------------------------------------------------------
# 阶段 1：拉源码并编译
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder

ARG CHAT2API_REPO=wxs0625/Chat2API-WXS
ARG CHAT2API_REF=main

RUN apk add --no-cache curl

WORKDIR /build

# build/ 始终存在（有 .gitkeep），所以这个 COPY 不会因缺少预置包而失败。
COPY build/ /build/prefetched/

RUN set -eux; \
    mkdir -p /build/upstream; \
    if [ -s /build/prefetched/upstream-src.tar.gz ]; then \
      echo 'using prefetched source: build/upstream-src.tar.gz'; \
      tar -xzf /build/prefetched/upstream-src.tar.gz -C /build/upstream --strip-components=1; \
    else \
      url="https://codeload.github.com/${CHAT2API_REPO}/tar.gz/${CHAT2API_REF}"; \
      echo "fetching ${url}"; \
      curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
           --connect-timeout 20 --max-time 600 \
           -o /build/src.tar.gz "$url"; \
      tar -xzf /build/src.tar.gz -C /build/upstream --strip-components=1; \
    fi; \
    test -f /build/upstream/package.json; \
    echo 'source ready'

WORKDIR /build/upstream

RUN set -eux; \
    { \
      printf 'REF=%s\n' "${CHAT2API_REF}"; \
      printf 'FETCHED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
      printf 'VERSION=%s\n' "$(node -p "require('/build/upstream/package.json').version" 2>/dev/null || echo unknown)"; \
    } > /build/UPSTREAM_INFO; \
    cat /build/UPSTREAM_INFO

# --ignore-scripts 跳过上游 postinstall（electron-builder install-app-deps），
# 否则会去下载用不到的 Electron 二进制。
RUN npm install --ignore-scripts --no-audit --no-fund

COPY shim/headless-entry.ts /build/upstream/src/main/headless-entry.ts
COPY shim/patch-vite-config.js /build/patch-vite-config.js

RUN set -eux; \
    node /build/patch-vite-config.js electron.vite.config.ts; \
    echo '--- patched rollupOptions.input:'; \
    sed -n '/main: {/,/preload: {/p' electron.vite.config.ts | sed -n '/input:/,/}/p'

RUN npx electron-vite build

RUN set -eux; \
    test -f out/main/headless.js || { \
      echo 'ERROR: out/main/headless.js 未产出 —— headless 入口没进 bundle'; \
      ls -la out/main; exit 1; }; \
    test -f out/renderer/index.html || { \
      echo 'ERROR: out/renderer/index.html 未产出 —— 前端没编译出来'; \
      ls -la out; exit 1; }; \
    test -f out/preload/index.js || { \
      echo 'ERROR: out/preload/index.js 未产出 —— IPC 桥需要它'; \
      ls -la out; exit 1; }; \
    echo 'main + renderer + preload produced'

COPY shim/prune-deps.js /build/prune-deps.js

RUN set -eux; \
    node /build/prune-deps.js; \
    echo "--- 裁剪后: $(du -sh node_modules | cut -f1), $(ls node_modules | wc -l) 项"

COPY shim/electron-shim.js /build/stage/shim/electron-shim.js
COPY shim/gateway.js /build/stage/shim/gateway.js
COPY shim/entrypoint.sh /build/stage/shim/entrypoint.sh
COPY webui/server.js /build/stage/webui/server.js

RUN set -eux; \
    mkdir -p /build/stage/upstream; \
    cp -r out/main /build/stage/upstream/main; \
    cp -r out/preload /build/stage/upstream/preload; \
    cp -r out/renderer /build/stage/upstream/renderer; \
    cp package.json /build/stage/upstream/package.json; \
    cp sha3_wasm_bg.7b9ca65ddd.wasm /build/stage/upstream/ 2>/dev/null || true; \
    cp -r node_modules /build/stage/node_modules; \
    cp /build/UPSTREAM_INFO /build/stage/UPSTREAM_INFO; \
    \
    mkdir -p /build/stage/node_modules/electron; \
    printf '{"name":"electron","version":"0.0.0-shim","main":"index.js"}\n' \
      > /build/stage/node_modules/electron/package.json; \
    printf "module.exports = require('/app/shim/electron-shim.js');\n" \
      > /build/stage/node_modules/electron/index.js; \
    \
    echo '--- 待复制内容:'; \
    du -sh /build/stage /build/stage/node_modules /build/stage/upstream /build/stage/upstream/renderer

# ---------------------------------------------------------------------------
# 阶段 2：运行时
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

LABEL org.opencontainers.image.title="chat2api" \
      org.opencontainers.image.description="Headless OpenAI-compatible gateway for Chat2API, serving the upstream UI (no Electron/Xvfb)" \
      org.opencontainers.image.source="https://github.com/liangnianzhi/chat2api" \
      org.opencontainers.image.licenses="GPL-3.0"

RUN apk add --no-cache curl tini tzdata su-exec

RUN set -eux; \
    awk -F: 'BEGIN{OFS=":"} $1=="node"{$6="/data"; $7="/sbin/nologin"} {print}' \
        /etc/passwd > /etc/passwd.new; \
    mv /etc/passwd.new /etc/passwd; \
    grep '^node:' /etc/passwd; \
    test "$(awk -F: '$1=="node"{print NF}' /etc/passwd)" = "7"; \
    mkdir -p /data/.chat2api; \
    chown -R node:node /data

WORKDIR /app

COPY --from=builder /build/stage/ /app/

RUN set -eux; \
    chmod +x /app/shim/entrypoint.sh; \
    node -e "const e=require('/app/node_modules/electron'); \
             if(!e.__isShim){console.error('electron 未指向 shim');process.exit(1)}; \
             console.log('electron -> shim 校验通过')"; \
    test -f /app/upstream/main/headless.js; \
    test -f /app/upstream/renderer/index.html; \
    test -f /app/upstream/preload/index.js; \
    test -f /app/webui/server.js; \
    test -f /app/shim/gateway.js; \
    test -x /app/shim/entrypoint.sh; \
    chown -R node:node /app; \
    echo '运行时布局就绪'

ENV NODE_ENV=production \
    HOME=/data \
    CHAT2API_HOME=/data/.chat2api \
    CHAT2API_APP_DIR=/app \
    CHAT2API_SHIM=/app/shim/electron-shim.js \
    CHAT2API_BUNDLE=/app/upstream/main/headless.js \
    CHAT2API_RENDERER_DIR=/app/upstream/renderer \
    CHAT2API_PRELOAD_FILE=/app/upstream/preload/index.js \
    CHAT2API_PORT=8082 \
    CHAT2API_HOST=0.0.0.0 \
    CHAT2API_INTERNAL_PORT=18090 \
    CHAT2API_INTERNAL_HOST=127.0.0.1 \
    CHAT2API_ENABLE_WEBUI=true \
    NODE_OPTIONS=--max-old-space-size=256

VOLUME ["/data"]
EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${CHAT2API_PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/shim/entrypoint.sh"]
CMD ["node", "/app/shim/gateway.js"]
