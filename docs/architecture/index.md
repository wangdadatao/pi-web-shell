# 架构文档目录

> 上级目录：[工程文档](../index.md)

## 范围

组件关系、跨模块流程与前端渲染不变量。HTTP 路径表见 [接口](../interfaces/http_and_sse.md)；会话文件布局见 [领域](../domains/session_indexing.md)。

## 文档

- [系统概览](system_overview.md)：全局结构、pi 双契约、模块地图。读取时机：新人理解项目或画架构图时。
- [会话与子进程生命周期](session_lifecycle.md)：SessionRegistry、空闲回收、死进程、运行态广播。读取时机：改 SSE、子进程、后台通知时。
- [客户端渲染与性能](client_rendering.md)：消息区、Markdown/Mermaid、图片体积、统计条速度口径。读取时机：改 `app.js` 渲染或 `liveMarkdown.js` 时。
- [分支树与内联编辑](branches_and_editing.md)：树面板、fork/clone、编辑重发、侧栏折叠。读取时机：改 `treeView`、`/api/fork`、侧栏列表时。
- [扩展 UI](extension_ui.md)：`extension_ui_request` 与快照重放。读取时机：改 `extensionUi.ts` 或对话框/widget 时。
