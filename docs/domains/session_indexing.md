# 会话索引与布局

**范围**：`SessionIndex` 如何发现会话、标题与 pending 语义。  
**不覆盖**：侧栏 fork 折叠（见 [分支与内联编辑](../architecture/branches_and_editing.md#sidebar_fold)）。

## 导航

- [两种落盘布局](#layout_modes)
- [session_dir 策略](#session_dir_policy)
- [cwd 与目录名](#cwd_trust)
- [pending 会话](#pending_sessions)
- [大文件读取策略](#head_tail_reads)

<a id="layout_modes"></a>
## 两种落盘布局

```
<sessionsDir>/--<encoded-cwd>--/<file>.jsonl   # pi 默认分组
<sessionsDir>/<file>.jsonl                     # --session-dir 平铺
```

`SessionIndex.listSessions()` **两种都扫**。

<a id="session_dir_policy"></a>
## session_dir 策略

- **默认**：子进程**不传** `--session-dir`，与 pi CLI `/resume` 互通（见 [ADR](../decisions/adr_session_directory_layout.md)）。
- **`PI_SHELL_SESSIONS_DIR`**（pi 不读）：必须传 `--session-dir` 钉住同一目录 → 平铺；CLI 需同样 `--session-dir` 才可见。

<a id="cwd_trust"></a>
## cwd 与目录名

编码目录名有损（`-` 与 `/` 替换混淆）。分组、展示、spawn `cwd` **一律读 jsonl 头 `cwd`**。

<a id="pending_sessions"></a>
## pending 会话

首条消息前文件可能不存在：

- API：`pending: true`，UI「新」徽章
- `/api/stream`：有 live 子进程即可，不要求文件存在
- 首条消息后落盘并转正

路径键：`normalizeSessionKey` 保证 pending → 落盘后键一致。

<a id="head_tail_reads"></a>
## 大文件读取策略

实现常量见 `src/server/sessionIndex.ts`（`HEAD_BYTES`、`NAME_SCAN_*`）。

**文件头（标题回退用）**

- 读前 **256KB**（`HEAD_BYTES`）：解析 session header、首条 user 消息（作无 `session_info` 时的标题来源）。
- 文件 ≤256KB 时，整文件即 head，命名扫描不再读盘。

**`session_info` 名（侧栏/列表标题优先）**

- 从 **EOF 向前**按 **256KB** 块（`NAME_SCAN_CHUNK_BYTES`）拼接解码，在合并后的文本里找**最后一条** `session_info` 名；某块已包含命中则停止（append-only，名在文件末尾附近时通常只读一块）。
- 单次完整回扫最多覆盖文件尾 **4MB**（`MAX_NAME_SCAN_BYTES`）；触顶仍未命中则回退到 head 切片里再找一次。
- **不是**固定「尾 128KB」窗口；旧文档来自已删除的 ARCHITECTURE，已在 a4d000b 前后改为回扫算法。

**缓存**（`mtimeMs + sizeBytes`）

- 摘要字段缓存；另记 `nameScanTo`（上次命名扫描时的文件大小）。
- 文件只追加、且 `size ≥ nameScanTo` 时，仅读 `[nameScanTo, size)` 增量并在其内找名，否则走 bounded backward scan。

已知限制：首条 user 消息超出 256KB 时，无 `session_info` 时的标题可能回退占位（见开发账本「已知取舍」）。极罕见：最后的 `session_info` 落在距 EOF 超过 4MB 且 head 里也找不到时，标题同样可能不准。
