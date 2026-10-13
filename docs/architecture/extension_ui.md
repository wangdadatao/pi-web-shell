# 扩展 UI

**范围**：pi 扩展经 RPC 请求的宿主 UI（对话框、状态、widget、标题）。  
**不覆盖**：pi 扩展 API 全文（见 pi 仓库 `docs/rpc-extension-ui.md`）。

<a id="persistent_state"></a>
## 持久态（快照重放）

`extensionUi.applyExtensionUiState` 维护 `setStatus` / `setWidget` / `setTitle`；省略 payload 表示撤回。  
SSE `snapshot` 带 `ui` 字段，重连后重放。

<a id="dialogs"></a>
## 一次性对话框

`extension_ui_request` 推前端渲染；答案 `POST /api/ui-response` → `buildUiResponse` → `extension_ui_response`。

- `cancelled` 优先于 value。
- `confirm` → boolean；`select`/`input`/`editor` → string；其余拒绝。

切会话时 `resetExtensionUi()` 清扩展通知，**不清** `toast-global` 跨会话完成提醒。

相关：[HTTP 路由](../interfaces/http_and_sse.md#http_routes)。
