# pi-web-shell 工程文档

> Project Doc 根目录。加载 `project-doc` 技能后，每个仓库任务先完整读取本文件，再按「读取时机」进入分类。

## 文档范围

本库描述 **pi-web-shell** 的持久工程知识：架构边界、HTTP/SSE 契约、会话索引与 fork 语义、安全与运维、已接受的架构决策。  
**不覆盖**：用户向 README 的快速上手、npm 脚本逐项说明、以及 [开发账本](operations/development_plan.md) 里的里程碑验证记录（账本反映历史过程，不是当前行为的唯一来源）。

## 根级文档

- [项目 README](../README.md)：对外介绍、功能清单、快速开始。读取时机：向新用户介绍项目或写发行说明时。

## 分类

- [架构](architecture/index.md)：进程模型、子进程生命周期、前端渲染与分支编辑。读取时机：改 `src/server/*`、`src/web/*` 核心流程时。
- [接口](interfaces/index.md)：HTTP/SSE 路由与 pi 官方契约依赖。读取时机：增删 API、对接 pi RPC、写集成测试时。
- [领域](domains/index.md)：会话文件布局、索引与侧栏折叠规则。读取时机：改 `sessionIndex`、`supersessions`、路径校验时。
- [运维](operations/index.md)：本地运行、安全、设置页写盘、回归测试、macOS 服务。读取时机：部署、排障、改配置或 CI 时。
- [决策](decisions/index.md)：ADR（Docker、会话目录、settings 生效语义等）。读取时机：质疑「为什么当初这样设计」时。

## 代码地图（入口）

| 区域 | 路径 |
|------|------|
| 服务入口 | `src/server/index.ts` |
| HTTP + SSE | `src/server/httpServer.ts` |
| pi 子进程 | `src/server/piSession.ts`、`src/server/sessionRegistry.ts` |
| 会话索引 | `src/server/sessionIndex.ts`、`src/server/supersessions.ts` |
| 前端 | `src/web/app.js`、`src/web/i18n.js` |
| 单测 | `test/*.test.ts` |
| UI 回归 | `scripts/ui-test.ts`、`scripts/ui-test-*.ts` |
