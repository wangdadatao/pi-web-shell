# HTTP 与 SSE

**范围**：浏览器 ↔ Node 的 REST 与 EventSource。  
**不覆盖**：pi RPC 方法语义（见 [pi 外部契约](pi_contracts.md)）。

## 导航

- [HTTP 路由](#http_routes)
- [SSE 帧](#sse_frames)
- [长连接重连](#sse_reconnect)
- [后台 activity](#background_activity)

<a id="http_routes"></a>
## HTTP 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | `{ home, folders, sessions }`；`running`、`pending`；superseded 父文件默认隐藏 |
| POST | `/api/sessions/new` | `{ cwd }` 新建 |
| POST | `/api/rename` | `{ path, name }` → `set_session_name` |
| POST | `/api/delete` | `{ path }`；先 dispose；trash 或 unlink |
| POST | `/api/delete-folder` | `{ cwd }`；并行删该 cwd 下会话文件 |
| GET | `/api/stream?path=` | SSE：snapshot + 事件 + stats；gzip |
| GET | `/api/events` | SSE：全局 `{type:"activity", path, running, reason}` |
| GET | `/api/tree?path=` | 分支树 payload |
| POST | `/api/fork` | `{ entryId }` 或 `{ fromEnd }`；含 `sessionFile` |
| POST | `/api/clone` | 副本路径 |
| GET | `/api/image/<sha1>` | 快照图片字节 |
| GET | `/api/local-image?path=` | 正文本地图；魔数 PNG/JPEG/GIF/WEBP |
| POST | `/api/prompt` | 发消息；流式中 followUp |
| POST | `/api/compact` | `compact` RPC；运行中/已在压缩 → 409；RPC 超时 → `{pending:true}` |
| POST | `/api/ui-response` | 扩展 UI 答案 |
| POST | `/api/abort` | 中断 |
| POST | `/api/model` | `set_model` |
| POST | `/api/thinking` | `set_thinking_level` |
| GET | `/api/models?path=` | 模型与思考等级列表 |
| GET | `/api/commands?path=` | `/` 菜单 |
| GET | `/api/settings/usage` | 跨会话 token 统计 |
| GET | `/api/settings/environment` | agent 环境 + 可编辑白名单 |
| POST | `/api/settings/save` | settings.json 补丁；**不** disposeAll |
| POST | `/api/settings/agents-md` | AGENTS.md；之后 disposeAll |
| POST | `/api/settings/mcp` | mcp.json enabled；之后 disposeAll |
| GET | `/` | 静态 `src/web`；`/settings` SPA 回落 index.html |

静态资源：`Cache-Control: no-store`（避免旧 `app.js`）。

<a id="sse_frames"></a>
## SSE 帧

`/api/stream` 帧类型：

- `snapshot` — state、messages（图片 hash）、stats、extension `ui`
- `event` — pi 原始 RPC 事件
- `stats` — `get_session_stats`（含 settle 后刷新）
- `error`

<a id="sse_reconnect"></a>
## 长连接重连

| 连接 | 断线代价 | 策略 |
|------|----------|------|
| `/api/events` | 丢运行态 | 浏览器自动重连 |
| `/api/stream` | 每次 acquire 可能 spawn pi | 前端最多 3 次退避（0.5s/1s/2s），用尽提示手动点会话重连 |

pi 崩溃：服务端换新子进程；单流重连有上限，避免无限 spawn。

事件单向、命令低频 POST；SSE 为普通 HTTP + 原生 `EventSource`，故未采用 WebSocket。

<a id="background_activity"></a>
## 后台 activity

切走会话仅关闭 `/api/stream`，不 stop 子进程。  
`applyActivity`：非当前会话 + `settled`/`exited` → toast + 标题 `(n)`；`retired` 不通知；abort 后路径进 `abortedPaths` 抑制误报。

相关：[会话生命周期](../architecture/session_lifecycle.md#activity_broadcast)。
