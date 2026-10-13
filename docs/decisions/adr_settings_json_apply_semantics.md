# ADR：settings.json 保存不回收子进程

- **状态**：accepted
- **日期**：2026-10-09（M2.20.1）

## 背景

`/api/settings/save` 曾 `disposeAll()` 以使配置「立即生效」，导致运行中会话被掐断，且未选过模型的旧会话在重开后被默认模型覆盖（与 pi `core/sdk.js` 恢复语义不符）。

## 决策

- `settings.json` 补丁写盘后 **不** 调用 `disposeAll()`。
- 语义：**启动默认值**，仅影响之后 spawn 的子进程；运行中会话不打断。
- `AGENTS.md` / `mcp.json` 写盘后 **仍** `disposeAll()`（启动时注入/连接，非默认值）。

## 后果

- 已打开会话要读到新 settings.json 需自然回收或用户重开会话。
- UI 文案说明「只对之后新建或重开的会话生效」。

## 相关

- [设置页与配置写盘](../operations/settings_and_config.md#settings_json_patch)
