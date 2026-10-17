# Chat2API 无头网关（Docker 部署）

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑在 Docker 里，
提供 OpenAI 兼容 API 网关，并自带 Web 管理台。

**不需要 Electron、不需要 Chromium、不需要 Xvfb，也不需要图形界面。**

| 项目 | 实测 |
|---|---|
| 镜像体积 | **157 MB** |
| 常驻内存 | **约 55 MB**（网关 + 管理台） |
| 运行内容 | 13.8 MB（依赖裁剪到 3.8 MB） |
| 容器测试 | GitHub Actions（见第六节） |

---

## 一、为什么需要这个方案

上游是一个 **Electron 桌面应用**。它的 OpenAI 兼容代理（Koa）只在 Electron 主进程的
IPC 初始化流程里启动，没有独立服务端入口，也没有官方 Docker 支持。社区教程里的
“服务器部署”实际是用 Windows 远程桌面跑图形界面。

直接在容器里跑 Electron 的传统做法要装 Chromium + Xvfb + 大量系统库：

| 方案 | 镜像大小 | 常驻内存 | 额外依赖 |
|---|---|---|---|
| 无头 Electron + Xvfb | ~1 GB | ~350–500 MB | Chromium、Xvfb、字体、各类 .so |
| **本方案（原生 Node 网关）** | **157 MB** | **~55 MB** | 无 |

对一个纯粹的协议转换网关来说，前者明显不合理。

## 二、实现原理

整个代理层有 92 个源文件，其中**只有 3 个**碰到 Electron：

| 文件 | 用到的 Electron API | 本方案的处理 |
|---|---|---|
| `store/store.ts` | `app`、`safeStorage`、`BrowserWindow` | 以 AES-256-GCM 自建加密，密钥存于数据卷 |
| `proxy/adapters/perplexity.ts` | `net` | 换成 Node 原生 `http`/`https` |
| `proxy/captchaWindow.ts` | `BrowserWindow`、`session` | 仅 Qwen 自动注册用；无头下明确报错 |

因此只要补齐这几个 API，整个代理就能在纯 Node 中运行。具体四步：

### 1. 新增无头入口 `shim/headless-entry.ts`

它直接 `import` 上游的 `storeManager` 与 `ProxyServer`，复刻 GUI 的启动流程
（初始化存储 → 合入环境变量配置 → 启动代理 → 注册优雅退出），并从环境变量读取配置。

> **为什么不能在外面写脚本 require 这两个对象**：上游打包（electron-vite + Rollup）
> 把整个主进程 tree-shake 成**单个 bundle**。由于外部没有任何模块引用
> `storeManager` / `ProxyServer`，Rollup 把这两个导出整个删掉了（实测 bundle 里
> `storeManager` 出现 280 次、`ProxyServer` 类定义存在，但 `exports.*` 里没有它们）。
> 只有新增一个 Rollup 入口，让打包器“看见”这两个引用，才能保留下来。

构建时会：
- 把该文件复制到上游 `src/main/headless-entry.ts`
- 用 `shim/patch-vite-config.js` 在 `electron.vite.config.ts` 的
  `main.build.rollupOptions.input` 中追加 `headless` 入口
  （脚本按大括号配对定位 `input` 对象，避免正则误插到 `output` 里）
- 构建后**强制校验** `out/main/headless.js` 存在，否则构建直接失败

### 2. Electron API 兼容层 `shim/electron-shim.js`

实现代理真正用到的那几个 API：

- **`safeStorage`**：用 AES-256-GCM，密钥持久化在数据卷的
  `data/.chat2api/.safe-storage-key`。**重启后仍能解密**——这点很关键，
  否则上游会把账号判定为损坏并清空（上游 `getEncryptionKey()` 的注释专门警告过这个坑）。
- **`app`**：提供 `getVersion`/`getPath` 等，数据目录跟随 `$HOME`。
- **`net`**：用 Node `http`/`https` 实现，支持 `HTTPS_PROXY`。
- **`BrowserWindow` / `Tray` / `session`**：明确抛错而不是静默失败，
  让 GUI-only 功能（Qwen 验证码窗、托盘）在无头环境下有可诊断的报错。

### 3. 用 shim 替换 `node_modules/electron`

编译产物与 Rollup 拆出的 `chunks/*.js` **都会** `require('electron')`，
而分块位置会随上游重构变化（实测 `chunks/server-*.js`、`chunks/index-*.js`、
`chunks/clashProxy-*.js` 各自都有一处引用）。

所以不去逐个改编译产物，而是**直接替换掉 `node_modules/electron` 这个包**，
这样无论哪个文件、哪个 chunk 调用 `require('electron')`，都会拿到 shim。
对上游后续重构是稳定的拦截点。

### 4. Web 管理台（补上被去掉的图形界面）

上游的账号管理界面**只存在于 Electron 渲染层**，无头构建把它去掉了，
上游只留下 curl 才能用的 `/v0/management/*`。所以本镜像自带一个管理台：

`webui/server.js` 是一个零依赖的 Node HTTP 服务，同源反向代理：

| 路径 | 作用 |
|---|---|
| `GET /` | 管理页面（单文件 HTML，无构建步骤） |
| `/v0/management/*` | 反代到本机网关 |

同源代理省掉了 CORS 配置，管理密钥也不必跨域传递；
代理白名单只放行 `/v0/management/` 与 `/health`，避免变成任意转发器。

`shim/gateway.js` 作为 supervisor 同时拉起网关与管理台：
网关是主进程（退出则容器退出），管理台是尽力而为（挂了不影响 API）。

## 三、快速开始

```bash
git clone https://github.com/liangnianzhi/chat2api.git
cd chat2api

# 1) 准备配置
cp .env.example .env
./manage.sh keygen        # 生成管理密钥
vi .env                   # 把密钥填到 CHAT2API_MANAGEMENT_SECRET

# 2) 启动（首次会构建，GitHub runner 上约 3-5 分钟；NAS 上可能 40 分钟以上）
./manage.sh up

# 3) 查看状态与自测
./manage.sh status
./manage.sh test
```

### 访问入口

| 入口 | 地址 | 用途 |
|---|---|---|
| **Web 管理台** | `http://<主机IP>:8081` | **配置账号、API 密钥、代理参数** |
| OpenAI API | `http://<主机IP>:8080/v1` | 给客户端调用 |

管理台首次打开需要填 `CHAT2API_MANAGEMENT_SECRET` 的值，详见第四节。

### 客户端接入

| 配置项 | 值 |
|---|---|
| Base URL | `http://<主机IP>:8080/v1` |
| API Key | 在管理台「客户端 API 密钥」页生成 |
| 模型名 | 例如 `deepseek-v4-flash`、`GLM-5.3` |

```python
from openai import OpenAI
client = OpenAI(api_key="你的key", base_url="http://192.168.1.10:8080/v1")
print(client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

### ⚠️ 数据卷权限（首次部署必看）

容器以 **uid 1000（`node` 用户）** 运行。宿主的数据卷必须属主为 `1000:1000`，
否则启动会直接失败并报：

```
EACCES: permission denied, mkdir '/data/.chat2api'
```

`./manage.sh up` 已**自动**执行修复；若手工用 `docker compose up`，请先执行一次：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

出问题时可随时用 `./manage.sh fixdata` 修复，再用 `./manage.sh restart` 生效。

> 背景：群晖（Synology）的 btrfs 数据卷挂载带 `noacl,synoacl` 选项，走的是 DSM
> 自有 ACL 模型，而不是标准 POSIX ACL。因此不能只靠目录的 rwx 位，
> 必须让属主 uid 与容器内用户一致。普通 Linux 上没有这个限制，
> 但仍然需要属主匹配。

## 四、使用 Web 管理台

打开 **`http://<主机IP>:8081`**。

### 首次登录

1. 在 `.env` 里设置管理密钥（这就是管理台的登录密码）：

   ```ini
   CHAT2API_MANAGEMENT_SECRET=<用 ./manage.sh keygen 生成>
   ```

2. `./manage.sh up` 启动，浏览器打开 `http://<主机IP>:8081`
3. 把上面那串密钥粘贴进「管理密钥」输入框 → 保存
   （只存在你本机浏览器 localStorage，不会外传）

> 设置了密钥即**自动启用管理 API**，不需要额外开关。

### 能做什么

| 面板 | 作用 |
|---|---|
| 概览 | 代理状态、账号总数/可用数 |
| 添加账号 | 选提供商 → 填 token/cookie → 提交，按提供商给出字段提示 |
| 账号列表 | 查看状态、**校验**凭证、删除 |
| 客户端 API 密钥 | 生成/删除给下游客户端用的 `sk-mgmt-…` 密钥 |
| 代理设置 | 负载均衡策略、日志级别、超时、重试次数 |

账号凭证在写入时即被加密（AES-256-GCM），列表中只显示掩码。

### 取 Token 的常见位置

以 DeepSeek 为例：登录 `chat.deepseek.com` → 开始任意对话 → `F12` →
**Application → Local Storage** → 复制 `userToken`。

管理台里选中提供商会自动提示该家需要哪些字段。

### 也可以继续用管理 API

管理台只是 `/v0/management/*` 的可视化外壳，接口本身照旧可用：

```bash
curl -X POST http://127.0.0.1:8080/v0/management/accounts \
  -H "Authorization: Bearer $CHAT2API_MANAGEMENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"deepseek","name":"main","credentials":{"token":"<token>"}}'
```

**登录方式的限制**：Qwen 的「自动注册 + 验证码窗口」依赖真实浏览器窗口，
无头容器用不了，需手动取 token。其余提供商（DeepSeek / GLM / Kimi / MiniMax /
Perplexity / Mimo）直接填 token/cookie，不受影响。

## 五、日常运维

```bash
./manage.sh up             # 启动（有镜像就直接起）
./manage.sh status         # 容器状态 + /health + 资源占用
./manage.sh logs           # 实时日志
./manage.sh test           # 冒烟测试 API 与管理台
./manage.sh version        # 当前运行的上游版本
./manage.sh backup         # 备份数据卷（含加密密钥）
./manage.sh doctor         # 出问题时一键诊断
./manage.sh keygen         # 生成管理密钥
./manage.sh fixdata        # 修复数据卷属主
./manage.sh shell          # 进入容器

# 构建
./manage.sh build          # 完整构建（可复现）
./manage.sh build-offline  # 离线组装（快，需自备 .build/app-runtime.tgz）
./manage.sh update         # 拉取上游最新代码并完整重建
```

## 六、容器测试与 CI

容器测试跑在 **GitHub Actions** 上，不需要本地或 NAS 环境。

### 工作流

`.github/workflows/ci.yml`：

| 阶段 | 内容 |
|---|---|
| `lint` | `sh -n` 语法检查 + ShellCheck（只看 error 级） |
| 构建 | buildx 构建镜像，启用 GHA 层缓存 |
| 部署验证 | `docker compose config` + **真的用 compose 起一遍**，验证文档里的部署路径 |
| 冒烟测试 | `tests/smoke.sh` 全套功能测试 |
| 发布 | 仅 main 与版本 tag，推送到 GHCR |

触发条件：push 到 main、PR、打 tag、手动触发，以及**每周一次定时构建**。

> 为什么要有定时构建：本方案依赖上游三个“接缝”（`store.ts` 的 Electron 引用、
> vite 配置的 `rollupOptions.input` 结构、启动流程仍在 `ipc/handlers.ts`）。
> 上游更新很快，定时构建能把“上游悄悄改坏了”变成一次失败的任务，
> 而不是部署当天才发现。

### 冒烟测试覆盖

`tests/smoke.sh` 对运行中的容器做端到端验证：

- 网关 `/health` 与 OpenAI 兼容路由
- Web 管理台页面可访问，且代理**拒绝白名单外的路径**
- 管理 API：无密钥 / 错密钥 → 401，正确密钥 → 200
- 添加账号 → 列表可见，且凭证在读取时**已掩码**
- 生成客户端 API 密钥
- AES-256-GCM 加解密往返、密文不含明文、**篡改可检测**
- 加密密钥落在数据卷（这是上游警告过会导致“静默清空所有账号”的失败模式）
- `data.json` 确为密文
- **重启后账号仍在**
- 改环境变量里的密钥后重启，新密钥生效、旧密钥失效
- **镜像体积预算**（防止 1GB 那种回归再次出现）

本地也能跑：

```bash
IMAGE=chat2api-gateway:latest bash tests/smoke.sh
```

### 拉取已发布镜像

```bash
docker pull ghcr.io/liangnianzhi/chat2api:latest
```

## 七、关于上游更新

`.env` 的 `CHAT2API_REF` 控制构建版本：

- `main`（默认）—— 跟随上游最新提交
- `v1.7.16` —— 锁定 release，生产环境更稳

`./manage.sh update` 会重新拉源码、编译、平滑替换容器。

**升级注意**：本方案依赖三个“接缝”，上游大改时可能需要微调：

1. `src/main/store/store.ts` 的 Electron 引用方式
2. `electron.vite.config.ts` 中 `main.build.rollupOptions.input` 的结构
3. 启动流程仍位于 `ipc/handlers.ts`

构建时若 `out/main/headless.js` 未产出，Dockerfile 会**直接失败报警**，
不会静默产出坏镜像。第六节的每周定时构建就是为了尽早发现这类变化。

数据卷 `./data` 与镜像无关，升级不会丢配置和账号。

## 八、数据与安全

- **凭证加密**：AES-256-GCM，密钥在 `./data/.chat2api/.safe-storage-key`。
  **务必备份该文件**，丢失等同于丢失所有账号。
- **端口暴露**：`CHAT2API_BIND=0.0.0.0` 使局域网可访问，此时**建议**在管理台里
  生成客户端 API 密钥；只想本机使用改为 `127.0.0.1`。
- **管理 API**：可直接读写账号，不要暴露到公网。管理台只监听同源的
  `/v0/management/*` 与 `/health`，其它路径一律 404。
- 容器以非 root 用户（`node`，uid 1000）运行。

## 九、目录结构

```
.
├── Dockerfile                      # 主构建路径：多阶段，从源码编译（可复现）
├── .offline.Dockerfile             # 备选：从预编译运行目录组装（快）
├── docker-compose.yml              # 最小化：只管启动参数
├── .env.example                    # 配置模板
├── .dockerignore / .gitignore
├── manage.sh                       # 运维脚本
├── shim/
│   ├── headless-entry.ts           # 无头启动入口（编进上游 bundle）
│   ├── patch-vite-config.js        # 给 electron.vite.config.ts 追加 headless 入口
│   ├── prune-deps.js               # 裁剪 node_modules 到运行时所需（302MB → 3.8MB）
│   ├── install-electron-shim.js    # 用 shim 替换 node_modules/electron
│   ├── electron-shim.js            # Electron API 兼容层
│   └── gateway.js                  # supervisor：装 shim、起网关与管理台
├── webui/
│   ├── index.html                  # 管理台页面（单文件，无构建）
│   └── server.js                   # 零依赖 HTTP 服务 + 管理 API 反向代理
├── tests/
│   └── smoke.sh                    # 容器冒烟测试（CI 与本地通用）
├── .github/workflows/ci.yml        # 构建 + 部署验证 + 冒烟测试 + 发布
└── data/                           # 持久化数据（运行时生成，不入库）
```

## 十、镜像体积与构建方式

### 为什么容易变成 1GB

早先的构建方式有两个问题，导致镜像 **1.01GB**（而实际运行内容只有 13.8MB）：

1. **把整个 `node_modules` 都打进了镜像。** 上游的 `externalizeDepsPlugin` 会把
   绝大多数依赖**内联进 bundle**，运行时磁盘上只需要 exclude 列表里那几个包。
   当时没做裁剪，导致 302MB 依赖进镜像 —— 其中仅 `electron` 一个就 315MB
   （未压缩），此外还有 React、图标库、electron-builder 等前端/打包工具。
2. **在同一阶段里“先装后删”无法减小镜像。** Docker 镜像按层累积，后续层删除文件
   只记录 whiteout 标记，那 500MB 的 `npm install` 层依然留在历史里。

### 现在的做法

改成**两阶段**：在 builder 阶段编译并裁剪，运行时阶段只 `COPY` 裁剪后的结果。

| 项目 | 之前 | 现在 |
|---|---|---|
| 镜像体积 | 1.01 GB | **157 MB** |
| `node_modules` | 302 MB / 245 包 | **3.8 MB / 11 包** |
| 运行内容（/app） | — | 13.8 MB |
| 常驻内存 | — | 约 55 MB（网关 + 管理台） |

裁剪依据是上游 `electron.vite.config.ts` 里 `externalizeDepsPlugin` 的
`exclude` 列表 —— 只有这些包需要留在磁盘上。`shim/prune-deps.js` 会按该列表
递归保留依赖闭包，并在**缺少必需包时直接让构建失败**，避免产出一个启动即崩的镜像。

### 两条构建路径

| 命令 | 说明 | GitHub runner | 群晖 NAS |
|---|---|---|---|
| `./manage.sh build` | **推荐**。多阶段，从上游源码编译，完全可复现 | 3–5 分钟 | 40–60 分钟 |
| `./manage.sh build-offline` | 复用 `.build/app-runtime.tgz`，跳过依赖安装与前端构建 | — | 5–15 分钟 |

`build-offline` 是为低算力宿主准备的。群晖 SA6400（DSM 7.4.1，Docker 24.0.2）
有两个环境限制：

1. **没有 buildx**，只能走 legacy builder，因此 Dockerfile 刻意不使用
   `RUN --mount=type=cache`、`# syntax=` 这类 BuildKit 专有语法。
2. **磁盘 I/O 是瓶颈**。`vmstat` 显示 iowait 常年 13+，另有 24 个容器同时在跑。
   这种负载下 legacy builder 提交较大的层（如 500MB 的 `node_modules`）
   可能耗时数十分钟；跨阶段复制 300MB 目录甚至会长时间无进展。

两条路径产出的运行内容完全一致。要重新生成 `app-runtime.tgz`：
先跑一次 `./manage.sh build`，再按 `.offline.Dockerfile` 头部注释导出。

> 注意：更推荐直接在 GitHub Actions 上构建（第六节），然后 `docker pull` 下来。

## 十一、常见问题

**`/health` 无响应**
`./manage.sh doctor` 看日志。多数是 8080 被占用，改 `.env` 的 `CHAT2API_PORT`。

**容器起来就退出，日志报 `EACCES: mkdir '/data/.chat2api'`**
数据卷属主不对：`./manage.sh fixdata && ./manage.sh restart`。

**管理台提示「管理 API 未启用」**
`.env` 里的 `CHAT2API_MANAGEMENT_SECRET` 为空。填上后重启即可。

**账号加了但调用报 “no available account”**
确认 `credentials` 字段名与当前上游版本一致（用 `/v0/management/providers` 查），
以及账号 `status` 是 `active`。

**构建很慢**
见第十节。优先用 GitHub Actions 构建后 `docker pull`。

## 十二、许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层（shim / Dockerfile / 脚本 / 管理台），
构建时从上游仓库获取源码，镜像中包含编译后的上游代码，
因此**分发镜像时同样受 GPL-3.0 约束**，需保留原始版权声明。

## 十三、实测验证结果

以下指标均在真实环境实测通过（群晖 SA6400 / DSM 7.4.1 / Docker 24.0.2，
以及 GitHub Actions ubuntu-latest）。其中「全新部署」指：只提供一个管理密钥，
其余全部交给管理台配置。

| 验证项 | 结果 |
|---|---|
| **镜像体积** | ✅ **157 MB**（原 1.01 GB） |
| **node_modules** | ✅ **3.8 MB / 11 包**（原 302 MB / 245 包） |
| **常驻内存** | ✅ 约 **55 MB**（网关 + 管理台） |
| 容器启动（无 Electron / Chromium / Xvfb） | ✅ `[gateway] electron shim active` |
| 代理监听 | ✅ `0.0.0.0:8080` |
| 双端口映射 | ✅ `8080 -> 8080`、`8081 -> 8081` |
| 容器健康检查 | ✅ `Health=healthy` |
| `GET /health` | ✅ `{"status":"running",...}` |
| `GET /v1/models` | ✅ `{"object":"list","data":[]}` |
| **Web 管理台页面** | ✅ HTTP 200，标题 `Chat2API 管理台` |
| **管理台同源反代管理 API** | ✅ `/v0/management/*` 正常转发 |
| **仅凭密钥自动启用管理 API** | ✅ 日志 `management API is enabled at /v0/management` |
| **经管理台添加账号** | ✅ 返回 `success:true` |
| **管理台改密钥后重启生效** | ✅ 新密钥可用、旧密钥返回 `invalid_secret` |
| **账号跨容器重启持久化** | ✅ 重启后账号仍在 |
| 数据目录 | ✅ `/data/.chat2api`（挂载卷，非容器内临时路径） |
| 配置落盘加密 | ✅ `data.json` 为密文（上游 electron-store 加密） |
| 凭证加解密往返 | ✅ 加密→解密还原一致 |
| 密文不含明文 | ✅ 通过 |
| 篡改检测（AES-GCM auth tag） | ✅ 能识别被改动的密文 |
| **加密密钥跨重启持久化** | ✅ 重启后仍能解密旧数据 |
| 优雅退出（SIGTERM 落盘） | ✅ `received SIGTERM, shutting down` |

> **「加密密钥跨重启持久化」最要紧**：上游 `store.ts` 的注释专门警告过，
> 如果加密密钥在两次启动之间发生变化，加密的 `data.json` 会被当成损坏数据，
> 触发恢复逻辑并**静默清空所有账号**。本方案把密钥持久化在数据卷上，因此不会踩坑。
