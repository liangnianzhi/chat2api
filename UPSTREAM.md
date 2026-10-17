# 上游版本跟踪与升级

本项目把上游 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 的整套代码跑在
容器里，但并非原样编译——外面加了一层适配（`shim/`、`webui/`）。这层适配依赖上游
若干**内部结构**。上游改动这些地方时，适配层可能失效。

本文记录：当前跟随哪个版本、依赖哪些结构、上游更新后怎么核对。

---

## 当前跟随的上游版本

| 项 | 值 |
|---|---|
| 上游仓库 | `wxs0625/Chat2API-WXS` |
| 版本 | **v1.7.16** |
| 提交 | `b306c19fcb9fae78a4acfa365f22167c00d6389a` |
| 跟踪方式 | 跟随 `main` 分支头 |
| 最后核对 | 2026-10-18 |

机器可读的记录在 [`UPSTREAM.lock`](UPSTREAM.lock)。容器内可随时查到**实际**
构建时用的版本：

```bash
docker compose exec chat2api cat /app/UPSTREAM_INFO
# REF=main
# FETCHED_AT=2026-10-17T05:45:16Z
# VERSION=1.7.16
```

---

## 适配层依赖的上游内部结构

下面每一项都是「上游一改就可能坏」的地方。升级上游时**优先检查这几处**。

| # | 依赖的结构 | 位置 | 坏了会怎样 |
|---|---|---|---|
| 1 | `storeManager` / `ProxyServer` / `registerIpcHandlers` 能作为导出被引到 | `src/main/store/store.ts`、`proxy/server.ts`、`ipc/handlers.ts` | 构建失败（`headless.js` 拿不到导出） |
| 2 | `main.build.rollupOptions.input` 的结构 | `electron.vite.config.ts` | `patch-vite-config.js` 插不进去，构建报错 |
| 3 | 代理在 `registerIpcHandlers` 里按 `autoStartProxy` 自启 | `src/main/ipc/handlers.ts` | 代理不自启 |
| 4 | Koa 应用通过 `app.listen()` 绑定端口 | `src/main/proxy/server.ts` | 单端口捕获失效 |
| 5 | 加密存储依赖 `safeStorage` | `src/main/store/store.ts` | 账号无法解密（最严重） |
| 6 | preload 输出为 CommonJS | `src/preload/index.ts` | 界面 IPC 桥失效 |
| 7 | `IpcChannels` 的 channel 名称 | `src/main/ipc/channels.ts` | 界面部分按钮失效 |
| 8 | 管理 API 前缀固定为 `/v0/management` | `src/main/proxy/server.ts` | `/management` 别名失效 |
| 9 | `proxyStatusManager` 的 `setPort` / `setHost` | `src/main/proxy/status.ts` | 界面显示的端口不对 |
| 10 | wasm 文件名 `sha3_wasm_bg.7b9ca65ddd.wasm` | 仓库根目录 | DeepSeek/GLM 签名失败 |

第 1~4、6 项已被构建与冒烟测试直接盯住（报错而非静默），其余靠日志与手动核对。

---

## 上游更新后怎么做

### 1. 看上游改了什么

```
https://github.com/wxs0625/Chat2API-WXS/compare/b306c19fcb9fae78a4acfa365f22167c00d6389a...main
```

优先看上面表中那 10 处。另外 CI 每次构建都会把实际的上游版本写进 job summary，
并与 `UPSTREAM.lock` 对比。

### 2. 对照现象定位

| 现象 | 多半是 | 怎么改 |
|---|---|---|
| `out/main/headless.js` 未产出 | 1 或 2 | 核对导出名；检查 `electron.vite.config.ts` 的 input 结构 |
| 构建成功但 `no proxy handler captured` | 3 或 4 | 看 `handlers.ts` 是否还 自启；`server.ts` 是否还 `app.listen` |
| 界面能开但按钮没用 | 6 或 7 | 看 preload 是否还是 CJS；对照 `channels.ts` |
| 账号上去就没了 | 5 | 立即停止发布，查 `safeStorage` 用法 |
| DeepSeek/GLM 报签名错 | 10 | 更新 wasm 文件名 |
| 界面端口显示不对 | 9 | 看 `proxyStatusManager` 的 setter |

### 3. 升级后更新基线

改 `UPSTREAM.lock` 里的 `version`、`commit`、`checked_at`，并在提交信息里写清
这次跟进了哪些上游变更。

---

## 要不要锁定版本

当前**跟随 `main` 分支头**：自动获得上游修复，但上游随时可能改坏适配层。

想更稳就锁定到具体提交——把 CI 里的 `CHAT2API_REF` 改成某个 commit SHA：

```yaml
# .github/workflows/ci.yml
env:
  CHAT2API_REF: b306c19fcb9fae78a4acfa365f22167c00d6389a
```

同时把 `UPSTREAM.lock` 的 `tracking` 改成 `commit`。这样除非你主动改，
镜像内容不会变。

---

## 关于登录方式的参照案例

同类项目 [agent2api](https://github.com/aimod-cc/agent2api)（私有仓库）的登录思路
与本项目不同，供以后参考：

| 方面 | agent2api | 本项目（上游 Chat2API） |
|---|---|---|
| 登录入口 | 自己的面板登录页 | 上游界面里的「添加账号」 |
| 会话保持 | **Cookie**（服务端下发 access + refresh） | 加密存储的 token/cookie |
| 注意与可用性 | 用 `/api/panel/cookie-probe` 探测 cookie 是否会在代理中转的链路上丢失，丢了就回退到「令牌入响应体」模式 | 不涉及（token 由用户手动粘贴） |
| OAuth | 依赖桌面壳 `window.workbuddyDesktop` 的 bridge 开窗并等回调 | 仅打开厂商登录页，用户手动取 token |
| 人机校验 | 纯前端 PoW（altcha：枚举 number 使 `sha256(salt+number)` 命中），**不需要浏览器内核** | Qwen 风控验证码需真实浏览器，容器里做不了 |

其中两点值得注意：

1. **它对人机校验的处理方式**：用纯算法题取代图形验证码，于是无需 Chromium。但这是
   它自己的面板登录用的，不能替上游的 Qwen 风控验证。
2. **它对「cookie 会不会在链路上丢」做了运行时探测并自动回退**，而不是假设代理
   行为。如果本项目以后要做“自动获取账号”而不是手动粘 token，这是值得借鉴的做法。
