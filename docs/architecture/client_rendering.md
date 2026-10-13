# 客户端渲染与性能

**范围**：`src/web` 消息区、Markdown/Mermaid、图片与统计条。  
**不覆盖**：设置页表单（见 [设置页与配置写盘](../operations/settings_and_config.md)）。

## 导航

- [消息区结构](#message_layout)
- [Markdown 与 Mermaid](#markdown_mermaid)
- [图片与体积](#image_volume)
- [统计条与 token 速度](#stats_bar)

<a id="message_layout"></a>
## 消息区结构

- **正文气泡**：用户消息；助手有可见正文/图片的回合。
- **活动块（`.tool-group`）**：连续思考 + 工具调用 + 工具结果聚成一个 `<details>`，摘要如 `思考 + 12 次工具调用 · read ×4、bash ×8`。
- 无正文仅有思考/工具的回合并入活动块，避免空洞气泡。
- 流式中活动块展开，`agent_settled` 后折叠。

工具输出、思考块：**纯文本**，不跑 Markdown。

<a id="markdown_mermaid"></a>
## Markdown 与 Mermaid

路径：`marked.parse` → `DOMPurify.sanitize` → `innerHTML`。  
流式阶段为纯文本；`text_end` 后重渲染为 Markdown。

- 代码块：`Prism.manual`，未标注语言不猜测。
- ```mermaid：占位块 + `MutationObserver` 串行 `mermaid.render`；源码放文本节点（非 `data-*`，防 DOMPurify/`-->`）；`securityLevel: 'strict'`；脚本按需加载 ~3.4MB。
- 流式边界：`liveMarkdown.js` 的 `findStableEnd` / `continuesList` 避免截断围栏。

配色变量对齐 pi 主题：`npm run theme:check` 比对 dark/light 各 18 项。

<a id="image_volume"></a>
## 图片与体积

快照中 image block 只发 hash/尺寸/字节数；字节在服务端 `ImageStore`（LRU 256MB），`/api/image/<sha1>`，`immutable` 缓存。

- **用户图**：内联 + lazy。
- **工具图**：占位符 `🖼 [mime WxH] · size`，点击才拉取（对齐 pi export-html `showImages: false`）。

SSE 响应 gzip；切换会话延迟 250ms 才显示骨架屏。

<a id="stats_bar"></a>
## 统计条与 token 速度

数据来自 `get_session_stats`（snapshot + 每次 `agent_settled` 推送 `stats`）。

**token 速度**按单条 assistant 消息：

1. `message_start` 重置；首个 text/thinking/toolcall **delta** 启动时钟（非 `agent_start`）。
2. 三类 delta 均计入分子；CJK ≈ 1.4 字/token，其他 ≈ 4 字/token。
3. `message_end` 用 `usage.output` 冻结；带 `≈` 表示估算。

助手气泡下方（非右上角）：最后一条回复常驻 `用时 · ↑input ↓output · 结束时间`；整轮 output 累加多段 assistant usage（工具轮不可只取最后一条）。

相关：[HTTP snapshot 帧](../interfaces/http_and_sse.md#sse_frames)。
