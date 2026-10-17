# chat2api

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑成 Docker 容器：
**上游原版界面** + OpenAI 兼容 API 网关，全部跑在一个端口上，
**不需要 Electron、不需要 Chromium、不需要 Xvfb**。

镜像由 GitHub Actions 构建并发布：`ghcr.io/liangnianzhi/chat2api:latest`

| 项目 | 实测 |
|---|---|
| 镜像体积 | ~160 MB |
| 常驻内存 | ~51 MB |
| 端口 | **只有一个 8082** |
| 界面 | **上游自己编译出来的前端**（不是重画的） |
| 配置 | **零配置**：没有 .env，不需要任何密钥 |

---

## 快速开始

```bash
mkdir -p data
docker compose up -d
```

浏览器打开 **`http://<主机IP>:8082`** —— 就是上游那个界面。

整个部署状态只有 `docker-compose.yml` 和 `data/` 两样东西。

> 镜像默认是**私有**包，第一次拉取前需要先 `docker login ghcr.io`，
> 或者在 GitHub 的 Packages 设置里把它改成 Public。

## 端口：只有一个

**宿主机上只有 8082 一个端口**，界面和 API 都在它上面：

| 路径 | 作用 |
|---|---|
| `GET /` | 上游原版界面 |
| `/v1/*` | OpenAI 兼容 API（给客户端调用） |
| `/management/*` | 管理 API |
| `/health` | 健康检查 |

容器内也**只有一个监听端口**。上游的 `ProxyServer` 本来要自己 `listen` 一个端口，
这里在 `http.Server.prototype.listen` 处把它拦下来，直接拿它注册的请求处理器
在 8082 上处理——所以没有第二个端口、也没有回环转发。

启动日志会明确说明：

```
[shim] captured the HTTP request handler on :18090 (single port)
[front] API: served in-process, no second port
```

### 客户端接入

```python
from openai import OpenAI
client = OpenAI(
    api_key="在界面里生成的密钥",
    base_url="http://192.168.1.10:8082/v1",
)
```

## 管理 API：`/management`

上游自己用的是 **`/v0/management`**（在好几处中间件里硬编码，改不掉），
但它和 OpenAI 的 `/v1` 只差一个数字，容易看错。所以容器在入口处做了别名：

```
/management/accounts   ->  /v0/management/accounts
```

行为完全一致，两个前缀都能用，**文档一律写 `/management`**。

```bash
curl http://127.0.0.1:8082/management/providers
```

## 关于「OAuth 登录」

用之前需要知道：**上游的 OAuth 并不在应用内完成登录**。

以 DeepSeek 为例，适配器的全部逻辑是：

```ts
await shell.openExternal('https://chat.deepseek.com')   // 打开浏览器
return { success: false, error: '请在浏览器登录后手动填入 Token' }
```

也就是说，那个按钮的作用**就是帮你打开厂商登录页**，剩下取 token、贴回界面由你手动完成。

这里修掉了一个真实缺陷：原来 `shell.openExternal` 只是把事件广播到
SSE 通道，而 OAuth 调用时页面往往还没建立连接，**广播给了没人收**，
点击后看起来毫无反应。现在：

- 在调用栈内**同步打开新标签页**（仍属用户手势，不会被弹窗拦截）
- 若确实没有订阅者在听，请求会**排队**，等界面连上后重放

**取 Token 的位置**：以 DeepSeek 为例，登录后在页面按 `F12` →
**Application → Local Storage** → 复制 `userToken`，粘回界面的「添加账号」。

## 界面：为什么是上游原版

上游的界面和全部交互逻辑本来就已经存在，重画一遍只会多一份需要跟着上游同步的代码。
所以这里**直接把上游编译出来的前端（`out/renderer`）发出去**，把它的 IPC 调用接到
**上游自己的 `ipcMain.handle` 实现**上。

```
浏览器                     前端服务（容器内）                 上游代码
  │                              │                              │
  │ GET /                        │ 发 out/renderer/index.html   │
  │                              │ 注入 <base> + preload 桥       │
  │ POST /__ipc {channel,args} ──┼──► 派发 ─────────────────────► ipcMain.handle 注册表
  │ ◄── SSE /__ipc/events ───────┼──◄── webContents.send 事件 ────┤
  │ /v1、/management/* ───────────┼──► 直接交给被捕获的请求处理器 ──┤
```

- **`/__preload.js` 是上游自己的 preload 产物**，前面接一层 `require` 垫片
  （`webui/preload-bridge.js`）让它能在浏览器跑。它照旧调用
  `contextBridge.exposeInMainWorld('electronAPI', ...)`，所以 channel 名全部与上游一致。
- **shim 把 `ipcMain.handle` 登记下来**而不是当空函数，上游约 150 个 channel 原样可用。
- **事件走 SSE**：代理状态、配置变更、OAuth 进度都能到页面。
- **API 直接交给上游处理器**：见端口一节。

**没有降级界面**：如果上游界面发不出来，直接返回错误说明原因，
不会偷偷换成别的页面。API 始终可用。

### 无头下仍不可用的功能

只有 Qwen 的**风控验证码窗**（`captchaWindow.ts`）真正依赖浏览器内核：
它要在**容器内的会话**里载入 punish 页面、自动拖滑块、再取回刷新的 WAF cookie。
新开标签页只能完成拖滑块，cookie 在容器侧拿不到。

可行做法：新标签页打开 punish 链接 → 手动过滑块 →
控制台 `copy(document.cookie)` → 粘回界面。
要完全自动化就得在镜像里放 Chromium（+350MB），与项目初衷相背。

## 一个端口带来的取舍

上游的管理 API 需要一个密钥，否则不会启用。界面是它唯一的客户端，
所以容器启动时**自动生成**一个密钥、存进 `data/.chat2api/`（权限 600），
由前端服务在转发时**在服务端附上**——因此打开网页不需要登录。

代价是：界面和 API 共用一个端口，**能访问到这个端口的人就能管理账号**。
对自用、局域网内的场景这是有意的取舍；想收紧就只绑本机：

```yaml
ports:
  - "127.0.0.1:8082:8082"
```

需要直连管理 API 时，密钥在容器里：

```bash
docker compose exec chat2api cat /data/.chat2api/.management-secret
```

## 常用命令

```bash
docker compose pull          # 拉取最新镜像
docker compose up -d         # 启动 / 应用变更
docker compose down          # 停止
docker compose logs -f       # 跟踪日志
docker compose exec chat2api cat /app/UPSTREAM_INFO   # 当前上游版本

# 备份（含账号、配置、凭证加密密钥）
tar czf chat2api-data-$(date +%Y%m%d).tar.gz data
```

**`data/` 是唯一需要备份的东西** —— 里面的 `.safe-storage-key` 是凭证加密密钥，
丢了等于全部账号作废。

## 数据卷权限

**不需要手工 chown。** 容器启动时以 root 修正 `/data` 属主，然后降权到 uid 1000
运行主进程（见 `shim/entrypoint.sh`）。宿主的 `mkdir -p data` 用任何用户都行。

> 背景：群晖的 btrfs 数据卷挂载带 `noacl,synoacl`，走 DSM 自有 ACL，
> 光靠 rwx 位不够，必须属主 uid 与容器内用户一致。

## 发布流程（重要）

工作流**不会在每次 push 时构建** —— 一轮修改通常跨多个提交，每个都构建很浪费。

```
1. 把这一轮改动全部提交完
2. Actions → build → Run workflow（选 main）
3. 一次点击完成：构建 → 部署验证 → 冒烟测试 → 推送 latest
```

只有全部通过才会推送；任何一步失败都不会动 GHCR 上的 `latest`。

**PR 会自动构建并测试（不推送）** —— 这是唯一保留的自动构建路径，用于合并前验证。

### 关于 `sha256:` 是什么

那不是标签，而是**镜像摘要（digest）**：内容寻址的哈希，不可变。

早先一次运行会出现**两个** digest，因为旧流程构建了两次：先 `load` 一份供测试，
再 `build --push` 完整重建一份用于推送。现在只构建一次，直接用测过的那份推送，
所以**一次运行 = 一个 digest**。

```bash
docker image inspect ghcr.io/liangnianzhi/chat2api:latest \
  --format '{{index .RepoDigests 0}}'
```

推荐固定到 digest 而不是 `latest`（更可复现）：

```yaml
image: ghcr.io/liangnianzhi/chat2api@sha256:...
```

### 流水线

```
lint（shell + node 语法）→ 构建镜像 → 校验 compose → 真实 compose up → 冒烟测试 → 推送
```

冒烟测试覆盖：

- **只有一个发布端口**、API 在进程内处理、容器内无 18090 监听
- 上游代理仍自报 running（证明 listen 回调被正确触发）
- 无头运行、镜像内无 Chromium/Xvfb
- 数据卷属主故意设错，验证 entrypoint 能自愈；主进程已降权
- 时区为 Asia/Shanghai（TZ + `/etc/localtime` + `+0800` 偏移）
- **wasm 路径可解析**（否则首个 DeepSeek/GLM 请求会挂）
- 上游界面已就绪、preload 桥注入、静态资源可访问、`/__ipc` 能派发真实 channel
- **浏览器打开链路**（OAuth 依赖）+ 无订阅者时请求排队不丢失
- **`/management` 与 `/v0/management` 状态码与结构一致**
- 账号增删、凭证掩码、客户端 API 密钥
- AES-GCM 加解密往返、密文不含明文、篡改可检测
- 加密密钥与管理密钥均持久化；**重启后账号与密钥均不变**
- 镜像体积预算

本地也能跑：

```bash
IMAGE=ghcr.io/liangnianzhi/chat2api:latest bash tests/smoke.sh
```

## 实现原理（代理部分）

整个代理层 92 个源文件里**只有 3 个**碰 Electron：

| 文件 | 用到的 API | 处理 |
|---|---|---|
| `store/store.ts` | `app`、`safeStorage`、`BrowserWindow` | AES-256-GCM 自建加密，密钥存数据卷 |
| `proxy/adapters/perplexity.ts` | `net` | 换成 Node 原生 http/https |
| `proxy/captchaWindow.ts` | `BrowserWindow`、`session` | 仅 Qwen 风控验证用，无头下明确报错 |

**1. 新增无头入口 `shim/headless-entry.ts`**：直接 `import` 上游的
`storeManager`、`ProxyServer`、`registerIpcHandlers`。

> 为什么不能在外面写脚本 require：上游打包把主进程 tree-shake 成**单个 bundle**，
> 外部没人引用的导出会被整个删掉。加一个 Rollup 入口让打包器「看见」引用才能保留。

**2. Electron 兼容层 `shim/electron-shim.js`**

- `safeStorage`：**重启后必须仍能解密** —— 上游注释警告过，密钥一变，
  加密的 `data.json` 会被当作损坏并**静默清空所有账号**。
- `process.resourcesPath`：Electron 专有属性，纯 Node 下是 `undefined`。
  编译后的代码用它定位 sha3 wasm（DeepSeek/GLM 签名）：

  ```js
  app.isPackaged ? path.join(process.resourcesPath, "sha3_wasm_bg...wasm") : ...
  ```

  不补的话 `path.join(undefined, ...)` 直接抛 TypeError，**首个真实请求就会失败**。
- `ipcMain`：登记而非空实现（界面桥的基础）。
- `Tray` / `Menu`：惰性空实现 —— `registerIpcHandlers` 会在代理启停时调
  `TrayManager.updateProxyStatus()`，抛错会弄坏界面自己的按钮。

**3. 用 shim 替换 `node_modules/electron`**：编译产物和 Rollup 拆出的
`chunks/*.js` 都会 `require('electron')`，换包是一次性拦截所有调用点。

**4. 单端口捕获（`http.Server.prototype.listen`）**

上游的 `ProxyServer` 要自己 `listen` 一个端口。拦 `Koa.prototype.listen` **不行**：
`electron-vite` 把依赖内联进 bundle，上游用的 Koa 是**私有副本**，
在外部 patch `node_modules/koa` 打的是另一个对象，拦截永远不会触发
（实测 bundle 只用 Node 内置模块，从不 `require('koa')`）。

Node 的 `http` 模块是共享的，所以改在 `http.Server.prototype.listen` 拦截：

- 摘下该 server 已有的 `request` 监听器，组成一个处理器发布为 `__httpHandler`
- 返回一个「已监听」的替身对象（不绑 socket）
- **调用上游传入的 callback** —— `proxyStatusManager.start()`/`setPort()` 都在里面，
  不调用的话界面会显示代理「已停止」而实际在服务

## 目录结构

```
.
├── docker-compose.yml          # 全部部署配置
├── Dockerfile                  # CI 用的多阶段构建
├── .offline.Dockerfile         # 备选：从预编译目录组装
├── shim/
│   ├── headless-entry.ts       # 无头启动入口（编进上游 bundle）
│   ├── patch-vite-config.js    # 给 vite 配置追加 headless 入口
│   ├── prune-deps.js           # 裁剪 node_modules
│   ├── electron-shim.js        # Electron 兼容层 + IPC 登记 + 单端口捕获
│   ├── entrypoint.sh           # 修正数据卷属主后降权运行
│   └── gateway.js              # supervisor：装 shim、起网关与前端服务
├── webui/
│   ├── server.js               # 唯一对外端口：前端 + IPC 桥 + 直连 API
│   └── preload-bridge.js       # 浏览器侧的 preload 垫片
├── tests/smoke.sh
└── .github/workflows/ci.yml
```

## 镜像体积

早先的构建方式得到 **1.01GB**（实际运行内容只有 13.8MB），原因两个：

1. 把整个 `node_modules` 打进去了。上游的 `externalizeDepsPlugin` 会把绝大多数依赖
   **内联进 bundle**，磁盘上只需要 exclude 列表里那几个包；当时没裁剪，
   302MB 依赖全进镜像，仅 `electron` 一个就 315MB。
2. 「先装后删」不减小镜像 —— 镜像按层累积，后续层删除只记 whiteout 标记。

改成两阶段后：**1.01 GB → ~160 MB**。
裁剪依据是上游 `externalizeDepsPlugin` 的 `exclude` 列表，
`shim/prune-deps.js` 递归保留依赖闭包并在**缺包时让构建失败**。

## 常见问题

**拉取镜像 403 / denied / 卡住**
GHCR 包默认私有，匿名拉取会被卡住。改为 Public，或先 `docker login ghcr.io`。

**改了代码但 GHCR 上还是旧的**
推送只在手动触发时发生。Actions → build → Run workflow。

**点 OAuth 登录没反应**
确认镜像是修好 openExternal 的版本。另外上游的 OAuth 只是「打开浏览器登录页」，
登录后仍需手动贴 token。

**界面打不开但 /v1 正常**
看日志里有没有 `captured the HTTP request handler` 和
`API: served in-process` —— 缺前者说明上游改了监听方式。

## 许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层，构建时从上游获取源码，
镜像中包含编译后的上游代码（含其前端），因此**分发镜像时同样受 GPL-3.0 约束**。
