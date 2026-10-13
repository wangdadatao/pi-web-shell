# 会话与子进程生命周期

**范围**：`SessionRegistry`、`PiRpcSession` 与运行态如何到达浏览器。  
**不覆盖**：HTTP 路由细节（见 [HTTP 与 SSE](../interfaces/http_and_sse.md)）。

## 导航

- [进程与引用计数](#process_refs)
- [空闲回收与运行中](#idle_and_running)
- [死子进程](#dead_subprocess)
- [运行态广播](#activity_broadcast)

<a id="process_refs"></a>
## 进程与引用计数

- 每个被 `acquire` 的会话文件对应至多一个 **pi RPC 子进程**（`pi --mode rpc --session <path>`），`cwd` 为会话头里的项目目录。
- 多个 `/api/stream` 消费者共享同一子进程；`release()` 按 **managed 实例** 扣引用，避免路径键错位。
- 会话路径键经 `paths.normalizeSessionKey`（realpath）归一，避免 symlink 下双开两个写者。

<a id="idle_and_running"></a>
## 空闲回收与运行中

- 最后一个消费者离开后，启动 `PI_SHELL_IDLE_TIMEOUT_MS`（默认 15 分钟）定时器；到期 graceful shutdown（关 stdin → 等待 → SIGKILL）。
- **`agent_start` 取消回收定时器**；`agent_settled` 且 refs=0 才重新计时。刷新页面只断 SSE，不杀正在跑的 agent。
- `release()` 在会话仍 `streaming` 时不 arm idle，保证切走后后台跑完。

<a id="dead_subprocess"></a>
## 死子进程

子进程退出后 `ManagedSession.dead = true`：

- 无消费者时立即 dispose；有消费者时等最后一个 `release()`。
- `acquire()` 遇 dead：**dispose 后循环重解析**，绝不把死进程交给新流（否则 `get_state` 永不返回、snapshot 永久挂起）。
- `PiRpcSession.stop()` 对已退出进程快速返回，避免无意义 SIGKILL 等待。

SSE 断连竞态：`res.on("close")` 须在 `acquire` await 前后用 closed 标志补判，防止 refs 泄漏。

<a id="activity_broadcast"></a>
## 运行态广播

`SessionRegistry.watch()` 监听 `agent_start` / `agent_settled` / 进程退出，经 `onActivity` 推到 `/api/events`。

`reason` 取值：

| reason | 含义 | 前端通知 |
|--------|------|----------|
| `started` | 开始跑 | 否 |
| `settled` | 正常结束（含 abort） | 非当前会话时可 toast |
| `exited` | 子进程崩溃 | 非当前会话时可 toast（措辞不同） |
| `retired` | 空闲回收或 disposeAll | **不得** toast |

局限：终端里另起的 `pi` 不在本注册表，侧栏无 `running`。

相关文档：[分支与 fork 后的 dispose](branches_and_editing.md#fork_session_file)。
