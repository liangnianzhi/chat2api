# chat2api

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑成 Docker 容器：
**上游原版界面** + OpenAI 兼容 API 网关，全部跑在一个端口上，
**不需要 Electron、不需要 Chromium、不需要 Xvfb**。

镜像由 GitHub Actions 构建并发布：`ghcr.io/liangnianzhi/chat2api:latest`

| 项目 | 实测 |
|---|---|
| 镜像体积 | ~160 MB |
| 常驻内存 | ~55 MB |
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

**对宿主机而言，只有 8082 一个端口**，界面和 API 都在它上面：

| 路径 | 作用 |
|---|---|
| `GET /` | 上游原版界面 |
| `/v1/*` | OpenAI 兼容 API（给客户端调用） |
| `/management/*` | 管理 API |
| `/health` | 健康检查 |

容器内部还有一个 **回环地址**（`127.0.0.1:18090`）供网关自己监听。
它是实现细节，**不会发布到宿主**：上游的 `ProxyServer` 必须绑定一个具体端口，
而 8082 被前端服务占着（发界面 + 桥接 IPC），所以内部拆成两段。
你不需要配置它、也不需要记住它。

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

所以这里修掉了一个真实缺陷：原来 `shell.openExternal` 只是把事件广播到
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
浏览器                     前端服务（容器内）                 网关进程
  │                              │                              │
  │ GET /                        │ 发 out/renderer/index.html   │
  │                              │ 注入 <base> + preload 桥       │
  │ POST /__ipc {channel,args} ──┼──► 派发 ─────────────────────► ipcMain.handle 注册表
  │ ◄── SSE /__ipc/events ───────┼──◄── webContents.send 事件 ────┤
```

- **`/__preload.js` 是上游自己的 preload 产物**，前面接一层 `require` 垫片
  （`webui/preload-bridge.js`）让它能在浏览器跑。它照旧调用
  `contextBridge.exposeInMainWorld('electronAPI', ...)`，所以 channel 名全部与上游一致。
- **shim 把 `ipcMain.handle` 登记下来**而不是当空函数，上游约 150 个 channel 原样可用。
- **事件走 SSE**：代理状态、配置变更、OAuth 进度都能到页面。
- **`shell.openExternal` → 新标签页**：见上一节。

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

**备份 `data/` 是唯一需要在意的事** —— 里面的 `.safe-storage-key` 是凭证加密密钥，
丢了等于全部账号作废。

## 数据卷权限

**不需要手工 chown。** 容器启动时以 root 修正 `/data` 属主，然后降权到 uid 1000
运行主进程（见 `shim/entrypoint.sh`）。宿主的 `mkdir -p data` 用任何用户都行。

> 背景：群晖的 btrfs 数据卷挂载带 `noacl,synoacl`，走 DSM 自有 ACL，
> 光靠 rwx 位不够，必须属主 uid 与容器内用户一致。

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

## 上游更新与 CI

```
lint（shell + node 语法）→ 构建镜像 → 校验 compose → 真实 compose up → 冒烟测试 → 推送 GHCR
```

触发：push、PR、tag、手动，外加**每周一次定时构建**。

> 定时构建的理由：本方案依赖上游若干内部结构（`store.ts` 的 Electron 引用、
vite 配置的 `rollupOptions.input`、`ipc/handlers.ts` 的注册方式、preload 输出格式）。
> 定时构建能把「上游悄悄改坏了」变成一次失败的任务。

冒烟测试覆盖：

- 无头运行、**只有一个发布端口**、镜像内无 Chromium/Xvfb
- 数据卷属主故意设错，验证 entrypoint 能自愈；主进程已降权
- **wasm 路径可解析**（否则首个 DeepSeek/GLM 请求会挂）
- 上游界面已就绪、preload 桥注入、静态资源可访问、`/__ipc` 能派发真实 channel
- **浏览器打开链路**（OAuth 依赖）+ 无订阅者时请求排队不丢失
- **`/management` 与 `/v0/management` 状态码与结构一致**
- `/v1/models`、`/health`
- 账号增删、凭证掩码、客户端 API 密钥
- AES-GCM 加解密往返、密文不含明文、篡改可检测
- 加密密钥与管理密钥均持久化；**重启后账号与密钥均不变**
- 镜像体积预算

本地也能跑：

```bash
IMAGE=ghcr.io/liangnianzhi/chat2api:latest bash tests/smoke.sh
```

构建时若 `out/main/headless.js`、`out/renderer/index.html` 或
`out/preload/index.js` 任一未产出，Dockerfile 会**直接失败报警**。

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
│   ├── electron-shim.js        # Electron 兼容层 + IPC 登记 + 事件总线
│   ├── entrypoint.sh           # 修正数据卷属主后降权运行
│   └── gateway.js              # supervisor：装 shim、起网关与前端服务
├── webui/
│   ├── server.js               # 唯一对外端口：前端 + IPC 桥 + 反向代理
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

改成两阶段后：**1.01 GB → ~160 MB**，`node_modules` 从 302MB 降到几 MB。
裁剪依据是上游 `externalizeDepsPlugin` 的 `exclude` 列表，
`shim/prune-deps.js` 递归保留依赖闭包并在**缺包时让构建失败**。

## 常见问题

**拉取镜像 403 / denied / 卡住**
GHCR 包默认私有，匿名拉取会被卡住。改为 Public，或先 `docker login ghcr.io`。

**点 OAuth 登录没反应**
确认镜像是修好 openExternal 的版本（`docker compose pull` 更新）。
实际上上游的 OAuth 只是「打开浏览器登录页」，登录后仍需手动贴 token。

**界面打不开但 /v1 正常**
看日志里有没有 `IPC bridge unavailable` —— 上游改了 `ipc/handlers.ts` 的注册方式。

## 许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层，构建时从上游获取源码，
镜像中包含编译后的上游代码（含其前端），因此**分发镜像时同样受 GPL-3.0 约束**。
