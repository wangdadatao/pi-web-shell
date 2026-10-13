# 架构决策记录

> 上级目录：[工程文档](../index.md)

## 范围

已接受、且未来可能被重新质疑的设计取舍。当前实现细节仍以架构/接口文档为准。

## 文档

- [ADR：默认不提供 Docker 部署](adr_no_docker_as_default.md)。读取时机：评估容器化或远程部署时。
- [ADR：默认不传 `--session-dir`](adr_session_directory_layout.md)。读取时机：改会话目录或与 pi CLI `/resume` 互通时。
- [ADR：settings.json 保存不回收子进程](adr_settings_json_apply_semantics.md)。读取时机：改设置保存或默认模型生效范围时。
