# shim/selfheal — account health self-healing

这一层修补的是上游最贵的一个缺陷：**一个坏掉的账号会让每一个请求都白白等满超时**。
线上证据（生产 request-logs）：101 次请求里 51 次 500，其中 39 次是同一个 DeepSeek 账号
token 失效，上游 `isAuthError()` 没认出 `Failed (invalid token)` 这个词序，于是账号永远保持
`active`，后续每个请求都排到它、等 18 秒、再 500。

补丁做的事：**认出**这类失败 → 后台**复核**一次 → 复核失败就**冷藏隔离**一段时间 → 到期自动
**复核恢复**；再加上后台巡检、token 缓存失效、失败原因保真，以及一条可直接用 `docker logs`
验证的状态变更日志。

---

## 1. 上游 bundle 的实际形状（跟版上游时先读这一节）

上游是 Electron 主进程的 Rollup CJS 产物。容器里 `require('/app/upstream/main/headless.js')`
**不会导出任何东西**（它只 `require('./chunks/server-*.js')` 然后跑 `main()`），所以
`electron-shim.js` 拿到的 graph 是空的。所有类都在 chunk 里，以 `exports.X = X` 的形式导出：

```
AccountManager, ConfigManager, ProxyServer, ProviderChecker, ProviderManager,
DeepSeekAdapter, GLMAdapter, KimiAdapter, MimoAdapter, MiniMaxAdapter,
PerplexityAdapter, QwenAdapter, QwenAiAdapter, ZaiAdapter,
axios, config, commonjsGlobal, storeManager, sessionManager, proxyStatusManager,
getBuiltinProvider, getBuiltinProviders, generateManagementSecret, normalizeCookies,
refreshQwenAiToken, extractQwenAiRefreshToken, getDefaultExportFromCjs, requireSrc
```

**没有 `RequestForwarder`**：它是 chunk 内的局部类，对外只暴露一个单例
`const requestForwarder = new RequestForwarder()`，**没有任何导出路径**（实测在对象图上按
depth≤3 扫 `requestForwarder`/`proxyRequestHandler`/`handlers`/`loadBalancer` 全是 undefined）。
`ProxyServer.prototype` 也够不着它（只有 `setupMiddleware/setupRoutes/start/stop/...`）。
所以包装 `forwardChatCompletion` 这条路在真实 bundle 上**走不通**，本层改包两处**确定可达**的接缝：

| # | 接缝 | 为什么是它 | 干什么 |
| --- | --- | --- | --- |
| 1 | `ProxyServer`（构造函数） | 唯一能在 router 之前插中间件的时机：构造函数里同步 build 完 koa 栈 | 子类 `super()` 后 `app.middleware.unshift(tap)`，看住 `/v1/chat/completions` 的**结果** |
| 2 | `LoadBalancer.prototype.getAvailableAccounts` | **真实请求链上唯一的选号点** | 冷却期否决：把冷却账号从候选里剔掉 |

### 1.1 选号否决为什么打在 LoadBalancer 而不是 AccountManager

真实 `POST /v1/chat/completions` handler（chunk 内 150770–150960）的链路是：

```
handler → loadBalancer.selectAccount(model, strategy, preferredProviderId, preferredAccountId)
        → LoadBalancer.getAvailableAccounts(...)
        → storeManager.getAccountsByProviderId(providerId, true).filter(isAccountAvailable)
        → forwardChatCompletion(...)
```

`isAccountAvailable()` 只看 `account.status !== 'active'` 和 `dailyLimit`。
**`AccountManager.getAvailable()` 完全不在这条链上**（它只被别处/旧代码用），所以早先的
`wrapAvailable(AccountManager.getAvailable)` 对真实 bundle 是**空转**：冷却登记了，但选号照旧
把坏账号发出去。修正后：

- `wrapLoadBalancer` 在拿到 `getAvailableAccounts()` 的结果后，逐个按
  `health.isCoolingDown(entry.account.id)` 剔除，被剔除时打
  `[selfheal] skipped N cooling account(s) while selecting an account`；
- 否决发生在**上游 handler 拿到候选之前**，所以坏账号不会进入 `accountConcurrency`、不会去连 provider；
- `wrapAvailable` 保留为兼容兜底（对 stub 图/未来上游形态仍有用），但**不再是指望的那道闸**；
- 本地裁决码（`503 no_available_account`、`429 account_busy`）**绝不当账号失败**：它们不是 provider
  的错，记 strike 会让冷却自我续期，把账号永久关在门外。

### 1.2 结果观察怎么做到不误判

`proxy-tap.js` 在请求返回后看 koa 的结果：真实失败体是
`{error: {message, type, param, code}}`（不是 `{success:false}` 信封——那只是 forwarder 的返回值，
到不了 koa），成功体是 provider payload（`{id, choices, ...}`）或 stream。
**"这个请求是谁服务的" 只能由真实 picker 告知**：`bindToRequest(ctx, kept)` 在
`getAvailableAccounts` 过滤之后把集合写进 `ctx.state.selfhealFastPool`（带 `bound:true`），
只有 `bound && certain`（池里恰好 1 个）才敢把结果归因给该账号。早期版本在 `next()` 之前
把"池里只有 1 个"当作服务者，结果冷却导致池空 → `503 no_available_account` → 被误判成该账号
"成功" → `onSuccess` 把刚设的合法冷却清掉了。现在 `bound` 标记让这种误判不可能发生。

图形解析也是三级：`install({graph})` 给的 graph → 若发现是 headless 入口（有 `storeManager`、
没有 `AccountManager`）则自己扫 `upstream/main/chunks/server-*.js` 并 require 第一个含
`AccountManager` 的 chunk（日志 `[selfheal] upstream graph resolved from chunks/<name>`）→
都不行就整体降级：`install()` 返回 `{enabled:false, installed:{...}}`，只发布一个 `enabled:false`
的快照，**绝不抛错、绝不影响容器继续服务**。

跟版上游时要复看的内部点：

1. `AccountManager.validate(id)` / `getAll()` / `updateStatus(id, status, msg)`
2. `LoadBalancer.prototype.getAvailableAccounts` 的名字与返回形状（`[{account, provider, actualModel}]`）
3. `ProxyServer` 构造函数的时序（必须在 `new App()` 之后、`listen()` 之前 unshift 中间件）
4. 各 Adapter 的 `acquireToken()` 与 `buildErrorMessage(status, data)`（token 缓存在这两处）

`isAuthError()`（上游）的词表是 `unauthorized / session has expired / no longer valid / sign in /
token is invalid / token expired / token invalid / auth.token.invalid / login+expired` ——
**没有 `invalid token` 这个词序**，这就是 39 次 500 的根因。本层不依赖它。

---

## 2. 四个动作

### 2.1 运行期失败识别 + 后台复核 + 冷却

`auth-errors.js` 的事故词表（不依赖上游 `isAuthError`）：`invalid token`、`invalid_token`、
`token is invalid`、`token invalid`、`token expired`、`token has expired`、`token is expired`、
`authorization failed`、`unauthorized`、`403`/`401`、`please get a new token`、`缺少 token`、
`重新登录`、`session has expired`、`no longer valid`、`api key is invalid`、`token is revoked` …
（完整表见 `auth-errors.js: AUTH_KEYWORDS`，配套 `AUTH_STATUSES = {401, 403}`）。

判定顺序：**captcha → auth → rate → server → network → unknown**。顺序很重要：
qwen-ai 的 `Qwen AI 风控拦截（需要验证码校验）` 必须先判成 captcha，否则它会被 auth 分支误判、
把一个 token 完全正常的账号写成 `error`。

失败后的动作（`runtime-hooks.js: recheck`），**永远在请求路径之外异步执行**：

```
auth 失败
   └─ 后台 validate(accountId)（上限 CHAT2API_SELFHEAL_TIMEOUT_MS，默认 20s）
        ├─ valid        → 清冷却、日志 'passed re-validation … keeping it in rotation'
        ├─ networkError → 结论不确定，不动账号（只是网络抖）
        └─ invalid      → 冷却 + updateStatus(id,'error',原因) + 失效 token 缓存
```

冷却期（`account-health.js`）默认 60s，按连续失败次数指数退避（×2），上限 30 分钟；
冷却中的账号由 `AccountManager.getAvailable()` 的包装 `filterAvailable()` 直接剔掉，
**不会再有请求排到它**。冷却期满不会自动算作健康，下一次巡检或下一次失败复核会重新判定。

> **冷却 ≠ 账号状态。** 冷却只影响本进程的账号选择器，**冷却期满会自动复核并恢复**；而
> `status = error` 是写给上游管理页/存储看的事实，只有当 `AccountManager.validate()` 明确说
> token 无效时才写。两者都开着（默认）是为了让管理页不再把坏账号显示成 `active`，
> 免得上游自己又把请求派给它。

#### 2.1.1 失败是从哪里进来的（归因链路，跟版上游时必读）

线上 bundle **不导出** `RequestForwarder`（`class RequestForwarder` 在 148847 行、
`const requestForwarder = new RequestForwarder()` 在 150029 行，都在模块作用域内），所以
“包一层转发器”这条路根本不存在。实际可用的接缝只有两个，而且分工不同：

| 接缝 | 能看见什么 | 用来做什么 |
| --- | --- | --- |
| `electron-shim.js` 捕获的 `httpHandler`（`__setSelfhealTap`） | 请求/响应字节、状态码 | **观察**结果：尾部 8KB 缓冲、抽出 `error.message`、判 captcha/rate。**永不接管请求** |
| `DeepSeekAdapter.acquireToken` / `GLMAdapter.acquireToken`（`token-cache.js` 包装） | **确切的那个 account**（`this.account`）与抛出的错误 | **归因 + 触发**：失败时回调 `onAcquireFailure(providerId, account, err)` → `hooks.onFailure()` |

为什么必须靠 adapter 归因：HTTP 观察器只拿得到 `req`/`res`，不知道这次请求用了哪个账号；
而 `loadBalancer` 与 `RequestForwarder` 都没有导出。adapter 的 `acquireToken()` 是唯一
既可达、又确切知道账号的地方，而且 `'Failed to acquire token: … (invalid token)'` 正是在
那一层抛出的——39 次线上失败就在这里止步（上游 `isAuthError` 的词表没有 `invalid token`
这个词序，所以它既不降级也不换号，只能等满 18s 的超时/重试预算）。

没有 `account.id` 的失败（罕见）只打 `… token acquisition failed without an account id: …`，
**不做任何猜测性归因、不停用任何账号**——误停一个健康账号比放过一次失败更贵。

### 2.2 captcha / 风控类 = 短冷却 + 不定罪（degraded）

qwen-ai 那 4 条真实失败是 `风控拦截（需要验证码校验）`——token 是好的，是上游在拦人。
如果照『captcha 永不冷却』处理，这类账号**每次仍然白等 19 秒**，等于没修。所以：

* `degrade: true` 的短冷却（`CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS`，默认 **120s**）
* **不写 status、不加 strike**（`冷却 ≠ 定罪`），所以反复触发也**不会**指数升级成几小时的封禁
* 冷却期满自动重新参与调度；一次成功转发就清掉

代价与取舍：风控墙通常持续几分钟到几小时，120s 只是让『每次白等』变成『每两分钟白等一次』。
要更激进就调大这个值；不想有任何降级就设 `CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS=0` 之类
取不到的值（会被下限夹到 1s，等价于不降级）。

### 2.3 后台巡检

`sweep.js` 的 `AccountSweeper`：启动后立刻扫一次，之后按 `autoCheckAccountsIntervalMinutes`
（默认 **30 分钟**）周期性扫描；**非 active 账号默认 60s 就复核一次**（`CHAT2API_ACCOUNT_RECHECK_SEC`），
好让刚修好的账号尽快回到池子里。

* 串行 validate，每个账号之间 sleep `CHAT2API_SELFHEAL_SWEEP_SPACING_MS`（默认 1500ms）——
  限速是为了别把上游（DeepSeek `/v0/users/current` 单次约 3.8s、GLM 约 5.8s）打爆；
* 每轮最多 `CHAT2API_SELFHEAL_SWEEP_MAX_ACCOUNTS`（默认 200）个账号，剩下的下一轮继续；
* 巡检发现 invalid 的账号同样进冷却（并写 status），日志与状态变更都带 `source=sweep`；
* 巡检结果写回 `lastSweepAt` / `badAccountCount`，由 `/health` 暴露。

### 2.4 token 缓存失效

`deepseek.ts` / `glm.ts` 有模块级 `tokenCache`（1 小时 TTL）且**没有清除导出**。本层不去改上游
源码，而是包 `DeepSeekAdapter.prototype.acquireToken` / `GLMAdapter.prototype.acquireToken`，
用**从凭据派生的 key**（deepseek: `token || apiKey || refreshToken`；glm: `refresh_token || token`）
打标记：`tokens.invalidate(account)` 之后，下一次 `acquireToken()` 命中标记就先删标记再放行，
`tokens.stats().refreshed` 计数。**不依赖上游任何内部 Map 变量名**，上游改名也只是『标记不打』，
不影响正确性（只是退回 1 小时 TTL）。

### 2.5 失败原因保真

上游有 4 处 provider 分支用 `validateStatus: () => true` 拿到 4xx/5xx 却不抛，改用自己 `throw`
一个只带状态码的 `Error`，手里那份 `response.data` 就丢了——线上那 7 次 zai 失败因此在日志里
只剩 `HTTP 500`。

**打的是哪些接缝（以当前随镜像发布的 bundle 实测为准）**：

| 接缝 | 上游行 | 丢弃的原文 |
| --- | --- | --- |
| `ZaiAdapter.prototype.createChat` | 145919 | `Failed to create chat: HTTP ${response2.status}` |
| `ZaiAdapter.prototype.ensureToken` | — | `Token refresh failed: HTTP ${status}` |
| `KimiAdapter.prototype.chatCompletion` | 42332 | `Completion request failed: HTTP ${response2.status}` |
| `GLMAdapter.prototype.acquireToken` | 41227 | `message2` 缺失时退化成 `HTTP ${response2.status}` |

替换规则只有一条：**消息本身没信息量时才补**。`enrichHttpMessage()` 用一个正则判定
“空壳消息”——整条消息形如 `HTTP 500`，或 `<任意前缀>: HTTP 500`：

```js
const BARE_STEM = /^(?:.*:\s*)?HTTP \d{3}$/
```

命中则用响应体摘要（≤200 字符）追加上去，`error.selfhealOriginalMessage` 保留原文以便 grep；
**未命中一律原样返回**——`Failed to acquire token: Authorization Failed (invalid token)` 这种
自带病因的消息绝不能被拼接污染，否则 `classifyFailure()` 的词表匹配会被稀释。

状态码的来源有两个：`error.response.status`（axios 抛的），或消息文本里那个数字
（adapter 自己 `throw` 的，没有 `response`）——`statusOf()` 依次尝试，所以补出来的消息
是 `Failed to create chat: HTTP 500 - quota exhausted` 这种形态，而不是丢掉状态码的 `HTTP error`。

#### 不可协商的约束：**自带病因的消息绝不被污染**

`enrichHttpMessage()` 只允许改写**空壳消息**。任何已经说明了原因的消息必须**逐字节原样返回**，
包括但不限于：

```
Failed to acquire token: Authorization Failed (invalid token)
Failed to acquire token: "..." Failed (invalid token)
Authorization Failed (invalid token)
Qwen AI 风控拦截（需要验证码校验）
```

理由不是风格，是**功能依赖**：`auth-errors.js` 的 `AUTH_KEYWORDS` 靠这些词序识别 auth 类失败，
`classifyFailure()` 的分支顺序也建立在消息文本上。往前拼接前缀（哪怕只是 `provider: `）会稀释
匹配，直接导致本层最核心的降级动作失效——这正是上线前要修的那个 18 秒缺陷。

所以：**不要为了日志好看往消息前面加前缀，不要往里塞 trace id，不要改成结构化的 `{code, msg}`。**
要加上下文请加在 `state-change` 日志行或 `errorMessage` 之外的字段里。
`error.selfhealOriginalMessage` 的存在就是为了让被改写的那少数几条仍可 grep 回原文。
回归测试：`tests/selfheal.test.js` 里的 `a message that already carries a body is left alone`
（断言带病因的消息逐字节不变）与 `a body-less HTTP 500 gains the provider body`（断言空壳消息才被补）。

**关于 `absent` 与 `missing`（运维会看到的那条 warning）**：

- `absent`：这个上游构建里**根本没有**这个接缝（改名或被内联）。上游漂移是常态，我们只打一行
  `[selfheal] reason-fidelity seams not present on this build: ...`，**不进 `/health` 的 warnings**。
  一条永远修不好的警告比没有警告更糟。
- `missing`：类找到了但方法没打上补丁——这才是真正值得看一眼的漂移，进 `snapshot().installed.missing`。

**例外：`critical` 接缝**。`ZaiAdapter.createChat` 被标为 `critical`——它就是那 7 条 `HTTP 500`
的来源，它的缺席会直接改变运维看到的日志内容，所以即便整个类在上游消失，也**照样进 `missing`**
（文案会带上 `(class not exported by this build)` 或 `(method renamed by this build)`），由 `/health`
原样透传到 warnings。其余接缝缺席则安静地进 `absent`。

> 历史更正：早期版本声称包 `RequestForwarder.extractErrorMessage` 和
> `GLMAdapter/DeepSeekAdapter.buildErrorMessage`。实测 `RequestForwarder` 是 chunk 内局部类、
> **没有任何导出路径**（`extractErrorMessage` 是其实例方法），而 `buildErrorMessage` 在整包
> **0 次出现**。这三个名字是未经验证的假设，已全部删除，不再出现在 `missing` 里。

---

## 3. 配置（全部可选，环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAT2API_SELFHEAL` | 开 | `0/false/no/off` 整层关闭 |
| `CHAT2API_SELFHEAL_COOLDOWN_MS` | `60000` | 确认无效后的基础冷却 |
| `CHAT2API_SELFHEAL_COOLDOWN_MAX_MS` | `1800000` | 指数退避上限 |
| `CHAT2API_SELFHEAL_DEGRADED_COOLDOWN_MS` | `120000` | captcha/风控的短冷却（不定罪） |
| `autoCheckAccountsIntervalMinutes` | `30` | 巡检周期（分钟）；也认 `CHAT2API_SELFHEAL_SWEEP_MINUTES` |
| `CHAT2API_ACCOUNT_RECHECK_SEC` | `60` | 非 active 账号的复核间隔 |
| `CHAT2API_SELFHEAL_REVALIDATE_FRESH_MS` | `600000` | 多久内的复核结果算『新鲜』，不重复打上游 |
| `CHAT2API_SELFHEAL_TIMEOUT_MS` | `20000` | 单次复核上限（防挂死） |
| `CHAT2API_SELFHEAL_SWEEP_SPACING_MS` | `1500` | 巡检账号之间的限速 |
| `CHAT2API_SELFHEAL_SWEEP_MAX_ACCOUNTS` | `200` | 单轮巡检账号上限 |
| `CHAT2API_SELFHEAL_AUTO_STATUS` | `1` | 是否把复核结论写回上游 status（关=只冷却不改记录） |

---

## 4. 对外读接口

`globalThis.__chat2apiSelfHeal`（由 `install()` 发布）。

**发布时机是契约的一部分**：`install()` 在**每一条**路径上都发布，成功、降级、抛错都算——
入口层用 `try/catch/finally` 兜住，`SelfHeal.install()` 内部的每条 `return` 也各自发布。
理由：`/health` 不 import 本模块，它只读这个全局；`install()` 成功却没发布，整套自检就会变成
`proxy status is not readable from this build`，而这个现象会被误读成“自愈没装上”。
`enabled=false` 时同样发布（`snapshot().enabled === false`、`installed.missing` 说明原因），
让 `/health` 能区分“关着”和“坏了”。

回归测试：`tests/selfheal.test.js` 的 `install() publishes the global on the healthy path` 与
`install() still publishes when the upstream graph is unusable` 两条，验证过删掉发布路径它们会红。


**公开方法（唯一契约，`enabled=false` 时也全部存在）**

| 方法 | 同步/异步 | 返回 | 失败行为 |
| --- | --- | --- | --- |
| `snapshot()` | 同步 | 完整状态对象：`{enabled, startedAt, lastSweepAt, sweep, accounts|null, badAccountCount, cooling[], hooks, token, installed, config}` | 绝不抛；内部错误时返回降级对象（`enabled:false`） |
| `info()` | 同步 | 小对象：`{installed, enabled, lastSweepAt, coolingAccounts, badAccountCount, lastSweepError, config, proxyStatus, version}` | 绝不抛；异常时 `{enabled:false, lastSweepError:'snapshot failed'}` |
| `proxyStatus()` | **同步** | `{running, port, uptimeMs, startedAt, inflight, totalRequests}` 或 `null` | **绝不抛**；读不到返回 `null`（= 读不到，**不是** 挂了） |
| `checkNow()` | 异步 | `Promise<summary>`：立即跑一轮巡检（忽略调度） | 返回的 Promise 会 resolve，不 reject |
| `refreshAccounts()` | 异步 | `Promise<Array\|null>`：只刷新账号列表缓存，**不做 validate** | 失败 resolve `null` |

`proxyStatus()` 字段含义（`shim/health.js` 用它判『代理活着』）：

| 字段 | 含义 | 缺省 |
| --- | --- | --- |
| `running` | `ProxyStatusManager.getRunningStatus().isRunning` | 恒有（布尔） |
| `port` | `getPort()`，即代理实际监听端口 | `null` |
| `uptimeMs` | `getRunningStatus().uptime`，进程内已运行毫秒 | `null`（未启动） |
| `startedAt` | `getRunningStatus().startTime`（epoch ms） | `null` |
| `inflight` | `getStatistics().activeConnections`，当前在途连接数 | `null` |
| `totalRequests` | `getStatistics().totalRequests` | `null` |

实现上它只读上游 `proxyStatusManager` 已有字段：上游**没有** `getStatus()`，只有
`getRunningStatus()`/`getStatistics()`/`getPort()`；`getStatistics()` 会调 `cleanupOldTimestamps()`
（很轻但不是纯读），所以它被单独 try/catch 包住，失败只让 `inflight`/`totalRequests` 变 `null`，
不影响 `running`。整个方法不 await、不发网络请求、不排程，实测 < 1ms（有用例断言 < 5ms）。

`/health` 期望的形状（`shim/health.js`）：`lastSweepAt`、`badAccountCount`，以及
`cooling[]`（含 `degraded` 标记）；`proxyStatus()`（同步，`null` = 读不到，建议按 degraded 处理而非 running）；
`info().config.autoStatus` 为真时建议在 warnings 里写一句
『被冷却的账号会在管理页显示 error』，避免用户困惑。

状态变更日志（`docker logs` 可直接 grep，每行一条、不含凭据）：

```
[selfheal] state-change account=acc-1 provider=deepseek old=active new=error \
           reason=validate-invalid source=runtime class=Failed_(invalid_token) \
           cooldown_ms=60000 validate_ms=3812 strikes=1 detail="Failed (invalid token)"
```

`reason` 取值：`validate-invalid`（复核确认无效）、`validate-ok`（复核恢复）、`captcha`（风控降级）、
`request-ok`（成功请求清冷却）、`sweep-invalid`（巡检发现坏账号）。

---


## 7. 遗留与边界（如实记录，勿美化）

1. **第一笔失败的 18 秒在补丁后依然存在。** 那 18s 是上游 `forwardChatCompletion` 内部的
   重试预算（deepseek 会重试 13–16 次 `acquireToken`），本层消除不了；要消除必须 patch chunk，
   超出本次范围。补丁的收益只发生在**第一笔之后**。
2. **`LoadBalancer` 未导出**，所以选号否决实际是靠『写 `status` + 冷却过滤（`filterAvailable`）』
   落地的，不是包装 picker。上游自己因为 `status !== 'active'` 就会拒掉，冷却则覆盖 status 写回
   之前那段窗口。
3. **管理 API `PUT /accounts/:id` 不接受 `status`**（源码 152668–152700 只收 name/email/
   credentials/dailyLimit），所以测试环境里把一个被标成 `error` 的账号改回 `active` 只能新建账号。
4. `ProxyServer` 子类路线**已删除**：chunk 在模块求值期就 `new ProxyServer()`，那一刻的实例才是
   正在服务的那个，子类化只能影响没人用的未来实例（实测数百请求零中间件调用）。现在的请求路径由
   http observer（步骤 0）+ adapter 归因（token-cache）承担。
5. provider 级熔断**未做**：可达接缝只有上面两个，做 provider 熔断要么得碰选号逻辑（LoadBalancer
   未导出），要么得在 `forwardChatCompletion` 外面猜 provider，而且会和上游 `retryCount=3` 互相
   打架，改动量必然超过阈值。账号冷却已作为兜底实现。

## 8. 与观察性模块的边界

账号对象上的 `errorMessage` 归本模块（稳定分类 + provider 响应体摘要，≤200 字符）；
`failureCategory` / `failureReason` / `providerResponse` 这类**请求日志字段**归 feature-obs。
本模块**不往请求日志行上写任何分类字段**，两边不互相污染（`tests/selfheal.test.js` 有对应断言）。

## 5. 测试

```
node tests/selfheal.test.js     # 73 checks, no framework, no devDependencies
```

覆盖：auth 词表矩阵（含 39 次事故的原句）、captcha/rate/network 不误判、冷却生命周期与指数退避、
degraded 短冷却不加 strike、`due()` 调度、巡检串行与限速、原因保真、token 缓存 key、
`state-change` 行格式与凭据泄露、`info()` 形状、配置解析、adapter 归因（确切账号被停放、
无 `account.id` 时只告警不误停），以及一组**真实 bundle 形状**的集成用例：
`{error:{message,type}}` 失败体、`503 no_available_account`/`429 account_busy` 本地裁决不计 strike、
成功体不被误判、`LoadBalancer` 接缝否决冷却账号、captcha 在真实路径上 degraded 且从不写 status。

### 测试纪律（写新用例前必读）

1. **时间只能靠构造时注入的可变时钟**：`new SelfHeal({ now: () => clock })` / `new AccountHealth({ now: () => clock })`，
   用 `clock += 61000` 推进。
   **不要事后改实例字段**（`self.now = ...`、`self.health.now = ...`）——`AccountHealth` 在构造时就把
   `opts.now` 存成自己的字段，冷却记录 `until` 是**绝对时刻**，改外层实例对已构造的对象没有任何作用，
   于是"冷却永不过期"，用例只会在某些执行路径下变红（本仓库就发生过一次 `FAILED 1 of 71`）。
2. **不依赖用例顺序**：每个用例自己 `health.reset()`、自己种下所需的冷却/状态，不要吃上个用例留下的
   `hooks` 状态或账号注册表。
3. **断言的因果要指向本层**：例如"冷却账号没被发出去"，要同时断言**未包装的 picker 仍能看到它**
   （`getAvailableAccounts.__selfhealOriginal`）而**包装后的看不到**，否则分不清是上游把它挡了还是我们挡的。
## 6. 线上验证记录（2026-11，群晖 NAS 只读副本容器）

验证方式：`ghcr.nju.edu.cn/liangnianzhi/chat2api:latest` 起独立容器（`--network personal`、
独立数据卷，**不碰生产容器 `chat2api` 与其 `/volume1/docker/chat2api/data`**），用管理 API
造一个 `credentials.token = 40 个 0` 的假 DeepSeek 账号（新建即 `status: active`），
直接打 `POST /v1/chat/completions`（`model: deepseek-v4-flash`）。

| 场景 | HTTP | 耗时 | 说明 |
| --- | --- | --- | --- |
| 补丁前/首次失败（同一死账号的第一笔请求） | 500 | **17.1 – 18.7s** | 上游在 `acquireToken` 内部重试约 13–16 次，每次都拿回 `40003 Authorization Failed (invalid token)`；与线上 18 秒空等一致 |
| 同一账号的第二笔请求（复核已被后台完成） | 503 `no_available_account` | **0.144 – 0.155s** | 账号已 `status: error` 且处于冷却，选号阶段直接否决，**不再空等** |
| 第三笔请求 | 503 | 0.144s | 同上，稳定 |

对应日志（同一账号 `1793624533548-dh8i3g7g9`）：

```
[selfheal] auth failure on account 1793624533548-dh8i3g7g9 (deepseek): Failed to acquire token:
  Authorization Failed (invalid token) [matched: authorization failed] - re-validating in the background
[selfheal] state-change account=1793624533548-dh8i3g7g9 provider=deepseek old=active new=error
  reason=validate-invalid source=runtime class=Token_expired_or_invalid cooldown_ms=60000
  validate_ms=786 strikes=1 detail="Token expired or invalid"
[selfheal] token cache invalidated for account 1793624533548-dh8i3g7g9 (deepseek)
[selfheal] account 1793624533548-dh8i3g7g9 (deepseek) is invalid: Token expired or invalid - parked for 60s
```

**必须如实说明的一点**：补丁**不会**让第一笔失败变快。第一笔仍要等上游自己的重试预算走完
（它就是那 18 秒的来源，而且这一段在 `forwardChatCompletion` 内部，bundle 不导出、改不了）。
补丁的收益是**第一笔之后**：后台复核在 ~0.8s 内判定该 token 无效，账号被停放并写 `error`，
后续请求在毫秒级被否决，而且不会再有请求排到它。对线上“同一账号连续 39 次失败”的模式，
这正好是把 39 × 18s 压缩成 1 × 18s + 38 × 0.15s。
