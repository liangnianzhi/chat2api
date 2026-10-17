# 离线组装路径：从一个已编译好的运行目录打包成最终镜像
# =============================================================================
# 这是 Dockerfile 的**快速替代路径**，不是默认构建方式。
#
# 用途：在没有 buildx、磁盘 I/O 又慢的机器（例如群晖 NAS）上，Dockerfile 里的
# `npm install`（约 500MB 层）提交会耗时数十分钟。这个路径直接复用一份已验证
# 的运行目录（.build/app-runtime.tgz），省掉依赖安装与前端构建，几分钟出镜像。
#
# 两者产出的运行内容完全一致：
#   /app/upstream/main/headless.js   编译后的代理（含 Headless 入口）
#   /app/node_modules                裁剪到 11 个包（3.8MB，原 302MB）
#   /app/shim/                       Electron 兼容层 + supervisor
#   /app/webui/                      Web 管理台
#
# 要重新生成 app-runtime.tgz（例如上游更新后）：
#   1) 先跑一次完整构建：
#        ./manage.sh build
#   2) 从构建产物里导出运行目录：
#        docker create --name tmp chat2api-gateway:latest
#        mkdir -p .build/app
#        docker cp tmp:/app/. .build/app/
#        tar czf .build/app-runtime.tgz -C .build/app .
#        docker rm tmp
#
# 注意：.build/app-runtime.tgz 是二进制产物，已在 .gitignore 里排除；
# 想用本路径的人需要自己先产出一份（见上面步骤）。
#
# 平时请优先用 `./manage.sh build`（可复现）。
# =============================================================================

ARG NODE_VERSION=20-alpine
FROM node:${NODE_VERSION}

LABEL org.opencontainers.image.title="Chat2API Gateway" \
      org.opencontainers.image.description="Headless OpenAI-compatible gateway for Chat2API with a web console (no Electron/Xvfb)" \
      org.opencontainers.image.source="https://github.com/liangnianzhi/chat2api" \
      org.opencontainers.image.licenses="GPL-3.0"

# curl 供健康检查使用；tini 回收子进程并转发信号，保证优雅退出。
RUN apk add --no-cache curl tini tzdata

# node 官方镜像已有 uid/gid 1000（node），复用它以免 addgroup -g 1000 冲突。
# Alpine 无 usermod，用 awk 改 /etc/passwd 第 6、7 字段并校验仍为 7 段。
RUN set -eux; \
    awk -F: 'BEGIN{OFS=":"} $1=="node"{$6="/data"; $7="/sbin/nologin"} {print}' \
        /etc/passwd > /etc/passwd.new; \
    mv /etc/passwd.new /etc/passwd; \
    grep '^node:' /etc/passwd; \
    test "$(awk -F: '$1=="node"{print NF}' /etc/passwd)" = "7"

WORKDIR /app

# 已编译好的运行目录
COPY .build/app-runtime.tgz /tmp/app-runtime.tgz

RUN set -eux; \
    mkdir -p /app; \
    tar xzf /tmp/app-runtime.tgz -C /app; \
    rm -f /tmp/app-runtime.tgz; \
    \
    test -f /app/upstream/main/headless.js; \
    test -f /app/webui/server.js; \
    test -f /app/shim/gateway.js; \
    test -f /app/shim/electron-shim.js; \
    \
    node -e "const e=require('/app/node_modules/electron'); \
             if(!e.__isShim){console.error('electron 未指向 shim');process.exit(1)}; \
             console.log('electron -> shim 校验通过')"; \
    \
    echo "--- 运行目录: $(du -sh /app | cut -f1), node_modules $(du -sh /app/node_modules | cut -f1)"; \
    \
    mkdir -p /data/.chat2api; \
    chown -R node:node /data /app; \
    echo 'layout ready'

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

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${CHAT2API_PORT}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/shim/gateway.js"]
