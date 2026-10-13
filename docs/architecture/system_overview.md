# 系统概览

**范围**：pi-web-shell 在整体栈中的位置、依赖边界与源码地图。  
**不覆盖**：逐条 HTTP 路径（见 [HTTP 与 SSE](../interfaces/http_and_sse.md)）。

## 导航

- [全局结构](#global_structure)
- [设计原则](#design_principles)
- [模块地图](#module_map)

<a id="global_structure"></a>
## 全局结构

```
浏览器 UI
   │  HTTP + SSE
   ▼
本地 Node 服务（本项目）
   │  spawn + JSONL over stdin/stdout（pi 官方 RPC）
   ▼
pi --mode rpc 子进程（每个被 acquire 的会话至多一个写者）
   │
   ▼
~/.pi/agent/sessions/**/*.jsonl（pi 读写）
```

本项目**不是** pi 的分支：启动 PATH 里的 `pi`，复用 `models.json`、`auth.json`、`settings.json`、`AGENTS.md`、skills 与历史会话。

对外只依赖 pi 的两类**文档化**契约，见 [pi 外部契约](../interfaces/pi_contracts.md)。

<a id="design_principles"></a>
## 设计原则

- **官方契约优先**：RPC JSONL + 会话文件格式；不耦合 pi 内部模块。
- **运行时零 npm 依赖**：服务端仅 Node 内置模块；前端第三方库 vendor 到 `src/web/vendor/`，无构建步骤。
- **只读列历史**：索引会话只读 head 切片与有界的尾部命名回扫，不修改已有会话文件。
- **不可信渲染**：模型/工具输出经 DOMPurify；工具结果不做 Markdown 二次解释。
- **本地默认**：绑定 loopback + Host 头校验（见 [安全边界](../operations/security.md)）。

<a id="module_map"></a>
## 模块地图

```
src/shared/types.ts          wire 类型
src/server/config.ts         环境变量与 sessions 目录策略
src/server/index.ts          入口
src/server/httpServer.ts     路由、SSE、静态文件
src/server/sessionIndex.ts   扫描/缓存/分组
src/server/supersessions.ts  侧栏 fork 链折叠 + branch marks
src/server/sessionRegistry.ts  子进程引用计数与生命周期
src/server/piSession.ts      单个子进程 JSONL RPC
src/server/paths.ts          会话路径 realpath 归一
src/server/hostCheck.ts      Host 校验
src/server/treeView.ts       get_tree 重塑
src/server/extensionUi.ts    扩展 UI 状态与响应塑形
src/server/imageStore.ts     快照图片 LRU
src/server/localImage.ts     /api/local-image
src/server/settingsStore.ts  settings / AGENTS.md / mcp 写盘
src/server/usageStats.ts     跨会话 token 统计
src/server/environment.ts    只读 agent 环境
src/web/app.js               前端主逻辑
src/web/i18n.js              外壳 i18n
src/web/liveMarkdown.js      流式 Markdown 稳定边界
```

相关文档：[会话与子进程生命周期](session_lifecycle.md)、[领域：会话索引](../domains/session_indexing.md)。
