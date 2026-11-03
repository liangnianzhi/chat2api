# Chat2API 无头网关（含 Web 管理台）
# =============================================================================
# 上游: https://github.com/wxs0625/Chat2API-WXS  (GPL-3.0)
#
# 只对外一个端口 8082，且这是**唯一的端口号**：宿主、界面 Header、管理 API
# 地址、/health 全都报它。代理本来会自己 bind 一个端口，shim 在那个 bind 处
# 把它拦下来（不真正占用），所以不需要第二个端口号。
#
#   GET /              -> 上游原版前端界面（out/renderer）
#   POST /__ipc        -> 把界面的 IPC 调用派发给上游自己的 ipcMain.handle
#   GET  /__login      -> 引导式登录页（容器里无法开 Electron 窗口，见该页面注释）
#   /v1、/health        -> 上游 Koa 应用（OpenAI 兼容 API）
#   /management/*      -> 改写成 /v0/management/* 后转发
#
# 源码获取
# --------
# 从 codeload 下载上游 tarball。（网络受限的环境请用 CI 构建好的镜像。）
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
# 结构化自检：webui/server.js 的 /health 从这里取报告（拿不到就退回极简版）
COPY shim/health.js /build/stage/shim/health.js
COPY shim/entrypoint.sh /build/stage/shim/entrypoint.sh
# 账号健康自愈层（见 shim/selfheal/README 注释在 index.js 顶部）
COPY shim/selfheal.js /build/stage/shim/selfheal.js
COPY shim/selfheal/ /build/stage/shim/selfheal/
# 请求日志可观测性：失败分类 + 上游响应摘要 + 统计分组（见 shim/observability/install.js）
COPY shim/observability/ /build/stage/shim/observability/
COPY webui/server.js /build/stage/webui/server.js
# 访问控制（凭据 / 同源 / Content-Type / 限流 / 审计）
COPY webui/auth.js /build/stage/webui/auth.js
COPY webui/preload-bridge.js /build/stage/webui/preload-bridge.js
COPY webui/login.html /build/stage/webui/login.html
# 访问控制探针：在运行中的容器里可直接跑
#   docker exec chat2api sh /app/tests/auth_probe.sh
COPY tests/auth_probe.sh /build/stage/tests/auth_probe.sh
# 可观测性探针：不用构建镜像也能在运行中的容器里验证安装结果
#   docker exec chat2api sh /app/tests/observability_smoke.sh
COPY tests/observability_smoke.sh /build/stage/tests/observability_smoke.sh

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

# curl 用于健康检查；tini 回收子进程并转发信号；su-exec 用于降权；
# tzdata 提供时区数据（默认时区见下方）。
RUN apk add --no-cache curl tini tzdata su-exec

# ---- 镜像瘦身的固定部分 ------------------------------------------------
# node 官方镜像带着一整套构建/发布工具，headless 网关一个都用不上：
#   /usr/local/lib/node_modules/npm     ~4.6 MB  （运行时只用 node，不用 npm）
#   /usr/local/include/node             ~4.9 MB  （C++ 头文件）
#   /opt/yarn-v1.22.22                  ~5.3 MB  （yarn 发行包）
# 删掉这 ~15 MB，镜像才谈得上接近 README 的体积承诺。
# 镜像里没有任何 C/C++ 扩展需要编译，删除头文件不影响运行。
RUN set -eux; \
    rm -rf /usr/local/lib/node_modules \
           /usr/local/include/node \
           /opt/yarn-v1.22.22 \
           /root/.cache \
           /var/cache/apk/*; \
    ls -d /usr/local/lib/node_modules /opt/yarn* 2>/dev/null || echo "build tooling removed"
# 默认时区 Asia/Shanghai。
# TZ 与 /etc/localtime 都设置：有的程序读环境变量，有的读时区文件。
ENV TZ=Asia/Shanghai
RUN set -eux; \
    ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime; \
    echo "${TZ}" > /etc/timezone; \
    echo "timezone: $(date '+%Z %z')"

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

# 只复制裁剪后的成果：依赖 + 编译产物 + 上游前端 + 自己的辅助页。
COPY --from=builder /build/stage/ /app/

RUN set -eux; \
    chmod +x /app/shim/entrypoint.sh; \
    # 只检查模块引擎定位到的文件内容，不 require()。
    # require() 会把 electron-shim 真正执行一遍，而它会顺手加载上游 bundle、启动代理服务（实测在构建阶段挂住不返回）。
    grep -q "require('/app/shim/electron-shim.js')" /app/node_modules/electron/index.js; \
    grep -q '"main": *"index.js"' /app/node_modules/electron/package.json; \
    test -f /app/upstream/main/headless.js; \
    test -f /app/upstream/renderer/index.html; \
    test -f /app/upstream/preload/index.js; \
    test -f /app/webui/server.js; \
    test -f /app/webui/preload-bridge.js; \
    test -f /app/webui/login.html; \
    test -f /app/shim/gateway.js; \
    test -f /app/shim/health.js; \
    test -f /app/shim/selfheal.js; \
    test -f /app/shim/selfheal/index.js; \
    test -f /app/shim/selfheal/auth-errors.js; \
    test -f /app/shim/observability/install.js; \
    test -f /app/shim/observability/failure-classify.js; \
    test -f /app/shim/observability/request-log.js; \
    test -f /app/shim/observability/stats.js; \
    test -f /app/shim/observability/catalog.js; \
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
    CHAT2API_LOGIN_PAGE=/app/webui/login.html \
    CHAT2API_PORT=8082 \
    CHAT2API_HOST=0.0.0.0 \
    CHAT2API_INTERNAL_PORT=8082 \
    CHAT2API_INTERNAL_HOST=0.0.0.0 \
    CHAT2API_INTERCEPT_PORTS=8082,18090 \
    CHAT2API_ENABLE_WEBUI=true \
    NODE_OPTIONS=--max-old-space-size=256

VOLUME ["/data"]
# 唯一对外端口（也是唯一的端口号）
EXPOSE 8082

# 健康检查读的是 /health 的结构化自检（免鉴权）：只有数据卷不可读写、
# 或代理没有跑起来时才返回非 2xx —— 这两种才是重启能治好的问题。
# 失败时把报告打到容器日志，省得只看一个 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${CHAT2API_PORT}/health" >/dev/null \
        || { curl -sS "http://127.0.0.1:${CHAT2API_PORT}/health" | cut -c1-500; exit 1; }

ENTRYPOINT ["/sbin/tini", "--", "/app/shim/entrypoint.sh"]
CMD ["node", "/app/shim/gateway.js"]
