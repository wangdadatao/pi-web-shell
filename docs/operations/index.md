# 运维文档目录

> 上级目录：[工程文档](../index.md)

## 范围

在本机运行、验证、排障与安全边界。不含 Docker 默认方案（见 [ADR](../decisions/adr_no_docker_as_default.md)）。

## 文档

- [本地运行与配置](local_setup.md)：依赖、环境变量、与 pi 的关系。读取时机：新环境搭建或改 `.env.example` 时。
- [安全边界](security.md)：Host 校验、路径约束、local-image、不可信渲染。读取时机：暴露新读文件接口或改绑定地址时。
- [设置页与配置写盘](settings_and_config.md)：只读扫描、白名单补丁、dispose 语义。读取时机：改 `settingsStore`、`environment`、`usageStats` 时。
- [回归测试](regression_testing.md)：单测、ui:test、theme:check、screenshot。读取时机：加功能或改 CI 前。
- [macOS 常驻服务](macos_service.md)：LaunchAgent 与 PATH 坑。读取时机：改 `scripts/launchd.ts` 或服务行为时。

## 库外相关（非当前状态文档）

- [开发账本](development_plan.md)：里程碑 checkbox 与验证记录。读取时机：查历史决策过程；**行为以架构/接口文档与代码为准**。
