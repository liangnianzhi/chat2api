# chat2api

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑成 Docker 容器：
**上游原版界面** + OpenAI 兼容 API 网关，全部跑在一个端口上，
**不需要 Electron、不需要 Chromium、不需要 Xvfb**。

镜像由 GitHub Actions 构建并发布：`ghcr.io/liangnianzhi/chat2api:latest`

| 项目 | 实测 |
|---|---|
| 镜像体积 | ~160 MB |
| 常驻内存 | ~55 MB |
| 端口 | **只要一个 8080**（界面 + API 共用，和桌面版一致） |
| 界面 | **上游自己编译出来的前端**（不是重画的） |
| 配置 | **零配置**：没有 .env，不需要任何密钥 |

---

## 快速开始

```bash
mkdir -p data
docker compose up -d
```

浏览器打开 **`http://<主机IP>:8080`** —— 就是上游那个界面。

就这三步。整个部署状态只有 `docker-compose.yml` 和 `data/` 两样东西。

> 镜像默认是**私有**包，第一次拉取前需要先 `docker login ghcr.io`，
> 或者在 GitHub 的 Packages 设置里把它改成 Public。

## 一个端口上的三种东西

| 路径 | 作用 |
|---|---|
| `GET /` | 上游原版界面 |
| `/v1/*` | OpenAI 兼容 API（给客户端调用） |
| `/v0/management/*` | 管理 API |
| `/health` | 健康检查 |

容器内部，网关只监听 `127.0.0.1:18080`，对外的单一入口是前端服务。
所以宿主上只有一个端口需要发布。

### 客户端接入

```python
from openai import OpenAI
client = OpenAI(
    api_key="在界面里生成的密钥",
    base_url="http://192.168.1.10:8080/v1",
)
print(client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

## 界面：为什么是上游原版

上游的界面和全部交互逻辑本来就已经存在，重画一遍只会多一份需要跟着上游同步的代码。
所以这里**直接把上游编译出来的前端（`out/renderer`）发出去**，把它的 IPC 调用接到
**上游自己的 `ipcMain.handle` 实现**上。

三条链路：

```
浏览器                     前端服务（容器内）                 网关进程
  │                              │                              │
  │ GET /                        │ 发 out/renderer/index.html   │
  │                              │ 注入 <base> + preload 桥       │
  │ POST /__ipc {channel,args} ──┼──► 派发 ─────────────────────► ipcMain.handle 注册表
  │ ◄── SSE /__ipc/events ───────┼──◄── webContents.send 事件 ────┤
```

- **`/__preload.js` 是上游自己的 preload 产物**，外面包了一层 `require` 垫片让它能
  在浏览器里跑。它照旧调用 `contextBridge.exposeInMainWorld('electronAPI', ...)`，
  所以 `window.electronAPI` 的形状、channel 名全部与上游一致，
  没有任何手写的 channel 名单需要维护。
- **shim 把 `ipcMain.handle` 登记下来**而不是当空函数。上游约 150 个 channel
  就这么原样可用。
- **事件走 SSE**：`webContents.send` 被接到事件总线上，所以代理状态、
  配置变更、OAuth 进度都能到页面。
- **`shell.openExternal` 变成新标签页**：外部链接（OAuth、文档）由浏览器打开。

因为前端服务要和网关**同进程**（注册表在那边），它由 supervisor `require` 进来，
而不是单独起一个进程。

如果上游某次改动导致这些处理器无法在无头下初始化，容器会**自动降级**到内置的
轻量控制台（`/_ui/health` 会显示 `"ui":"fallback"`），API 始终可用。

## 无头环境下仍不可用的功能

只有 Qwen 的**风控验证码窗**（`captchaWindow.ts`）真正依赖浏览器内核。它做的事是：

1. 用**容器内的持久会话**载入风控 "punish" 页面
2. 用 `executeJavaScript` 在页面里探测滑块、自动拖动、判断是否通过
3. 通过后从**该会话**里取回刷新的 qwen.ai cookie（含 WAF 信任 cookie）并写回账号

关键是第 1 和第 3 步：cookie 在**容器内的会话**里，不在你的浏览器里。
所以「另开一个标签页」只能完成第 2 步 —— 你能解滑块，但容器拿不到结果。

**实际可行的做法**（不需要额外成本）：

1. 在界面里点该账号的验证入口，把 punish 链接在新标签页打开
2. 手动完成滑块
3. 在该页控制台执行 `copy(document.cookie)`，把结果粘回界面
4. 容器把 cookie 合并进账号并重试那笔请求

**想完全自动化**则需要在镜像里放一个真正的无头浏览器（Playwright/Chromium），
体积会从 ~160MB 涨到 500MB 以上 —— 与这个项目的初衷相背。
其余提供商（DeepSeek / GLM / Kimi / MiniMax / Perplexity / Mimo）都是直接填
token/cookie，不受影响。

## ⚠️ 一个端口带来的取舍

上游的管理 API 需要一个密钥，否则根本不会启用。界面是它唯一的客户端，
所以容器启动时**自动生成**一个密钥、存进 `data/.chat2api/`（权限 600），
由前端服务在转发时**在服务端附上**——因此打开网页不需要登录。

代价是：既然界面和 API 共用一个端口，**能访问到这个端口的人就能管理账号**。
对自用、局域网内的场景这是有意的取舍；如果你改变主意：

```yaml
# 只绑定到本机
ports:
  - "127.0.0.1:8080:8080"
```

若需要直连管理 API（例如写脚本），可从容器里取密钥：

```bash
docker compose exec chat2api cat /data/.chat2api/.management-secret
```

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
运行主进程（见 `shim/entrypoint.sh`）。所以宿主的 `mkdir -p data` 用任何用户都行。

> 背景：群晖（Synology）的 btrfs 数据卷挂载带 `noacl,synoacl` 选项，走 DSM 自有 ACL，
> 光靠 rwx 位不够，必须属主 uid 与容器内用户一致。

## 实现原理

上游是 Electron 桌面应用：代理在 GUI 的 IPC 初始化里启动，界面只存在于渲染层。
下文只说代理部分（界面部分见上一节）。

整个代理层 92 个源文件里**只有 3 个**碰 Electron：

| 文件 | 用到的 API | 处理 |
|---|---|---|
| `store/store.ts` | `app`、`safeStorage`、`BrowserWindow` | AES-256-GCM 自建加密，密钥存数据卷 |
| `proxy/adapters/perplexity.ts` | `net` | 换成 Node 原生 http/https |
| `proxy/captchaWindow.ts` | `BrowserWindow`、`session` | 仅 Qwen 风控验证用，无头下明确报错 |

**1. 新增无头入口 `shim/headless-entry.ts`**

它直接 `import` 上游的 `storeManager`、`ProxyServer`、`registerIpcHandlers`。

> 为什么不能在外面写脚本 require：上游打包把主进程 tree-shake 成**单个 bundle**，
> 外部没人引用的导出会被整个删掉。加一个 Rollup 入口让打包器「看见」引用才能保留。

**2. Electron 兼容层 `shim/electron-shim.js`**

- `safeStorage`：AES-256-GCM。**重启后必须仍能解密** —— 上游注释专门警告过，
  密钥一变，加密的 `data.json` 会被当成损坏并**静默清空所有账号**。
- `process.resourcesPath`：Electron 专有属性，纯 Node 下是 `undefined`。编译后的代码用它
  定位 sha3 wasm（DeepSeek/GLM 请求签名）：

  ```js
  app.isPackaged ? path.join(process.resourcesPath, "sha3_wasm_bg...wasm") : ...
  ```

  不补的话 `path.join(undefined, ...)` 直接抛 TypeError，**首个真实 DeepSeek/GLM
  请求就会失败**。冒烟测试专门盯着这一项。
- `ipcMain`：登记而不是空实现（界面桥的基础）。
- `BrowserWindow`：构造仍抛错（无头下无意义），但 `getAllWindows()` 返回一个桩，
  让上游的广播循环能到达事件总线。
- `Tray` / `Menu` / `nativeImage`：**惰性空实现**而不是抛错 ——
  `registerIpcHandlers` 会在代理启停时调用 `TrayManager.updateProxyStatus()`，
  抛错会弄坏界面自己的按钮。
- `net`：Node `http`/`https`，支持 `HTTPS_PROXY`。

**3. 用 shim 替换 `node_modules/electron`**

编译产物和 Rollup 拆出的 `chunks/*.js` 都会 `require('electron')`，且分块位置会随上游
重构变化。改编译产物需要每次重新验证；换包是一次性拦截所有调用点。

**4. 单一入口 `webui/server.js`**

一个零依赖 HTTP 服务拥有唯一对外端口：发上游前端、桥接 IPC 与事件、
把 `/v1`、`/v0`、`/health` 反代到回环网关，并在转发 `/v0/management/*` 时附上密钥。

## 上游更新与 CI

镜像由 `.github/workflows/ci.yml` 构建：

```
lint → 构建镜像 → 校验 compose → 真实 compose up → 冒烟测试 → 推送 GHCR
```

触发：push、PR、tag、手动，外加**每周一次定时构建**。

> 为什么要定时构建：本方案依赖上游若干内部结构（`store.ts` 的 Electron 引用、
vite 配置的 `rollupOptions.input` 结构、`ipc/handlers.ts` 的注册方式、
preload 的输出格式）。上游更新很快，定时构建能把「上游悄悄改坏了」变成一次
失败的任务，而不是你某天 pull 到最新版才发现。

冒烟测试（`tests/smoke.sh`）覆盖：

- 无头运行、单端口布局、网关只绑回环、镜像内无 Chromium/Xvfb
- 数据卷属主故意设错，验证 entrypoint 能自愈；主进程已降权到 uid 1000
- **wasm 路径可解析**（否则首个 DeepSeek/GLM 请求会挂）
- **前端来自上游 `out/renderer`**、IPC 处理器已登记（>100 个 channel）、
  页面注入了 preload 桥、静态资源可访问、`/__ipc` 能派发真实 channel
- 同一端口上：`/v1/models`、`/v0/management/*`、`/health`
- 添加账号 → 列表可见、凭证已掩码；生成客户端 API 密钥
- AES-GCM 加解密往返、密文不含明文、篡改可检测
- 加密密钥与管理密钥均持久化在数据卷；`data.json` 为密文
- **重启后账号与密钥均不变**
- 镜像体积预算

本地也能跑：

```bash
IMAGE=ghcr.io/liangnianzhi/chat2api:latest bash tests/smoke.sh
```

上游版本通过 `.github/workflows/ci.yml` 里的 `CHAT2API_REF` 控制（默认 `main`，
可改为 `v1.7.16` 之类锁定）。构建时若 `out/main/headless.js`、`out/renderer/index.html`
或 `out/preload/index.js` 任一未产出，Dockerfile 会**直接失败报警**。

## 目录结构

```
.
├── docker-compose.yml          # 全部部署配置
├── Dockerfile                  # CI 用的多阶段构建
├── .offline.Dockerfile         # 备选：从预编译目录组装（低算力宿主）
├── shim/
│   ├── headless-entry.ts       # 无头启动入口（编进上游 bundle）
│   ├── patch-vite-config.js    # 给 vite 配置追加 headless 入口
│   ├── prune-deps.js           # 裁剪 node_modules
│   ├── electron-shim.js        # Electron 兼容层 + IPC 登记 + 事件总线
│   ├── entrypoint.sh           # 修正数据卷属主后降权运行
│   └── gateway.js              # supervisor：装 shim、起网关与前端服务
├── webui/
│   ├── server.js               # 唯一对外端口：上游前端 + IPC 桥 + 反向代理
│   └── index.html              # 降级控制台（上游界面不可用时才发）
├── tests/smoke.sh
└── .github/workflows/ci.yml
```

运行时的 `data/`（账号、配置、日志、两个密钥）不在仓库里。

## 镜像体积

早先的构建方式得到 **1.01GB** 的镜像（实际运行内容只有 13.8MB），原因有两个：

1. 把整个 `node_modules` 打进去了。上游的 `externalizeDepsPlugin` 会把绝大多数依赖
   **内联进 bundle**，磁盘上只需要 exclude 列表里那几个包。当时没裁剪，302MB 依赖全进
   镜像，其中仅 `electron` 一个就 315MB（未压缩）。
2. 在同一阶段里「先装后删」不减小镜像。镜像按层累积，后续层删除只记 whiteout 标记。

改成两阶段（builder 里编译+裁剪，运行时只 `COPY` 结果）后：

| 项目 | 之前 | 现在 |
|---|---|---|
| 镜像体积 | 1.01 GB | **~160 MB** |
| `node_modules` | 302 MB / 245 包 | 几 MB |
| 常驻内存 | — | ~55 MB |

裁剪依据是上游 `electron.vite.config.ts` 里 `externalizeDepsPlugin` 的 `exclude` 列表；
`shim/prune-deps.js` 按该列表递归保留依赖闭包，并在**缺包时让构建失败**。

## 常见问题

**拉取镜像 403 / denied**
GHCR 包默认私有。在 Packages → chat2api → Package settings 改为 Public，或先 `docker login ghcr.io`。

**8080 打不开**
`docker compose logs` 看日志。确认端口没被占用。

**界面变成内置降级页了**
看启动日志里有没有 `IPC bridge unavailable` —— 说明上游改了 `ipc/handlers.ts` 的注册方式，
需要适配。API 不受影响。`/ _ui/health` 可确认当前用的是哪一套。

**`/health` 正常但调用报错**
若是 DeepSeek/GLM 报签名相关错误，说明镜像太旧（缺 `process.resourcesPath` 修复），
`docker compose pull` 更新。

## 许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层（shim / Dockerfile / 前端服务），
构建时从上游获取源码，镜像中包含编译后的上游代码（含其前端），
因此**分发镜像时同样受 GPL-3.0 约束**，需保留原始版权声明。
