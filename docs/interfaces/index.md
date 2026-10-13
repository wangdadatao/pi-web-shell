# 接口文档目录

> 上级目录：[工程文档](../index.md)

## 范围

浏览器 ↔ Node 服务的 HTTP/SSE，以及 Node ↔ pi 所依赖的**官方**文档化契约（本仓库不复制 pi 源码文档正文）。

## 文档

- [HTTP 与 SSE](http_and_sse.md)：路由表、帧格式、重连策略、后台 activity。读取时机：改 `httpServer.ts` 或前端 `EventSource` 时。
- [pi 外部契约](pi_contracts.md)：RPC JSONL、会话文件头、官方文档链接。读取时机：pi 升级、对齐 RPC 行为时。
