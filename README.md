# chat2api

把 [Chat2API-WXS](https://github.com/wxs0625/Chat2API-WXS) 跑成 Docker 容器：
**上游原版界面** + OpenAI 兼容 API 网关，全部跑在一个端口上，
**不需要 Electron、不需要 Chromium、不需要 Xvfb**。

镜像由 GitHub Actions 构建并推送到 ghcr.io，**拉取走南京大学镜像站**：
`ghcr.nju.edu.cn/liangnianzhi/chat2api:latest`

| 项目 | 实测 |
|---|---|
| 镜像体积 | 195 MB（优化后 ~180 MB，见「镜像体积」一节） |
| 常驻内存 | ~51 MB |
| 端口 | **只有一个 8082** |
| 界面 | **上游自己编译出来的前端**（不是重画的） |
| 配置 | **零配置**：不需要 .env，管理密钥首次启动自动生成 |
| 鉴权 | **默认开启**：匿名请求一律拒绝，见「访问控制」 |
| 自愈 | **默认开启**：账号失败先冷却再复核，见「账号自愈」 |

---

> **容器里现在有三样上游没有的东西**，都是可关的，读完「快速开始」可以按需跳转：
>
> - [健康自检](#健康自检health) —— `/health` 从「活着吗」变成「能不能用，不能用是为什么」
> - [账号自愈](#账号自愈selheal) —— 上游 39 个账号同一天变 error 的那类故障，现在会自己回来
> - [请求日志与统计](#请求日志与统计) —— 每条失败请求带分类，统计里能看到失败分布与延迟分位

## 快速开始

```bash
mkdir -p data
docker compose up -d
```

浏览器打开 **`http://<主机IP>:8082`** —— 就是上游那个界面。

整个部署状态只有 `docker-compose.yml` 和 `data/` 两样东西。

> **关于镜像源**：CI 推送到官方 `ghcr.io`（镜像站只代理下载，不接受上传），
> 部署时从 `ghcr.nju.edu.cn` 拉取加速。compose 里已写好镜像站地址。

## 端口：只有一个

**宿主机上只有 8082 一个端口**，界面和 API 都在它上面：

| 路径 | 作用 |
|---|---|
| `GET /` | 上游原版界面 |
| `/v1/*` | OpenAI 兼容 API（给客户端调用） |
| `/management/*` | 管理 API |
| `/health` | 健康检查 |

容器内也**只有一个监听端口**。上游的 `ProxyServer` 本来要自己 `listen` 一个端口，
这里在 `http.Server.prototype.listen` 处把它拦下来，直接用它注册的请求处理器
在 8082 上处理——所以没有第二个端口、也没有回环转发。

更关键的是：**配置里的端口也是 8082**。界面右上角显示的地址、管理 API 的基础
地址、`proxy:getStatus` 的返回值，全都来自同一份配置，因此始终一致。

启动日志会明确说明：

```
[shim] captured the HTTP request handler on :8082 (single port)
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

## 访问控制：谁能进这个端口

单端口意味着界面、管理面、OpenAI 兼容接口共用 `8082`。上游把这些路径当成本机进程间调用，
**默认没有任何鉴权**；容器又常常部署在 NAS、局域网或宿主机端口映射后面，任何能连到 8082 的人
都能增删账号、改配置、调用管理 API。所以入口处加了一道闸（`webui/auth.js`）。

### 两种凭据

| 调用者 | 凭据 | 说明 |
| --- | --- | --- |
| 脚本 / SDK / CI（API 客户端） | `Authorization: Bearer <管理密钥>` | 密钥即数据卷里的 `/data/.chat2api/.management-secret`；也可用环境变量 `CHAT2API_MANAGEMENT_SECRET` 固定 |
| 浏览器 | `c2a_session` Cookie | 打开 `/__login` 即下发；`HttpOnly` + `SameSite=Strict`，HTTPS 下自动加 `Secure` |

两种凭据的权限**故意不同**：Bearer 能打 API 与管理面，但打不开界面（拒绝把界面交给 API 令牌）；
Cookie 能打开界面、取 `preload` 桥、调 IPC，但调用 `POST /__ipc` 时要额外带 `X-C2A-Request: 1`
和 `X-C2A-CSRF`/`csrf` 字段，这正是浏览器跨站表单**无法伪造**的部分。

### 默认拒绝的端点

- `/`、`/__preload.js`、静态资源、`/__ipc`、`/__ipc/events`、`/__ipc/config`、`/__login/finish`
- `/stats`、`/v0/**`、`/v1/**`、`/api/**`、`/management/**`

只有 `/health`、`/__login` 与 `/__auth/status` 免鉴权：前者给健康检查用，后两者的内容就是
「怎么登录」，本来就必须对匿名者可见。

`/health` 除了探活，还会返回审计摘要（鉴权是否启用、会话数、被锁的 IP、最近 8 条审计记录），
密钥本身永远不出现在里面。

### 被拒绝时返回什么：API 回 JSON，页面回登录页

拒绝不等于「一律回一个 HTML 登录页」——那会让 OpenAI SDK 去解析 HTML。按**路径属于哪个
命名空间**分两类：

| 路径 | 拒绝时 |
| --- | --- |
| `/v1/**`、`/v0/**`、`/api/**`（OpenAI 兼容接口与管理 API） | `401` + `application/json` + 上游同款错误体 |
| `/`、`/__preload.js` 等渲染器页面 | `401` + `text/html`「需要登录」页，页里有去 `/__login` 的链接 |

判定只看路径，**不看**请求头：一个 key 写错的 OpenAI 客户端（照样带 `Authorization`）打到
`/v1/**` 必须拿到 JSON；反过来，用浏览器打开 `/` 永远看到可以点的登录页。

`/v1/**`、`/v0/**`、`/api/**` **永远只回 JSON**，无论有没有凭据、无论是哪条路径
（`/v1/models`、`/v1/chat/completions`、`/v1/embeddings`、`/v1/completions`、
`?stream=true` 变体都一样）。无凭据与错凭据的响应体都是：

```json
{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}
```

响应头还带了 `X-Chat2API-Auth: required|denied`、`X-Chat2API-Reason: invalid_api_key` 与
`WWW-Authenticate: Bearer realm="chat2api"`，排查时不用猜是「没给凭据」还是「凭据不对」。
错 key 只记一行审计（`reason: invalid_bearer`），但**不会**把客户端 IP 锁死——锁定只按
`CHAT2API_AUTH_FAIL_LIMIT` 计「没给凭据 / 凭据畸形」的次数，免得上游 key 轮换期间的正常
流量被误伤。

```console
$ curl -si http://127.0.0.1:8082/v1/models -H "Authorization: Bearer sk-your-upstream-key"
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Chat2API-Auth: required
WWW-Authenticate: Bearer realm="chat2api", error="invalid_api_key", nonce=…
X-Chat2API-Reason: invalid_api_key

{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}
```

`/__ipc`、`/__ipc/events`、`/__login/finish` 这些桌面 IPC 能力不属于 OpenAI 命名空间，
被拒时仍是 `401`（`/__ipc` 是 JSON 信封），不会因为它们「看起来像 API」而返回登录页。


### CSRF

- 所有非 `GET/HEAD/OPTIONS` 请求都校验 `Origin`（缺失时回退 `Referer`）与 `Host` 同源；
  `Origin: null`、跨端口、跨站 Referer 一律 `403`。
- `POST` 只接受 `Content-Type: application/json`（含 `+json`、带 charset 的变体），
  其余一律 `415`。`text/plain`、`application/x-www-form-urlencoded`、`multipart/form-data`
  是浏览器**不发预检**就能跨站发出的三种类型，正好被这条挡掉。

### 限流与审计

- `/__ipc` 默认每分钟 120 次、突发 40（`CHAT2API_IPC_RATE_PER_MIN` / `CHAT2API_IPC_BURST`），
  超限回 `429` 并带 `Retry-After`。
- 同一 IP 连续鉴权失败 `CHAT2API_AUTH_FAIL_LIMIT`（默认 30）次后锁定
  `CHAT2API_AUTH_LOCK_SECONDS`（默认 120）秒。
- 每次放行/拒绝都写一行 `[audit] {"t":…,"method":…,"path":…,"ip":…,"reason":…}` 到容器日志；
  **只记录凭据是否提供、长度与问题描述，不记录凭据原文**，真实管理密钥即使被谁误写进去也会被擦成
  `[redacted-secret]`。

### 第一次部署：密码在哪

管理密钥（也就是登录密码）在数据卷里，首次启动自动生成，之后一直不变：

```bash
# 用 compose 部署：直接在容器里读
docker compose exec chat2api cat /data/.chat2api/.management-secret

# NAS / 直接读数据卷（路径换成你的挂载点）
sudo cat /volume1/docker/chat2api/data/.chat2api/.management-secret
```

拿到之后：浏览器打开 `http://<主机>:8082/` → 看到一个「需要登录」的页面 → 点「打开登录页」
（或者直接访问 `/__login`）→ 用这个密码登录一次，浏览器就会拿到 `HttpOnly` 会话 cookie，
之后界面、IPC、接口都能用。脚本/SDK 则把这个值当 `Bearer` 令牌用。

想自己定密码：`CHAT2API_MANAGEMENT_SECRET=<16 位以上> docker compose up -d`。
这个值启动时会过一遍弱口令检查（长度 < 16、常见默认口令、`0123456789` 这类键盘序列），
不合格的会在启动日志和 `/health` 的 `warnings` 里告警，但**不会拒绝启动**。

### 兼容性变化（升级前必读）

1. 以前可以直接 `curl http://NAS:8082/management/...`，现在必须带 `Authorization: Bearer <密钥>`。
   管理密钥从数据卷读：`docker exec chat2api cat /data/.chat2api/.management-secret`。
2. 服务端**不再对匿名请求**自动补管理密钥（那是把管理权限白送给任何能连端口的人）。
   自动补密钥只对已用 Bearer 认证的调用者生效，且请求未自带 `Authorization` 时**才补充**。
3. 明确**不**实现「来自 127.0.0.1 或内网就放行」：容器里的 `127.0.0.1` 是所有入站连接的视角，
   Docker 端口映射会把任意局域网/公网客户端呈现为 bridge 网关地址，源码层面无法可靠区分，
   放行等于把修补的漏洞原样恢复。
4. 只想快速跑通、明确在离线单机环境里用：`CHAT2API_REQUIRE_AUTH=false` 关闭闸门——
   但这会把桌面 IPC 能力重新暴露给任何能连端口的人，仅用于临时排查。
5. `/v1/**`（及 `/v0/**`、`/api/**`）**未通过鉴权**时，从「HTML 登录页」改为「`401` + 上游同款
   JSON 错误体」（1.8.1）：openai-python / openai-node / LangChain / one-api 拿到 HTML 会直接抛
   `JSONDecodeError` 或 `Unexpected token '<'`，现在它们得到的是可解析的 401 错误。
   浏览器地址栏直接打开 `/v1/models` 仍会看到 JSON；要登录请走 `/__login`。

### 验证

```bash
# 在容器内或任意能连到实例的机器上（纯 curl，断言 401/403/415 与两种凭据）
docker exec chat2api sh /app/tests/auth_probe.sh

# 改完代码后不起容器也能跑：本地 harness 组装假的 shim + 真实 webui 代码
node tests/auth_selftest.js

# 完整套件（会先起一个临时容器）
./tests/smoke.sh
```

## 管理 API：`/management`

上游自己用的是 **`/v0/management`**（在好几处中间件里硬编码，改不掉），
但它和 OpenAI 的 `/v1` 只差一个数字，容易看错。所以容器在入口处做了别名：

```
/management/accounts   ->  /v0/management/accounts
```

行为完全一致，两个前缀都能用，**文档一律写 `/management`**。

```bash
curl -H "Authorization: Bearer $(docker exec chat2api cat /data/.chat2api/.management-secret)" \
  http://127.0.0.1:8082/management/providers
```

不带凭据会得到 `401`，细节见上面的[访问控制](#访问控制谁能进这个端口)。

## 关于「OAuth 登录」

**上游的 OAuth 并不在应用内完成登录。** 以 DeepSeek 为例，适配器的全部逻辑是：

```ts
await shell.openExternal('https://chat.deepseek.com')   // 打开浏览器
return { success: false, error: '请在浏览器登录后手动填入 Token' }
```

那个按钮的作用**就是帮你打开厂商登录页**，剩下取 token、贴回界面由你手动完成。

在浏览器里跑时，这一步有两个坑，都已处理：

- **弹窗拦截**：上游从主进程发 `openExternal`，事件到达页面时早已不在用户手势内，
  浏览器会拒绝打开。现在对可能打开浏览器的 IPC 通道（`*openExternal`、
  `*startLogin` 等）在**点击的同步阶段先开一个空白标签页**，URL 到了再跳转。
  万一仍被拦截，页面底部会显示一条横幅，把链接给你点。
- **回环地址**：上游会把管理 API 地址拼成 `http://127.0.0.1:<port>/v0/management`，
  在浏览器里这指向**你自己的电脑**，永远连不上。现在 `fetch`/`XHR` 会把这类
  回环地址改写到当前 origin。

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

上游的管理 API 需要一个密钥，否则不会启用；界面是它唯一的客户端。
容器启动时**自动生成**这个密钥（`randomBytes(32).toString('hex')`）、写进
`data/.chat2api/.management-secret`（权限 600），界面用会话 Cookie 登录后即可使用。

代价是：界面和 API 共用一个端口，**能访问到这个端口的人就能尝试管理账号**。
单端口这一点无法改变，能改的只是这一条：谁算「有资格」。

所以入口处加了一道闸（`webui/auth.js`，默认开启）——匿名请求一律拒绝，
要么用界面登录拿到 `c2a_session` Cookie，要么用管理密钥作 Bearer。
对自用、局域网内的场景这是有意的取舍；想再收紧就只绑本机：

```yaml
ports:
  - "127.0.0.1:8082:8082"
```

需要直连管理 API 时，密钥在容器里：

```bash
docker compose exec chat2api cat /data/.chat2api/.management-secret
```

## 部署与升级

容器由**群晖的容器管理器**根据 compose 创建，所以升级分两步：

```bash
cd /volume1/docker/chat2api

./deploy.sh pull     # 1. 拉取新镜像
                     # 2. 在群晖「容器管理器」里把这个容器「重置 / 重新创建」
./deploy.sh wait     # 3. 等健康检查通过，并清理被替换下来的旧镜像
```

或者一条命令走完全程（它会停在第二步等你操作）：

```bash
./deploy.sh
```

其他子命令：

```bash
./deploy.sh status   # 容器状态、镜像、容器用的镜像 vs latest、悬空镜像
./deploy.sh logs     # 跟踪日志
```

`deploy.sh` 的镜像地址**从 compose 读取**，两处不会不一致；也可用
`CHAT2API_IMAGE=...` 覆盖。

**为什么要手动重置**：`docker pull` 只换掉镜像，正在运行的容器仍用旧镜像；
只有重建容器才会用上新镜像。这一步在群晖界面上做最稳妥。脚本会比对容器实际
使用的镜像 ID，确认你真的重置过才继续——不会在旧容器还在跑时报成功。

### 升级后可能要重建数据卷吗

不需要，而且不建议：`data/` 里的 `.safe-storage-key` 是凭证加密密钥，丢了等于全部账号作废。
本仓库新增的东西全部**叠加**在原有数据上，升级后旧数据照常读出：

- 账号自愈只改 `data.json` 里已有的 `status` 字段（关掉 `CHAT2API_SELFHEAL_AUTO_STATUS` 连这个都不改）；
- 请求日志的分类字段是**读时补写**的：旧行没有 `failureCategory`，新代码按同样的规则重新判定后补上，
  不重写整个文件；
- `/health` 的 `checks`/`warnings` 是算出来的，不落盘。

**唯一需要留意的是密钥**：如果以前靠「谁都能访问」在用，现在第一次打开界面会看到登录页，
去上一节取密码即可。

## 常用命令

```bash
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

## 本地开发

### 先跑 lint

改完代码、提交之前先跑一遍仓库自检，CI 的 lint job 跑的就是它：

```bash
./tests/lint.sh
```

它检查五件事，都是「不查就会以很难查的方式失败」的那类问题：

| 检查 | 为什么要有 |
|---|---|
| 所有文本文件必须是 **LF** | 用 Windows 默认设置 checkout 会把 `shim/entrypoint.sh` 变成 CRLF，镜像里 shebang 直接失效，容器起不来 |
| 脚本不得带 **UTF-8 BOM** | 同上，BOM 会让内核读不到 `#!/bin/sh` |
| 所有 `*.sh` 过 `bash -n`、所有 `*.js` 过 `node --check` | 按扩展名自动收集，新加的 `shim/*.js` 不会因为忘了加进 CI 清单而漏检 |
| 入口脚本要有**可执行位** | `deploy.sh`、`entrypoint.sh` 丢了 +x 只能靠人发现 |
| **README 里的数字要对得上代码** | 文档写错不会报错，只会让照着做的人卡住；`tests/docs_claims.js` 把脚本清单、调参默认值、路由、预算都变成断言 |

### Windows 上开发要注意的几点

这几条是实际踩过的，和代码无关，纯粹是工具链问题：

- **一定要关掉自动换行转换**，否则上面第一条天天挂：

  ```bash
  git config core.autocrlf false
  git config core.eol lf
  ```

- **不要用 PowerShell 的 `Invoke-WebRequest` / 系统 `curl.exe` 去拉 GitHub**。
  某些 Windows 环境下它们的 TLS 栈会报 `SEC_E_NO_CREDENTIALS` 或
  「基础连接已经关闭」，而同一个网络下 Node 的 `https` 和 git 的
  OpenSSL 后端是通的。用 `node` 或 `git` 取数据即可。
- **git 的网络后端**：如果 `git clone/fetch` 报 TLS 握手失败，试试

  ```bash
  git -c http.sslBackend=openssl fetch
  ```

  （本机没有 git 时，可以只用一份便携版 MinGit，把它的 `cmd` 目录加进 PATH。）
- **本机没有 bash**。`tests/lint.sh` 和 `tests/smoke.sh` 都需要 bash，
  在 Windows 上要么用 WSL，要么放到容器里跑：

  ```bash
  docker run --rm -v "$PWD":/w -w /w node:22-slim bash tests/lint.sh
  ```

  CI 用的是 `ubuntu-latest`，所以最终以 CI 为准。

### 没有凭据时怎么验证推送

`git fetch` / `git ls-remote` 不需要凭据就能验证网络与远端是可用的；
真正推送前用 `--dry-run` 检查引用与权限，不会改动远端：

```bash
git fetch origin
git push --dry-run origin HEAD:main
```

## 版本

只记**面向使用者**的变更；内部重构、测试与构建脚本的调整不在这里。
1.8.2 对外只有一件事：源码回到仓库里了。升级动作、配置项、接口形状都没有变化——如果你手上跑的是 1.8.1 的镜像，不升也不影响。

## 1.8.2

- **修好了推送事故**：仓库里的源码恢复成真实内容（此前 51 个文件以 base64 单行形式提交，任何人在 GitHub 上看到的、CI 拿到的都不是可运行代码）。已逐个用 git blob sha 与构建源码树对账，50/51 字节级一致，剩下 1 个文件当时被 GitHub API 限流，稍后单独复核过：一致。
- **CI 按分支构建**：构建参数 `CHAT2API_REF` 过去写死 `main`，在分支上触发构建会把 `main` 的上游代码打进镜像；现在取 `github.ref_name`，分支构建就是分支的代码。
- **CI 提前失败**：构建完镜像后立刻跑两个不需要容器的套件（`tests/auth_selftest.js`、`tests/docs_claims.js`），鉴权网关卡住或文档与代码对不上时，不用等到 compose 起容器才发现。
- **文档一致性检查修复**：`tests/docs_claims.js` 之前盯的常量名（`REPORT_BUDGET_MS`）在 `shim/health.js` 里根本不存在，这条断言等于空转；现在盯 `DEFAULT_BUDGET_MS`（`CHAT2API_HEALTH_BUDGET_MS || 1500`）。

## 1.8.1

- **`/v1/**` 拒绝时改为返回 JSON**：未带密钥或用错密钥时，得到 `401 application/json` 与上游同款错误体 `{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}`，不再返回 HTML 登录页。openai-python、openai-node、LangChain、one-api 等客户端不会再出现 `JSONDecodeError` / `Unexpected token '<'`。浏览器打开页面路径（`/`、`/__login`）仍然看到登录页。
- **429 带上 `Retry-After`**：限流时响应头会告诉客户端等多久，SDK 会照着退避，而不是退回自己的重试节奏；同时不再发送 `WWW-Authenticate`（限流不是密钥错误，发它会让客户端误以为要去换密钥）。
- **新增配置项 `CHAT2API_RETRY_AFTER`**（可选）：`Retry-After` 的秒数，默认 `60`，上限 `3600`，填写非法值时回落到 `60`。一般不需要改；改过 `CHAT2API_IPC_RATE_PER_MIN` 的人只要保证两者口径一致即可。

## 发布流程

push 到 main 时自动构建、测试并推送 latest；PR 也会构建并测试（不推送）。

```
lint（tests/lint.sh）→ 构建镜像 → 校验 compose → 真实 compose up
   → 容器内冒烟测试 → 外部 HTTP 验证 → 端口上报断言 → 推送
```

只用构建一次，推送的正是测过的那个镜像，所以**一次运行 = 一个 digest**。

冒烟测试覆盖：

- **只有一个发布端口**、API 在进程内处理、容器内无 18090 监听
- **代理自报 running**，且**上报端口是 8082**（重启后仍成立）
- 数据卷属主故意设错，验证 entrypoint 能自愈；主进程已降权
- 时区为 Asia/Shanghai（TZ + `/etc/localtime` + `+0800` 偏移）
- **wasm 路径可解析**（否则首个 DeepSeek/GLM 请求会挂）
- 上游界面已就绪、preload 桥注入（含弹窗预开逻辑）、静态资源可访问
- **浏览器打开链路**（OAuth 依赖）
- **`/management` 与 `/v0/management` 状态码与结构一致**
- 账号增删、凭证掩码、客户端 API 密钥
- AES-GCM 加解密往返、密文不含明文、篡改可检测
- 重启后账号与密钥均不变
- **凭据的正反两面**：正确 Bearer 放行、错误 Bearer 401、跨站 Origin 403、非 JSON 的 POST 415
- **统计接口含 `p50`/`p95`/`byCategory`，且响应带 `X-C2A-Observability`**（没有这个头说明聚合层没接上）
- **失败分类只取自约定枚举**（`auth`/`captcha`/`rate-limit`/`network`/`provider-5xx`/`client-error`/`unknown`）
- **`/health` 报出自愈的安装状态**（`installed`/`enabled`/`missing` 全部为空才算接好了）
- **假 token 账号会被 validate 判成坏**并落到 `status: error`；上游不可达时报 `networkError` 且**不改状态**（用完即删）
- 镜像体积预算

本地也能跑：

```bash
# 起临时容器跑完整套件
IMAGE=ghcr.nju.edu.cn/liangnianzhi/chat2api:latest bash tests/smoke.sh

# 或者只验证一个已部署的实例（纯 HTTP，不碰 docker）
VERIFY_URL=http://192.168.1.10:8082 bash tests/smoke.sh
```

### `tests/` 下的每个脚本

| 脚本 | 跑在哪 | 跑法 | 管什么 |
|---|---|---|---|
| `tests/lint.sh` | 有 bash 的任何地方 | `./tests/lint.sh` | 仓库自检：LF 行尾、无 BOM、全部 `*.sh` 过 `bash -n`（shebang 是 `/bin/sh` 的再过多一条 `sh -n`）、全部 `*.js` 过 `node --check`、入口脚本的可执行位，最后跑一遍下面的 `docs_claims.js`。CI 的 lint job 就是这一步 |
| `tests/docs_claims.js` | 有 node 的任何地方 | `node tests/docs_claims.js` | **文档不许过期**：把 README 里可验证的说法（本文档列出的脚本、调参默认值、路由清单、1.5 秒预算、自愈参数名）逐条对回代码。新增脚本忘了写进 README 也会在这里红 |
| `tests/auth_selftest.js` | 本机 node ≥ 18 | `node tests/auth_selftest.js` | 访问控制的确定性断言（401/403/415/429 与两种凭据），用真实 HTTP，**不需要镜像、不需要依赖**；自己起 `local_harness.js` |
| `tests/local_harness.js` | 本机 node ≥ 18 | `node tests/local_harness.js --secret …` | 上一条的测试替身：真实的 `webui/*.js` + 假 shim + 假代理，`--mode nosecret` 模拟没有密钥的干净启动 |
| `tests/auth_probe.sh` | 容器内或任意能连到实例的机器 | `BASE=http://host:8082 sh ./tests/auth_probe.sh` | 对**已部署实例**的访问控制探针，纯 curl + POSIX，可以 `docker exec chat2api sh /app/tests/auth_probe.sh`；含 `/v1/**` 必须回 JSON 而非登录页的断言（无凭据 + 错 key 两种） |
| `tests/selfheal.test.js` | 本机 node | `node tests/selfheal.test.js` | 自愈层单测：401/403 事故矩阵、captcha/限流/网络「不判死刑」、冷却与指数退避、pick 时的否决、sweep 调度 |
| `tests/observability.test.js` | 本机 node | `node tests/observability.test.js` | 可观测层单测：失败分类、请求日志注解与截断、百分位算法、日志库定位与安装 |
| `tests/observability_integration.js` | 本机 node | `node tests/observability_integration.js` | 拿**真实 shim** 和真实接线跑一遍，证明挂载点对得上（不是只在假对象上过） |
| `tests/observability_smoke.sh` | 容器内 | `docker exec chat2api sh /app/tests/observability_smoke.sh` | 对**真实 bundle** 验证：层确实装上了、找到了真实的请求日志库、`/v0/management/statistics` 原有字段不丢 |
| `tests/observability_realdata.js` | NAS 上 | `SHIM_DIR=… RAW_FILE=… node tests/observability_realdata.js` | 只读回放**生产请求日志**，打印 JSON 报告（不写库），用来确认分类规则在真实数据上的边界 |
| `tests/smoke.sh` | 有 docker 的机器 | `bash tests/smoke.sh` | 完整冒烟：起一个一次性容器，把上面「冒烟测试覆盖」那一串全跑一遍（含鉴权正反两面、`/health` 自检字段、自愈接缝、统计的 `p50`/`p95`/`byCategory`、假 token 账号判坏）；设 `VERIFY_URL` 则只打已有实例 |

前两条（lint + auth_selftest）是**改完代码几秒内就能跑完**的那一档，建议提交前都跑；
`smoke.sh` 要构建/拉取镜像，属于 CI 那一档。

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
  编译后的代码用它定位 sha3 wasm（DeepSeek/GLM 签名），不补会抛 TypeError，
  **首个真实请求就会失败**。
- `ipcMain`：登记而非空实现（界面桥的基础）。
- `Tray` / `Menu`：惰性空实现 —— `registerIpcHandlers` 会在代理启停时调
  `TrayManager.updateProxyStatus()`，抛错会弄坏界面自己的按钮。

**3. 用 shim 替换 `node_modules/electron`**：编译产物和 Rollup 拆出的
`chunks/*.js` 都会 `require('electron')`，换包是一次性拦截所有调用点。

**4. 单端口捕获（`http.Server.prototype.listen`）**

拦 `Koa.prototype.listen` **不行**：`electron-vite` 把依赖内联进 bundle，
上游用的 Koa 是**私有副本**，在外部 patch `node_modules/koa` 打的是另一个对象，
拦截永远不会触发。Node 的 `http` 模块是共享的，所以改在这里拦：

- 摘下该 server 已有的 `request` 监听器，组成处理器发布为 `__httpHandler`
- 返回一个「已监听」的替身对象（不绑 socket）
- **调用上游传入的 callback** —— `proxyStatusManager.start()`/`setPort()` 都在里面

前端服务会**等捕获完成后**才启动（而不是固定延时），避免它自己的监听被误捕获。

## 目录结构

```
.
├── docker-compose.yml          # 全部部署配置
├── deploy.sh                   # 拉取镜像 + 等重置 + 清理旧镜像
├── Dockerfile                  # CI 用的多阶段构建
├── .offline.Dockerfile         # 备选：从预编译目录组装
├── shim/
│   ├── headless-entry.ts       # 无头启动入口（编进上游 bundle）
│   ├── patch-vite-config.js    # 给 vite 配置追加 headless 入口
│   ├── prune-deps.js           # 裁剪 node_modules
│   ├── electron-shim.js        # Electron 兼容层 + IPC 登记 + 单端口捕获
│   ├── entrypoint.sh           # 修正数据卷属主后降权运行
│   ├── gateway.js              # supervisor：装 shim、起网关与前端服务
│   ├── health.js               # /health 的报表本体：检查项、警告、账号汇总
│   ├── selfheal/               # 账号健康与自愈：失败分类、冷却、定时巡检、pick 否决
│   └── observability/          # 请求日志注解 + 统计扩展（失败分布、p50/p95）
├── webui/
│   ├── server.js               # 唯一对外端口：前端 + IPC 桥 + 直连 API
│   ├── auth.js                 # 访问控制：凭据 / 同源 / Content-Type / 限流 / 审计
│   └── preload-bridge.js       # 浏览器侧 preload 垫片
├── tests/
│   ├── lint.sh                 # 仓库自检：行尾/BOM/语法/可执行位
│   ├── smoke.sh                # 起临时容器跑完整套件
│   ├── auth_probe.sh           # 纯 curl 的 401/403/415 与「/v1 必须回 JSON」断言（容器内也可跑）
│   ├── auth_selftest.js        # 不起容器，本地 harness 跑 webui 鉴权
│   ├── local_harness.js        # 上面那个自测用的假 shim + 假前端
│   ├── selfheal.test.js        # 自愈层单测
│   ├── observability*.{js,sh}  # 可观测层单测 / 集成 / 容器内冒烟 / 真实数据回放
└── .github/workflows/ci.yml
```

## 镜像体积

早先的构建方式得到 **1.01GB**（实际运行内容只有 13.8MB），原因两个：

1. 把整个 `node_modules` 打进去了。上游的 `externalizeDepsPlugin` 会把绝大多数依赖
   **内联进 bundle**，磁盘上只需要 exclude 列表里那几个包；当时没裁剪，
   302MB 依赖全进镜像，仅 `electron` 一个就 315MB。
2. 「先装后删」不减小镜像 —— 镜像按层累积，后续层删除只记 whiteout 标记。

改成两阶段后：**1.01 GB → 195 MB**（本文档早先写的 ~160 MB 是估算，不是实测）。
裁剪依据是上游 `externalizeDepsPlugin` 的 `exclude` 列表，
`shim/prune-deps.js` 递归保留依赖闭包并在**缺包时让构建失败**。

### 195 MB 花在哪（`docker export` 后逐项统计）

| 内容 | 体积 | 能不能删 |
|---|---|---|
| `/usr/local/bin/node` | **101.8 MB** | 不能，这就是解释器本体 |
| `app/`（bundle + 前端 + 自有代码） | 12.3 MB | 不能，业务代码 |
| `app/node_modules`（裁到 11 个包） | 14.5 MB | 部分：类型定义/测试夹具可删 |
| `usr/local/include/node`（C++ 头文件） | 4.9 MB | **能删** |
| `/opt/yarn-*` | 5.3 MB | **能删** |
| `/usr/local/lib/node_modules`（npm） | 4.6 MB | **能删** |
| 其余（musl、libstdc++、openssl、curl、tzdata） | ~14 MB | 不能，运行需要 |

**只要还用官方 `node:20-alpine`，体积下限就在 ~165 MB 附近**，因为那 101.8 MB 的
node 二进制是官方发行版，未 strip 且含调试符号。现在的 Dockerfile 已经删掉上表里
三行「能删」的 ~15 MB，并把 `node_modules` 里的 `.d.ts`/`.map`/测试目录一并清掉，
**实测约 180 MB**。想再往下只有三条路，各有代价，本项目暂不采用：

1. 换更小的 node 基础镜像（`node:20-alpine` 自身就有 136 MB，换 distroless 也只省十几 MB）；
2. 自己编译并 strip node（能省 ~40 MB，但构建时间翻倍且要维护工具链）；
3. 用 `pkg`/`bun build --compile` 打成单文件（省得最多，但上游 bundle 依赖 ESM wasm 与外置依赖，风险大）。

体积不是这个项目的瓶颈：真正值得关心的是 `/health` 报出来的**数据卷可写性、账号数和自愈状态**。

### 构建前的「落盘稳定」闸门（踩过两次的真事故）

镜像里装进去的到底是**最新版**还是**半写版**，没有任何东西替你检查。我们踩过两次：

- ops04：`shim/selfheal/index.js` 抓到的是 19:31 快照，`grep -c proxyStatus` = 0，
  于是 `/health` 的 proxy 检查永远 `known:false`；
- ops05：抓 stage 的那一秒 selfheal 正在落盘，拿到 2331/31522/6654，而他交付的是
  2855/32171/11386，于是 `/health` 里多出一条永远修不掉的 missing warning。

两次都不是代码没修好，是**构建上下文抓在了别人写文件的中间**。现在这条规则写进了脚本，
不再靠人记：`./deploy.sh build` 在 build 之前跑 `check_stable`——

```text
每个待拷文件（shim/ webui/ tests/ Dockerfile docker-compose.yml package.json UPSTREAM.lock）
  → 间隔 1.5s 两次 stat，size 与 mtime 必须一致
  → 不一致就等，最多 5 轮（≈7.5s）
  → 仍不一致：中止构建，不带着半写文件 build
```

等价的手工检查（群晖上 `stat` 没有 `-c`，用 `ls -ln`）：

```sh
for f in shim/selfheal.js shim/selfheal/index.js shim/health.js; do
  a=$(ls -ln "$f" | awk '{print $5, $8}'); sleep 1.5
  b=$(ls -ln "$f" | awk '{print $5, $8}')
  [ "$a" = "$b" ] || echo "还在写: $f"
done
```

交接时只要记住一句：**别人说『文件已就位』之前，不要抓 stage；抓完再核一遍 size。**

## 健康自检：`/health`

`GET /health` **不需要凭据**（它是探活接口，监控/容器编排都得能打），
但除探活外还回答一个更有用的问题：**这个实例现在能不能正常工作，不能的话卡在哪。**

```bash
curl -s http://192.168.1.10:8082/health | node -e 'const j=JSON.parse(require("fs").readFileSync(0));
console.log(j.status, j.ok, "| accounts:", j.accounts.total, "active", j.accounts.active, "error", j.accounts.error,
            "| cooling", j.accounts.cooling, "| mem", j.memoryMB, "MB", "| uptime", j.uptime, "s")
console.log("checks:", JSON.stringify(j.checks))
console.log("warnings:", j.warnings)'
```

### 什么时候 503

`HTTP 200` / `503` **不看账号健康**，只看两项检查：

| 检查项 | 含义 | 不过会怎样 |
|---|---|---|
| `store` | 数据卷可读**且可写** | 503 —— 读不到账号（没配置）或写不进去（会丢刚加的账号），都得人来修 |
| `proxy` | 代理状态是 `running` | 503 —— 端口活着但没有人在应答 `/v1` |

两项都过 → 200，`status` 是 `running`（或 `degraded`：服务在跑但自检自己超时了）；
否则 `status: "failing"`。**账号大面积 error 不会让 `/health` 变 503**——那是降级，不是挂掉，
它们进 `warnings`。监控可以直接用状态码，人看的时候再看 `warnings`。

### 响应里的字段

| 字段 | 说明 |
|---|---|
| `status` / `ok` | `running` \| `degraded` \| `failing`；`ok` 与 HTTP 状态码一致 |
| `upstream` | `version` / `ref` / `fetchedAt` / `imageBuiltAt` / `appVersion`——镜像里那个上游是哪个版本 |
| `store` | 数据目录的路径、可读、可写、剩余空间 |
| `accounts` | `total` / `active` / `error` / `inactive` / `cooling`，以及 `source`（这份数字从哪来：`selfheal` 快照 / `timeout` / `unavailable` / `account-list-count-only`） |
| `sweep` / `lastSweepAt` | 自愈巡检是否在跑、上次什么时候跑的 |
| `uptime` / `memoryMB` / `port` / `statistics` | 进程自身状况（端口就是从配置读的 8082，不会是别的数） |
| `checks` / `warnings` | 上面两项检查的明细，以及所有「能用但值得你看一眼」的事 |
| `auth` | 访问控制的摘要：鉴权是否开启、会话数、被锁的 IP、最近几条审计（**密钥本身永不出现在这里**） |

`warnings` 是给人看的，不是给监控 parse 的，常见的有：

- `no accounts configured - open the web UI at / to add one` —— 一个账号都没有
- `all accounts are in error state` —— 全挂了（大概率是上游改了协议或凭证过期）
- `data volume is read-only` / 剩余空间不足——容器还能跑，但加账号会失败
- `self-heal is disabled (CHAT2API_SELFHEAL=0)` —— 你把自愈关了
- `upstream ref is pinned to "…" (lock file), not branch main` —— 版本锁在具体 commit
- 自检超时：整套检查有 **1.5 秒**预算，超时返回 `degraded` + `accounts.source: "timeout"`，
  而不是卡住不回——健康检查自己挂掉是最难查的那种故障

响应头固定带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。

## 账号自愈（SELFHEAL）

### 为什么需要它

上游代理在遇到上游返回 401/403/风控时，会把账号**永久标记成 error**，之后不再尝试。
真实事故：某天 39 个 DeepSeek 账号同时变成 error，实际原因只是登录态被轮换——
而每一个账号其实都还能用（重新验证一下就恢复了）。要人一个个点过去修，等于停机。

自愈层做的事情只有一件：**在账号被判定失败时，先别急着下结论，验证一下。**

### 判定的分寸

| 上游的失败长相 | 自愈层怎么做 | 为什么 |
|---|---|---|
| 401 / 403（登录态失效） | 冷却 → 到点重新验证 → 有效就恢复、无效才定罪 | 这是唯一「可能真的是账号坏了」的一类 |
| 403 但正文是风控/验证码 | **不判定失败**，只做 2 分钟降级冷却，`status` 一个字不改 | 过滑块就能好，把好账号标 error 是自己造故障 |
| 429 / 5xx / 网络错误 | 不管 | 上游的问题，跟账号无关；这里动手只会把好账号带进沟里 |

恢复也不是一次就完：冷却时间按指数退避（默认 60s 起，翻倍，**最多 30 分钟**），
「冷却中」和「已坏」是两回事——冷却只是这个账号暂时不参与挑选。

### 参数

全部可选，都从环境变量读，默认值就是我们认为该用的值：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `CHAT2API_SELFHEAL` | 开 | 总开关；`0`/`false`/`no`/`off` 关闭（`/health` 会警告） |
| `CHAT2API_SELFHEAL_COOLDOWN_MS` | 60000 | 首次冷却时长（最小 1000） |
| `CHAT2API_SELFHEAL_COOLDOWN_MAX_MS` | 1800000 | 退避上限，30 分钟 |
| `CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS` | 120000 | 风控这类「降级冷却」的时长（不累积） |
| `CHAT2API_ACCOUNT_RECHECK_SEC` | 60 | 冷却结束后最多多久做一次重新验证（最小 5） |
| `CHAT2API_SELFHEAL_REVALIDATE_FRESH_MS` | 600000 | 10 分钟内验证过且有效的账号，再失败不重复验证（防验证风暴） |
| `CHAT2API_SELFHEAL_TIMEOUT_MS` | 20000 | 单次验证请求的超时 |
| `autoCheckAccountsIntervalMinutes`（或 `CHAT2API_SELFHEAL_SWEEP_MINUTES`） | 30 | 定时巡检间隔 |
| `CHAT2API_SELFHEAL_SWEEP_SPACING_MS` | 1500 | 巡检时相邻两个账号之间歇多久（别把自己打成风控） |
| `CHAT2API_SELFHEAL_SWEEP_MAX_ACCOUNTS` | 200 | 单轮巡检最多看多少个账号 |
| `CHAT2API_SELFHEAL_AUTO_STATUS` | 开 | **是否把冷却中的账号在管理页显示成 error**；设 `0` 则只冷却、不动记录 |

### 「冷却中」不等于「坏了」

这是最容易看错的一处：默认 `CHAT2API_SELFHEAL_AUTO_STATUS` 是开的，
所以一个正在冷却的账号在**管理页**上会显示成 error，
但 `/health` 里它是被单独计数的 `accounts.cooling`，**不会**计入 `error`。

```bash
curl -s http://127.0.0.1:8082/health | node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(j.accounts)'
# { total: 41, active: 39, error: 0, inactive: 0, cooling: 2, source: "selfheal" }
```

看到 `cooling` 大于 0 别慌，那 2 个正在等下一次验证，通常几分钟后自己回到 `active`。
如果确实不想让管理页出现红色，设 `CHAT2API_SELFHEAL_AUTO_STATUS=0`。

日志里能看见它们的动作：

```
[selfheal] account 7f3c… hit a captcha wall; degraded for 120s (status untouched)
[selfheal] rechecking 2 cooling account(s)
[selfheal] account 7f3c… recovered (status -> active)
```

## 请求日志与统计

上游的请求日志只记「成功/失败」和一段文本，出问题时只能靠肉眼扫。
这一层在**不改上游代码**的前提下，给每条失败请求补了机器可读的失败分类，
并把这些分类汇进管理页的统计里。

### 每条失败请求多了什么

上游原来的字段一个不动，只追加：

| 字段 | 取值 | 说明 |
|---|---|---|
| `failureCategory` | `auth` / `captcha` / `rate-limit` / `network` / `provider-5xx` / `client-error` / `unknown` | **成功的行是 `none`**（不是留空）。分类顺序有意：403 且正文像风控的一律算 `captcha`，不会被误判成 `auth` |
| `failureReason` | `Request failed with status code 403` | 不超过 240 字符的可读原因 |
| `providerResponse` | `{"error":…}` | 上游厂商返回的摘要（状态码 / 关键响应头 / 响应体），截断到 1–2 KB |
| `providerResponseMissing` | `true` | 只有 `HTTP 500` 这种裸状态、拿不到响应体时才置位——**绝不伪造原因** |
| `httpStatus` | `403` | 从错误消息里**点名**的上游状态码；行上的 `statusCode` 是回给客户端的（失败恒为 500），两者不是一回事 |
| `classifiedAt` | 毫秒时间戳 | 分类发生在什么时候 |

**脱敏先于截断**：`providerResponse` / `failureReason` 在写进去之前先过一遍凭据清洗
（`Authorization: Bearer …`、`sk-…`/`pk-…`、JWT、`x-api-key`、cookie/session/password
赋值、URL 里的 `access_token=`、以及长 base64 / 32+ 位 hex），全部替换成 `[REDACTED]`。
上游若把请求头回显进错误响应体，凭据也不会落进 `request-logs.ndjson`。

行是**冻结的**：注解只发生在写入时；升级前写下的旧行在**读**的时候用同样的规则现场补一次
分类——所以老日志也能直接参与统计，不需要重写文件。

### 统计里多了什么

`GET /management/statistics` 返回上游原有的一切，额外加上失败分布与延迟分位：

```bash
curl -s -H "Authorization: Bearer $(docker exec chat2api cat /data/.chat2api/.management-secret)" \
  http://127.0.0.1:8082/management/statistics | node -e 'const j=JSON.parse(require("fs").readFileSync(0));
console.log(JSON.stringify(j,null,2))'
```

新增的东西（都有测试守着）：

- `p50` / `p95` / `avgLatencyP50` / `avgLatencyP95`，以及分组统计里的 `latency: {samples,p50,p95,avg}`
- `failureCategories`：`{"auth": 40, "provider-5xx": 7, "captcha": 4}`
- `byProvider` 是**判断"谁在坏"最快的入口**：线上 101 条样本里 51 次失败按 provider 看是
  DeepSeek 39/87、Z.ai 7/7、Qwen AI 4/4；按账号看则是长尾——39 条 DeepSeek auth 失败散在
  **21 个账号**上（最多一个 4 条，10.3%），所以"掐掉几个坏账号"收效有限，看 provider 分组
  才看得出来是**上游/凭据面**的问题。
- `byAccount` / `byProvider` / `byCategory` / `byModel`：每组带
  `requests`、`success`、`failed`、`successRate`、`samples`、`p50`、`p95`、`avgLatency`
- `observed`（这一层自己数出来的计数）、`window`（统计窗口，无窗口时为 `null`）

响应头带 `X-C2A-Observability: statistics`，方便确认这一层确实装上了。

**合并是只加不减的**：上游原有的 `totalRequests` / `successRequests` / `failedRequests` /
`avgLatency` / `modelUsage` / `providerUsage` / `accountUsage` / `dailyStats` 原样保留，
并且有「不许丢掉上游任何已有字段」的断言守着——管理页不会因为多了这一层而白屏。

### 「成功/失败」按行上的状态词判定（升级后数字会变）

判定顺序是：行上的 `status` 词优先（`error`/`failed` → 失败，`success`/`ok`/`completed`
→ 成功）；没有状态词时才看 `statusCode`；两者都没有则算成功。

**升级后统计数字可能与旧版不同，原因是判定口径修正，不是数据出错。** 旧版只看
`statusCode`，而有一类失败（例如 `Failed to acquire token … (invalid token)`）在拿到任何
HTTP 状态之前就结束了，行上残留的 2xx 会让它被算成**成功**——旧版统计因此会高估成功率。
新版按行自己的状态词算，这类失败会被正确计为失败，所以 `successRequests` 可能下降、
`failedRequests` 可能上升（总量不变）。历史行不需要重算文件：分类与统计都在**读**的时候
按同一套规则现算。

### 边界：哪些情况有分类，哪些只有统计

这一层是**旁路**的，它看得到的是「上游已经把这条请求写进日志之后」的样子，所以有边界：

- **有 `failureCategory`**：请求走完代理链路、由上游自己写进请求日志的失败——
  包括鉴权失败、风控、限流、上游 5xx、网络错误。
- **没有 `failureCategory`，但会计入统计**：在**到达代理之前**就被挡下来的请求——
  我们自己的访问闸返回的 401/403/415/429、`/health` 探活、静态资源 404。
  这些不产生上游请求日志（它们根本没走到上游），但访问控制审计和统计能看见。
- **完全不进这一层**：进程启动阶段就失败的（比如数据卷不可写）——
  那时候日志库还没装好，这类问题看 `/health`。
- **装在哪一刻很重要，我们踩过这个坑**：上游的 `RequestLogManager` 是在 shim 安装
  **之后**才被 `initialize()` 创建出来的——安装的那一刻，`storeManager.requestLogManager`
  还是 `null`。如果只在安装时探一次然后包住当时拿到的对象，就会"看起来装上了、实际包了个
  空对象"，之后每一条请求都不会带上分类，且启动日志看不出异常。这一层的做法是给这个属性
  装一个访问器：**上游一赋值就立刻包住**，所以进程重启后的第一笔失败就能带分类，不用等到
  第二笔。启动日志会明说处在哪条路径上：
  `request log declared at "storeManager.requestLogManager" (level3) … armed`。
- 分类依据是**响应体/异常文本的规则匹配**，不是厂商 API 契约。上游改了文案，
  最差的结果是落到 `unknown`（不会错分类到别处，也不会丢行），届时补一条规则即可。

换句话说：**看「为什么这个请求失败了」去日志里找 `failureCategory`；
看「今天失败了多少、快慢如何」看统计；看「服务本身还能不能用」看 `/health`。**

## 常见问题

**界面能打开，但接口报 401 / 跨站 403**

界面和接口用的是两种凭据。浏览器打开着会话 Cookie 不代表脚本能直接调：
脚本要带 `Authorization: Bearer <管理密钥>`；反向代理如果改写了 `Host`/
`X-Forwarded-*`，把 `CHAT2API_TRUST_PROXY=true` 打开，否则同源校验看不到真实主机名。

**拉取镜像失败**
先确认镜像站地址可用；必要时改回官方 `ghcr.io/liangnianzhi/chat2api:latest`
（私有包需 `docker login ghcr.io`）。

**界面右上角端口不对**
应为 `:8082`。若显示别的数字，说明镜像是旧版——`./deploy.sh pull` 后在群晖里
重置容器。

**点 OAuth 登录没反应**
确认镜像是含弹窗预开逻辑的版本。另外上游的 OAuth 只是「打开浏览器登录页」，
登录后仍需手动贴 token。

**界面打不开但 /v1 正常**
看日志里有没有 `captured the HTTP request handler` 和
`proxy handler captured; starting the front server`。

**`/health` 返回 503**
只有两种可能，看 `checks` 里哪一项是 `ok: false`：`store`（数据卷不可读/不可写，
看挂载与权限）或 `proxy`（代理没起来，看容器日志）。账号全红**不会**导致 503。

**管理页里有一堆账号突然变成 error**
先看 `/health` 的 `accounts.cooling`：如果是它们，说明是冷却中的账号被显示成了 error
（默认行为），等几分钟会自己回到 active；不想看到红色就设 `CHAT2API_SELFHEAL_AUTO_STATUS=0`。
如果 `cooling` 是 0 而 `error` 很大，才是真的凭证失效，去界面重新添加。

**`/health` 里 `accounts.source` 是 `timeout`**
自检有 1.5 秒预算，机器太忙或数据卷很慢时它会放弃等待并返回 `degraded`——
这时候 `accounts` 的数字不可信，其余（`checks`、`store`）仍然有效。多打两次通常就正常了。

**统计里看不到某个失败请求的分类**
看上面「边界」一节：在到达代理之前就被访问闸挡下的 401/403/415 不进请求日志，
它们只会出现在访问控制的审计里（`docker compose logs` 里搜 `[audit]`）。

## 许可

上游 Chat2API 为 **GPL-3.0**。本仓库只包含部署适配层，构建时从上游获取源码，
镜像中包含编译后的上游代码（含其前端），因此**分发镜像时同样受 GPL-3.0 约束**。
