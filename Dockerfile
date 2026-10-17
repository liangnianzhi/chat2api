# Chat2API 无头网关（含 Web 管理台）
# =============================================================================
# 上游: https://github.com/wxs0625/Chat2API-WXS  (GPL-3.0)
#
# 只对外一个端口 8082：
#   GET /              -> 上游原版前端界面（out/renderer）
#   POST /__ipc        -> 把界面的 IPC 调用派发给上游自己的 ipcMain.handle
#   /v1、/health        -> 转发给网关
#   /management/*      -> 改写成 /v0/management/* 后转发
#
# CHAT2API_INTERNAL_PORT 是容器内网关自身的监听地址，**不会发布到宿主**。
# 之所以需要它：上游 ProxyServer 只能绑定一个监听端口，而 8082 必须由前端
# 服务占用（界面 + IPC 桥）。所以内部拆成两段，宿主只看见 8082。
#
# 源码获取
# --------
# 从 codeload 下载上游 tarball。（网络受限的环境请用 CI 构建好的 GHCR 镜像。）
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

RUN set -eux; \
    url="https://codeload.github.com/${CHAT2API_REPO}/tar.gz/${CHAT2API_REF}"; \
    echo "fetching ${url}"; \
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
         --connect-timeout 20 --max-time 600 \
         -o /build/src.tar.gz "$url"; \
    mkdir -p /build/upstream; \
    tar -xzf /build/src.tar.gz -C /build/upstream --strip-components=1; \
    test -f /build/upstream/package.json; \
    echo "source extracted"

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

# 把 node_modules 裁到运行时真正需要的那几个包。
COPY shim/prune-deps.js /build/prune-deps.js

RUN set -eux; \
    node /build/prune-deps.js; \
    echo "--- 裁剪后: $(du -sh node_modules | cut -f1), $(ls node_modules | wc -l) 项"

# 组装一个干净的运行目录，供下阶段整体 COPY。
COPY shim/electron-shim.js /build/stage/shim/electron-shim.js
COPY shim/gateway.js /build/stage/shim/gateway.js
COPY shim/entrypoint.sh /build/stage/shim/entrypoint.sh
COPY webui/server.js /build/stage/webui/server.js
COPY webui/preload-bridge.js /build/stage/webui/preload-bridge.js

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

# curl 用于健康检查；tini 回收子进程并转发信号；su-exec 用于降权。
RUN apk add --no-cache curl tini tzdata su-exec

# node 官方镜像已有 uid/gid 1000（node），复用它以免 addgroup -g 1000 冲突。
# Alpine 无 usermod，用 awk 改 /etc/passwd 第 6、7 字段并校验仍是 7 段。
RUN set -eux; \
    awk -F: 'BEGIN{OFS=":"} $1=="node"{$6="/data"; $7="/sbin/nologin"} {print}' \
        /etc/passwd > /etc/passwd.new; \
    mv /etc/passwd.new /etc/passwd; \
    grep '^node:' /etc/passwd; \
    test "$(awk -F: '$1=="node"{print NF}' /etc/passwd)" = "7"; \
    mkdir -p /data/.chat2api; \
    chown -R node:node /data

WORKDIR /app

# 只复制裁剪后的成果：依赖 + 编译产物 + 上游前端。
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
    test -f /app/webui/preload-bridge.js; \
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
    CHAT2API_BRIDGE_FILE=/app/webui/preload-bridge.js \
    CHAT2API_PORT=8082 \
    CHAT2API_HOST=0.0.0.0 \
    CHAT2API_INTERNAL_PORT=18090 \
    CHAT2API_INTERNAL_HOST=127.0.0.1 \
    CHAT2API_ENABLE_WEBUI=true \
    NODE_OPTIONS=--max-old-space-size=256

VOLUME ["/data"]
# 唯一对外端口。CHAT2API_INTERNAL_PORT 只在容器内使用，不在此暴露。
EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${CHAT2API_PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/shim/entrypoint.sh"]
CMD ["node", "/app/shim/gateway.js"]
