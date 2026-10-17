# chat2api

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑成 Docker 容器：
OpenAI 兼容 API 网关 + Web 管理台，**不需要 Electron、不需要 Chromium、不需要 Xvfb**。

镜像由 GitHub Actions 构建并发布：`ghcr.io/liangnianzhi/chat2api:latest`

| 项目 | 实测 |
|---|---|
| 镜像体积 | ~157 MB |
| 常驻内存 | ~55 MB |
| 配置 | **零配置**：没有 .env，不需要任何密钥 |

---

## 快速开始

```bash
mkdir -p data
docker compose up -d
```

浏览器打开 **`http://<主机IP>:8081`** —— 直接就是管理台，没有登录页。

就这三步。整个部署状态只有 `docker-compose.yml` 和 `data/` 两样东西。

> 镜像默认是**私有**包，第一次拉取前需要先 `docker login ghcr.io`，
> 或者在 GitHub 的 Packages 设置里把它改成 Public。

## 访问入口

| 入口 | 地址 | 用途 |
|---|---|---|
| **Web 管理台** | `http://<主机IP>:8081` | 配账号、API 密钥、代理参数 |
| OpenAI API | `http://<主机IP>:8080/v1` | 给客户端调用 |

客户端接入：

```python
from openai import OpenAI
client = OpenAI(
    api_key="在管理台里生成的密钥",
    base_url="http://192.168.1.10:8080/v1",
)
print(client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

## 管理台能做什么

| 面板 | 作用 |
|---|---|
| 概览 | 代理状态、账号总数/可用数 |
| 添加账号 | 选提供商 → 填 token/cookie，按提供商给出字段提示 |
| 账号列表 | 查看状态、校验凭证、删除 |
| 客户端 API 密钥 | 生成/删除给下游客户端用的 `sk-mgmt-…` 密钥 |
| 代理设置 | 负载均衡策略、日志级别、超时、重试次数 |

账号凭证写入时即加密（AES-256-GCM），列表中只显示掩码。

**取 Token**：以 DeepSeek 为例，登录 `chat.deepseek.com` → 开始任意对话 →
`F12` → **Application → Local Storage** → 复制 `userToken`。

**限制**：Qwen 的「自动注册 + 验证码窗口」依赖真实浏览器窗口，无头容器用不了，
需手动取 token。其余提供商（DeepSeek / GLM / Kimi / MiniMax / Perplexity / Mimo）
直接填 token/cookie，不受影响。

## 关于「管理密钥」：为什么没有登录页，API 却还是要它

上游的管理 API 强制要求一个密钥。这个密钥的唯一用途是保护
`/v0/management/*`，而管理台正是它唯一的客户端。

于是这样处理：

- 首次启动**自动生成**一个随机密钥，存进 `data/.chat2api/`（权限 600）
- 管理台（反向代理）每次请求时**在服务端附上**它
- 所以浏览器**不需要**登录，也不需要你看过这个密钥

但如果你**直连 8080** 调用管理 API，仍然需要它：

```bash
# 查看（只有你自己有文件权限）
docker compose exec chat2api cat /data/.chat2api/.management-secret

# 然后可用它调管理 API
curl -H "Authorization: Bearer $(docker compose exec -T chat2api cat /data/.chat2api/.management-secret)" \
  http://127.0.0.1:8080/v0/management/accounts
```

这样管理台开着就能用，而 API 端口不必裸奔。如果你连这层也不想要，
直接不发布 8080 端口即可（只在 compose 里保留 8081）。

> 想指定自己的密钥：在 compose 里加 `environment: { CHAT2API_MANAGEMENT_SECRET: xxx }`，
> 环境变量优先于自动生成的值。

## 常用命令

```bash
docker compose pull          # 拉取最新镜像
docker compose up -d         # 启动 / 应用变更
docker compose restart       # 重启
docker compose down          # 停止
docker compose logs -f       # 跟踪日志
docker compose exec chat2api cat /app/UPSTREAM_INFO   # 当前上游版本

# 备份（含账号、配置、凭证加密密钥）
tar czf chat2api-data-$(date +%Y%m%d).tar.gz data
```

升级：`docker compose pull && docker compose up -d`。数据卷与镜像无关，不会丢账号。

**备份 `data/` 是唯一需要在意的事** —— 里面的 `.safe-storage-key` 是凭证加密密钥，
丢了等于全部账号作废。

## 数据卷权限

**不需要手工 chown。** 容器启动时以 root 修正 `/data` 属主，然后降权到 uid 1000
运行主进程（见 `shim/entrypoint.sh`）。

所以宿主的 `mkdir -p data` 用任何用户都行。

> 背景：群晖（Synology）的 btrfs 数据卷挂载带 `noacl,synoacl` 选项，走 DSM 自有 ACL，
> 光靠 rwx 位不够，必须属主 uid 与容器内用户一致。把这一步放进 entrypoint
> 比要求每个部署者记得敲 `chown 1000:1000` 更可靠。

## 实现原理

上游是个 Electron 桌面应用：代理只在 GUI 的 IPC 初始化里启动，账号管理界面只存在于
渲染层。整个代理层 92 个源文件里**只有 3 个**碰 Electron：

| 文件 | 用到的 API | 处理 |
|---|---|---|
| `store/store.ts` | `app`、`safeStorage`、`BrowserWindow` | AES-256-GCM 自建加密，密钥存数据卷 |
| `proxy/adapters/perplexity.ts` | `net` | 换成 Node 原生 http/https |
| `proxy/captchaWindow.ts` | `BrowserWindow`、`session` | 仅 Qwen 自动注册用，无头下明确报错 |

补齐这几个 API，整个代理就能在纯 Node 里跑。四个关键点：

**1. 新增无头入口 `shim/headless-entry.ts`**

它直接 `import` 上游的 `storeManager` 与 `ProxyServer`，复刻 GUI 的启动流程。

> 为什么不能在外面写脚本 require：上游打包把主进程 tree-shake 成**单个 bundle**，
> 外部没人引用的导出会被整个删掉（实测 `storeManager` 出现 280 次，
> 但 `exports.*` 里没有它）。加一个 Rollup 入口让打包器「看见」引用才能保留。

**2. Electron 兼容层 `shim/electron-shim.js`**

- `safeStorage`：AES-256-GCM，密钥持久化在数据卷。**重启后必须仍能解密** ——
  上游注释专门警告过，密钥一变，加密的 `data.json` 会被当成损坏并**静默清空所有账号**。
- `process.resourcesPath`：Electron 专有属性，纯 Node 下是 `undefined`。编译后的代码用它
  定位 sha3 wasm（DeepSeek/GLM 请求签名）：

  ```js
  app.isPackaged ? path.join(process.resourcesPath, "sha3_wasm_bg...wasm") : ...
  ```

  不补的话 `path.join(undefined, ...)` 直接抛 TypeError，**首个真实 DeepSeek/GLM
  请求就会失败**。冒烟测试专门盯着这一项。
- `net`：Node `http`/`https`，支持 `HTTPS_PROXY`。
- `BrowserWindow` / `Tray` / `session`：明确抛错而非静默失败。

**3. 用 shim 替换 `node_modules/electron`**

编译产物和 Rollup 拆出的 `chunks/*.js` 都会 `require('electron')`，且分块位置会随上游
重构变化。改编译产物需要每次重新验证；换包是一次性拦截所有调用点。

**4. Web 管理台**

`webui/server.js` 是一个零依赖 HTTP 服务：`GET /` 返回页面，`/v0/management/*` 同源反代理
并注入密钥。白名单只放行 `/v0/management/` 与 `/health`，不会变成任意转发器。
`shim/gateway.js` 作为 supervisor 同时拉起网关与管理台。

## 上游更新与 CI

镜像由 `.github/workflows/ci.yml` 构建，流程：

```
lint → 构建镜像 → 校验 compose → 真实 compose up → 冒烟测试 → 推送 GHCR
```

触发：push、PR、tag、手动，外加**每周一次定时构建**。

> 为什么要定时构建：本方案依赖上游三个「接缝」——`store.ts` 的 Electron 引用、
> vite 配置的 `rollupOptions.input` 结构、启动流程仍在 `ipc/handlers.ts`。
> 上游更新很快，定时构建能把「上游悄悄改坏了」变成一次失败的任务，
> 而不是你某天 pull 到最新版才发现。

冒烟测试（`tests/smoke.sh`）覆盖：

- 无头运行、镜像内无 Chromium/Xvfb、主进程已降权到 uid 1000
- 数据卷属主故意设错，验证 entrypoint 能自愈
- **wasm 路径可解析**（否则首个 DeepSeek/GLM 请求会挂）
- 网关 `/health` 与 OpenAI 兼容路由
- **管理台无任何凭据即返回 200**（服务端注入了密钥）、页面无登录框
- **直连 8080 无凭据仍 401**，带密钥 200（会从容器里读出密钥来验）
- 管理台代理白名单：`/v1/models` → 404
- 添加账号 → 列表可见、凭证已掩码；生成客户端 API 密钥
- AES-GCM 加解密往返、密文不含明文、篡改可检测
- 加密密钥与管理密钥均持久化在数据卷；`data.json` 为密文
- **重启后账号与密钥均不变**
- 镜像体积预算（防止 1GB 那种回归）

本地也能跑：

```bash
IMAGE=ghcr.io/liangnianzhi/chat2api:latest bash tests/smoke.sh
```

上游版本通过 `.github/workflows/ci.yml` 里的 `CHAT2API_REF` 控制（默认 `main`，
可改为 `v1.7.16` 之类锁定）。构建时若 `out/main/headless.js` 未产出，
Dockerfile 会**直接失败报警**，不会静默产出坏镜像。

## 目录结构

```
.
├── docker-compose.yml          # 全部部署配置（8 行）
├── Dockerfile                  # CI 用的多阶段构建
├── .offline.Dockerfile         # 备选：从预编译目录组装（低算力宿主）
├── shim/
│   ├── headless-entry.ts       # 无头启动入口（编进上游 bundle）
│   ├── patch-vite-config.js    # 给 vite 配置追加 headless 入口
│   ├── prune-deps.js           # 裁剪 node_modules（302MB → 3.8MB）
│   ├── electron-shim.js        # Electron API 兼容层
│   ├── entrypoint.sh           # 修正数据卷属主后降权运行
│   └── gateway.js              # supervisor：起网关与管理台
├── webui/
│   ├── index.html              # 管理台页面（单文件）
│   └── server.js               # 零依赖 HTTP 服务 + 管理 API 反代理
├── tests/smoke.sh
└── .github/workflows/ci.yml
```

运行时的 `data/`（账号、配置、日志、两个密钥）不在仓库里。

## 镜像体积

早先的构建方式得到 **1.01GB** 的镜像（实际运行内容只有 13.8MB），原因有两个：

1. 把整个 `node_modules` 打进去了。上游的 `externalizeDepsPlugin` 会把绝大多数依赖
   **内联进 bundle**，磁盘上只需要 exclude 列表里那几个包。当时没裁剪，302MB 依赖全进
   镜像，其中仅 `electron` 一个就 315MB（未压缩）。
2. 在同一阶段里「先装后删」不减小镜像。镜像按层累积，后续层删除只记 whiteout 标记，
   那 500MB 的 `npm install` 层依然留在历史里。

改成两阶段（builder 里编译+裁剪，运行时只 `COPY` 结果）后：

| 项目 | 之前 | 现在 |
|---|---|---|
| 镜像体积 | 1.01 GB | **~157 MB** |
| `node_modules` | 302 MB / 245 包 | **3.8 MB / 11 包** |
| 常驻内存 | — | ~55 MB |

裁剪依据是上游 `electron.vite.config.ts` 里 `externalizeDepsPlugin` 的 `exclude` 列表；
`shim/prune-deps.js` 按该列表递归保留依赖闭包，并在**缺包时让构建失败**。

## 常见问题

**拉取镜像 403 / denied**
GHCR 包默认私有。在 Packages → chat2api → Package settings 改为 Public，或先 `docker login ghcr.io`。

**8081 打不开**
`docker compose logs` 看日志。确认端口没被占用；管理台是容器内 8081。

**`/health` 正常但调用报错**
先去管理台「账号列表」点「校验」。若是 DeepSeek/GLM 报签名相关错误，
说明镜像太旧（缺 `process.resourcesPath` 修复），`docker compose pull` 更新。

**想改端口**
改 `docker-compose.yml` 里 `ports` 左侧即可，然后 `docker compose up -d`。

## 许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层（shim / Dockerfile / 管理台），
构建时从上游获取源码，镜像中包含编译后的上游代码，
因此**分发镜像时同样受 GPL-3.0 约束**，需保留原始版权声明。
