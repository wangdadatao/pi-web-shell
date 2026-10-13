# 分支树与内联编辑

**范围**：分支树 UI、`fork`/`clone`、编辑/删除重发、侧栏列表折叠。  
**不覆盖**：`get_tree` HTTP 字段表（见 [HTTP 与 SSE](../interfaces/http_and_sse.md)）。

## 导航

- [分支树面板](#tree_panel)
- [fork 与新 session 文件](#fork_session_file)
- [内联编辑与删除](#inline_edit_delete)
- [侧栏折叠 superseded 会话](#sidebar_fold)

<a id="tree_panel"></a>
## 分支树面板

- 数据：`GET /api/tree` → `treeView.reshapeTree`（`id/kind/preview/label/active`）。
- `active`：从 `leafId` 沿 `parentId` 走到 root；与兄弟顺序无关。
- 布局（M2.16）：活动链**平铺主干**；岔路收成「⑂ 分支 · N 条」折叠胶囊，递归展开。
- `treeView.convert` 从 `entry.message` 读 role/content；隐掉 system/簿记 entry 并 **hoist** 子节点。

<a id="fork_session_file"></a>
## fork 与新 session 文件

**RPC `fork` 每次创建新 `.jsonl` 文件**（非就地改树）。响应通常只有 text；`/api/fork` 补 `get_state.sessionFile`，若路径变化则 dispose 旧 managed 会话。

- **clone**：副本当新会话；dispose 已切文件的子进程。
- **树 fork（entryId）** / **clone**：在 branch mark 存 `keepParent: true`，父会话保持侧栏可见。
- **内联 fork（fromEnd）**：不打 keep-parent 标，父文件可被折叠。

<a id="inline_edit_delete"></a>
## 内联编辑与删除

用户气泡下方 ✎ / 🗑 / 📋（文案在 `title`/`aria-label`）：

- 编辑 = `fork` + 原文填回输入框；删除 = `fork` 不填。旧内容仍在旧文件，只是非活动分支。
- 快照消息无 entry id → `POST /api/fork { fromEnd }`；服务端 `activeUserEntryIds()` 从活动分支数 user 消息。
- **`fromEnd` 在点击时计算**，不用渲染期 `data-*`。
- 运行中先 `abort` + `waitForIdle()`；带图消息 fork 后图片不自动带回。

输入 `/compact` 由外壳路由到 `POST /api/compact`（pi `prompt` 不执行内置 slash），见 [HTTP 表](../interfaces/http_and_sse.md#http_routes)。

<a id="sidebar_fold"></a>
## 侧栏折叠 superseded 会话

实现：`supersessions.hideSupersededSessions`（`src/server/supersessions.ts`）。

用户期望「编辑发生在当前会话」；fork 会产生同名父/子文件。规则：

- 若存在子文件 header `parentSession` 指向父，且**父最后写入 ≤ 子创建时间**，父从 `/api/sessions` 列表隐藏（文件仍在磁盘）。
- 父在 fork 后继续写入 → 独立线程，始终可见。
- 删子文件 → 父重新出现。
- `clone` / 树 fork：`~/.pi/web-shell/branch-marks.jsonl`（随 `PI_CODING_AGENT_DIR`）记录 `keepParent`。
- `POST /api/delete-folder` 请求体只有 `{ cwd }`。服务端在组待删列表时对内部 `collectSessions({ includeSuperseded: true })` 打开折叠，**会删掉侧栏已隐藏但仍落在该 cwd 下的会话文件**；客户端不能传 `includeSuperseded` 字段。

相关：[会话索引](../domains/session_indexing.md)。
