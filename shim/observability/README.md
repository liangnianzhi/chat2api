# shim/observability — 请求日志失败分类与统计增强

本目录是 Docker 版 chat2api 的**可观测性层**：它不改上游代码，只在运行时
包装上游的请求日志存储与 `/v0/management/statistics` 端点。

## 为什么需要

线上 101 次请求里 51 次 500，但日志里看不到原因：

| 失败 | 次数 | 日志里原来的样子 | 问题 |
| --- | --- | --- | --- |
| DeepSeek token 失效 | 39 | `Failed to acquire token: "…" Failed (invalid token)` | 每次空等 18s，统计里只是一次普通失败 |
| zai | 7 | 只有 `HTTP 500` | 上游 `zai.ts` 构造错误时丢了响应体 |
| qwen-ai 风控 | 4 | 验证码文本混在错误里 | 同上，无法和"真 500"区分 |
| qwen 403 | 1 | `Request failed with status code 403` | 归到了"服务端错误"，看不出是凭据问题 |

真实数据复核后的分类结果（101 条历史行，历史回填）：

```
none 50 | auth 40 | provider-5xx 7 | captcha 4      (unknown 0)
DeepSeek/auth 39   Qwen/auth 1   Z.ai/provider-5xx 7   Qwen AI/captcha 4
```

## 做了什么（全部是新增字段，不改原有字段含义）

### 1. 请求日志行

每一行（包括启动前就存在的历史行）都会补上：

| 字段 | 含义 |
| --- | --- |
| `failureCategory` | `auth` / `captcha` / `rate-limit` / `network` / `provider-5xx` / `client-error` / `unknown`；**成功的行是 `none`**（不是留空） |
| `failureReason` | 不超过 240 字符的可读原因 |
| `providerResponse` | 上游响应摘要（状态 / 关键响应头 / 响应体），最长 2048 字符（1-2 KB） |
| `providerResponseMissing` | 只有 `HTTP 500` 这类裸状态、拿不到上游响应体时为 `true` |
| `httpStatus` | 真正的上游状态码（从消息里点名的状态解析而来） |
| `classifiedAt` | 分类时间戳（ms） |

响应体来源按优先级：`err.response`（axios 风格）→ `err.body/data/responseBody` →
**错误消息里内嵌的 JSON/HTML/长文本**（zai、qwen 这类把响应体拼进 message 的地方）。
`HTTP 500` 这种裸状态永远不会被伪造成响应体。

**脱敏**：`providerResponse` / `failureReason` 在截断**之前**先过一遍凭据清洗——
`Authorization: Bearer …`、`sk-…`/`pk-…`、JWT（`eyJ…`）、`x-api-key`、cookie /
session / password / secret 赋值、query 里的 `access_token=`、以及 40+ 字符的
base64 串和 32+ 位 hex 串，全部替换成 `[REDACTED]`。上游若把请求头回显进错误
响应体，凭据也不会落进 `request-logs.ndjson`。

### 状态码的两种写法

日志行的 `statusCode` 是**代理回给客户端的**状态码（失败时恒为 500），不能当作
上游状态。真正算数的是错误消息里**点名**的状态：`HTTP 500`（裸状态）、
`Request failed with status code 403`（axios 措辞）。后者被识别为 `auth`
（`AUTH_STATUSES = {401, 403}`）；行上那个孤零零的 500 则仍归 `unknown`——
宁可说"不知道"，也不伪造原因。

### 2. `GET /v0/management/statistics`

原有字段（`totalRequests` / `successRequests` / `failedRequests` / `avgLatency` /
`modelUsage` / `providerUsage` / `accountUsage` / `dailyStats` …）**原样保留**，新增：

- `p50` / `p95` / `avgLatencyP50` / `avgLatencyP95`（顶层，ms），以及 `latency: {samples,p50,p95,avg}`
- `failureCategories`：`{auth: 40, 'provider-5xx': 7, captcha: 4}`
- `byAccount` / `byProvider` / `byCategory` / `byModel`：每组
  `{requests,success,failed,successRate,samples,p50,p95,avgLatency,failureCategories?}`
- `observed`：本层自己数出来的计数（`source: 'request-log'`）
- `window`：统计窗口（无窗口时为 `null`）

响应头带 `X-C2A-Observability: statistics`。`/management/statistics` 别名同样生效；
非 GET 与其他路径**原样透传上游**。模型名按小写归一后再分组（`GLM-5.3` 与
`glm-5.3` 是同一个模型）。

### 3. IPC 通道（webui 经 `POST /__ipc` 访问）

`c2a:obs:info` / `c2a:obs:requestLogs`（支持 `limit`/`offset`/`failureCategory`）/
`c2a:obs:statistics` / `c2a:obs:annotate`。

## 安装的两步现实（在真实镜像里看到的）

在 `ghcr.nju.edu.cn/liangnianzhi/chat2api:latest` 里实测，**第一次 install 只会装到
IPC 通道**：那时上游 bundle 还没建好 `RequestLogManager`，shim 也还没捕获到 HTTP
handler。所以：

- `install()` 的 `active` 只承认"真的装上了存储或路由"，只有通道时是 `false`，
  网关据此安排**一次** 15s 后的重试；
- 重试时路由能装上（`route=http-listener`），但存储仍然找不到 →
  启动日志会写 `scanned N graph node(s), no candidate at all`。

原因不是时序，是**连通性**：这个镜像的 `/app/upstream/main/headless.js`（9.8 KB）
只做启动、不导出任何东西，`RequestLogManager` 在
`chunks/server-D4GzIgCk.js`（8.6 MB）里且没有任何模块把它导出来。从
`require(bundle)` 的导出图出发无路可走。

**结论与边界**：这一层在真实 bundle 上等于"统计路由可用、请求日志分类待接入"。
要让分类真正落盘，需要上游（或后续工作）导出一个可发现的对象，或改用
`chunks/server-*.js` 里的模块级钩子——那属于 bundle 内部实现，本层刻意不硬编码，
以免一次上游升级就崩。

## 与 selfheal 的边界

**只管记录与统计，不碰账号状态。** 账号降级/冷却、token 复检、恢复全部是
`shim/selfheal/` 的职责。本层在本地表判断为 `unknown` 时会**询问** selfheal 的
分类函数作为兜底（`catalog.selfHealClassifier`），但从不写入账号状态、从不决定
某个账号是否该被冷却。账号的 `errorMessage` 措辞也归 selfheal，本目录不碰。

## 安装点

`shim/gateway.js` 在 `installSelfHeal()` 之后、`startFrontServer()` 之前调用
`installObservability()`：

- 目录不存在 / 抛异常 → 只打印日志，代理继续跑；
- 一次什么都没安装到（上游还没建好日志存储）→ 报 `active:false`，网关在 15s 后
  重试一次，之后不再重试；
- 安装成功会打印 `[observability] request-log/instrumentation ready (store=…, route=…, channels=N)`。

## 测试

```bash
node tests/observability.test.js            # 纯函数与模块：57 项
node tests/observability_integration.js     # 真实 shim/gateway/Dockerfile 接线：24 项
docker exec <container> sh /app/tests/observability_smoke.sh   # 容器内端到端

# 真实数据复核：拿生产 request-logs 跑一遍历史回填 + 统计 + 泄漏检查
SHIM_DIR=shim/observability RAW_FILE=tmp/prod_request_logs.ndjson \
  node tests/observability_realdata.js
```

## 文件

- `failure-classify.js` — 纯分类函数（无依赖，永不抛）
- `request-log.js` — 日志行注解、凭据脱敏与存储包装（含历史行回填）
- `stats.js` — 聚合、分位数、分组、与上游 payload 合并
- `catalog.js` — 在上游导出图里定位日志存储/统计对象，读取 selfheal 分类器
- `install.js` — 安装入口（幂等、容错、注册 IPC 与 HTTP 路由钩子）
- `index.js` — 默认导出 `install.js`
- `tests/observability_realdata.js` — 真实 request-logs 的复核脚本
