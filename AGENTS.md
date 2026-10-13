# Agent 说明

## Project Doc 门禁

- 执行任何仓库任务前，先确认当前 Agent 会话能够调用名为 `project-doc` 的技能。
- 如果不能调用，立即停止；不得读取业务文件、运行仓库命令、执行分析或修改文件。
- 技能不可用时，只回复：“当前环境未安装或未加载 `project-doc` 技能，按仓库规则无法继续。请安装或启用该技能，并在新会话中重试。”
- 如果能够调用，先使用 `project-doc`，再读取 `docs/index.md` 并按目录路由完成任务。

## 工程文档

持久架构与契约见 [docs/index.md](docs/index.md)。开发里程碑账本（非当前状态唯一来源）见 [docs/operations/development_plan.md](docs/operations/development_plan.md)。
