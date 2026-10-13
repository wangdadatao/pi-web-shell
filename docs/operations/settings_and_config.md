# 设置页与配置写盘

**范围**：设置视图、只读扫描与写路径。UI 入口：`#app[data-view="settings"]`。

## 导航

- [菜单与数据源](#settings_menu)
- [settings.json 补丁](#settings_json_patch)
- [AGENTS.md 与 MCP](#agents_mcp)
- [token 统计](#usage_stats)

<a id="settings_menu"></a>
## 菜单与数据源

| 菜单 | 能力 | 来源 |
|------|------|------|
| token 统计 | 只读 | `usageStats.ts` 扫 jsonl `usage` |
| 技能 / MCP / 插件 | MCP 可开关 | `environment.ts` |
| 模型配置 | 白名单写 | `settings.json` |
| 语言、主题 | localStorage | 外壳偏好，不写 pi settings |
| agent 设置 | 白名单 + AGENTS.md | `settingsStore` |

只读项不 spawn pi；不跑 `pi mcp list`（避免真连 OAuth/npx）。

<a id="settings_json_patch"></a>
## settings.json 补丁

`POST /api/settings/save`：`{ "dotted.key": value | null }`，键 ∈ `EDITABLE_KEYS`（17 个 web 相关键）。

- 校验类型/范围；`null`/空串删键回 pi 内置默认。
- 嵌套兄弟与白名单外键**保留**；TUI 键（`theme`、`terminal.*` 等）不进页面。
- 备份 `settings.json.bak`；tmp + rename；坏 JSON **拒绝覆写**。
- 写成功后 **不 `disposeAll()`**（启动默认值语义，见 [ADR](../decisions/adr_settings_json_apply_semantics.md)）。

<a id="agents_mcp"></a>
## AGENTS.md 与 MCP

`POST /api/settings/agents-md`、`POST /api/settings/mcp`：同样 backup + 原子写。  
写成功后 **`disposeAll()`**（启动注入的 system / MCP 连接需新子进程才生效；会打断运行中会话）。

MCP：禁用写 `enabled: false`；启用删该键（pi 惯例）。

<a id="usage_stats"></a>
## token 统计

无 pi 跨会话 API；扫 assistant 消息的 `usage`。缓存 `mtime+size`；payload 含 `models` 切片与 `byDayModel`（不可 `byDay × byModel` 相乘）。  
`/api/settings/*` 与 JSON API：`Cache-Control: no-store`。

主题/i18n：见 [客户端渲染](../architecture/client_rendering.md)；浅色 `--md-*` 来自 pi light 主题 + `theme:check`。
