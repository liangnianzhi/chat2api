# Chat2API 无头网关（含 Web 管理台）
# =============================================================================
# 上游: https://github.com/wxs0625/Chat2API-WXS  (GPL-3.0)
#
# 这个镜像做什么
# --------------
# 上游是 Electron 桌面应用：OpenAI 兼容代理只在 GUI 的 IPC 初始化里启动，
# 账号管理界面也只存在于 Electron 渲染层。本镜像把同一套代理代码跑在纯
# Node.js 里（无 Chromium / 无 Xvfb），并自带一个轻量 Web 管理台补齐界面。
#
# 三个关键机制
# ------------
# 1. shim/headless-entry.ts —— 作为额外的 Rollup 入口编进上游 bundle。
#    上游打包会把主进程 tree-shake 成单个 bundle，外部没人引用的导出
#    （storeManager / ProxyServer）会被整个删掉；新增入口让打包器"看见"它们。
#
# 2. shim/electron-shim.js —— 实现代理真正用到的 Electron API：
#    safeStorage（AES-256-GCM）、app、net、process.resourcesPath；
#    GUI-only 功能（验证码窗、托盘）明确抛错而非静默失败。
#
# 3. 用 shim 替换 node_modules/electron —— 编译产物和 Rollup 拆出的
#    chunks/*.js 都会 require('electron')，且分块位置随上游重构变化，
#    替换包是唯一稳定的拦截点。
#
# 为什么必须分两个阶段
# --------------------
# `npm install` 会产生约 500MB 的层。若在同一阶段里事后删除无用依赖，
# 那些文件仍留在镜像历史中（后续层只记录 whiteout 标记），最终镜像仍是
# 600MB 左右。只有把裁剪放在 builder 阶段、再 COPY 裁剪后的结果，
# 才能让死重不进最终镜像。
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
    echo 'headless bundle produced'

# 把 node_modules 裁到运行时真正需要的那几个包。
COPY shim/prune-deps.js /build/prune-deps.js

RUN set -eux; \
    node /build/prune-deps.js; \
    echo "--- 裁剪后: $(du -sh node_modules | cut -f1), $(ls node_modules | wc -l) 项"

# 组装一个干净的运行目录，供下阶段整体 COPY。
COPY shim/electron-shim.js /build/stage/shim/electron-shim.js
COPY shim/gateway.js /build/stage/shim/gateway.js
COPY shim/entrypoint.sh /build/stage/shim/entrypoint.sh
COPY webui/ /build/stage/webui/

RUN set -eux; \
    mkdir -p /build/stage/upstream; \
    cp -r out/main /build/stage/upstream/main; \
    cp -r out/preload /build/stage/upstream/preload; \
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
    du -sh /build/stage /build/stage/node_modules /build/stage/upstream

# ---------------------------------------------------------------------------
# 阶段 2：运行时
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

LABEL org.opencontainers.image.title="chat2api" \
      org.opencontainers.image.description="Headless OpenAI-compatible gateway for Chat2API with a web console (no Electron/Xvfb)" \
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

# 只复制裁剪后的成果：约 4MB 依赖 + 9MB 编译产物 + 20KB 界面。
COPY --from=builder /build/stage/ /app/

RUN set -eux; \
    chmod +x /app/shim/entrypoint.sh; \
    node -e "const e=require('/app/node_modules/electron'); \
             if(!e.__isShim){console.error('electron 未指向 shim');process.exit(1)}; \
             console.log('electron -> shim 校验通过')"; \
    test -f /app/upstream/main/headless.js; \
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
    CHAT2API_PORT=8080 \
    CHAT2API_HOST=0.0.0.0 \
    CHAT2API_UI_PORT=8081 \
    CHAT2API_ENABLE_WEBUI=true \
    NODE_OPTIONS=--max-old-space-size=256

VOLUME ["/data"]
EXPOSE 8080 8081

# 不写 USER：entrypoint.sh 以 root 启动，先修正数据卷属主，再降权到 node 运行。
# ENTRYPOINT 必须包含 entrypoint.sh，否则脚本根本不会被执行（CMD 只是它的参数）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${CHAT2API_PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/shim/entrypoint.sh"]
CMD ["node", "/app/shim/gateway.js"]
