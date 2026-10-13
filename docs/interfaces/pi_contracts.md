# pi 外部契约

**范围**：本服务**允许依赖**的 pi 接口；链接指向 pi 官方仓库文档（本仓库不镜像正文）。

## 导航

- [RPC JSONL](#rpc_jsonl)
- [会话文件](#session_files)

<a id="rpc_jsonl"></a>
## RPC JSONL

用途：对话、历史、模型、图片、fork/clone/compact、扩展 UI 等。

官方文档（earendil-works/pi）：

- `docs/rpc.md`
- `docs/rpc-commands.md`
- `docs/json.md`
- `docs/rpc-extension-ui.md`（扩展 UI）

升级 pi 时：上述文档化 RPC 与会话格式不变则 web-shell 无需改代码。

<a id="session_files"></a>
## 会话文件

用途：列文件夹/会话、读 `cwd`、标题（`session_info` 或首条 user 消息）。

- 格式：`docs/session-format.md`（pi 仓库）
- 头字段：`cwd`、`id`、`timestamp`；fork 链 `parentSession`
- **目录名 `--encoded-cwd--` 不可信**，cwd 只读文件头

Web 专属：spawn 时可带 `--append-system-prompt`（仅 web 子进程），提示本地图 Markdown 写法；详见代码 `config` / `piSession`。
