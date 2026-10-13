# ADR：默认不提供 Docker 部署

- **状态**：accepted
- **日期**：2026-10（M1.5）

## 背景

用户希望「重启不用手动开服务」，曾评估容器化。

## 决策

默认交付 **macOS LaunchAgent**（及文档中的本地 `npm start`），**不**把 Docker 作为官方路径。

## 理由

壳必须直接使用宿主机 `pi`、`~/.pi/agent`、项目 **真实绝对路径** `cwd`。容器要么整盘挂家目录（失去隔离），要么维护网关 URL、工具链（mvn/java/python）镜像，成本高且与「本地 coding agent」场景不符。

## 后果

- 远程/异机部署留在待办（可选 Docker），见开发账本。
- README「为什么没做成 Docker」保留用户向摘要。

## 相关

- [macOS 常驻服务](../operations/macos_service.md)
- [本地运行](../operations/local_setup.md)
