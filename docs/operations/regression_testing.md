# 回归测试

**范围**：仓库内自动化验证入口。

## 层级

| 命令 | 内容 |
|------|------|
| `npm test` | `node:test`，`test/*.test.ts`（含 API 凭证、来源、415、local-image 与不可信 HTML） |
| `npm run typecheck` | `src/`、`test/`、`scripts/` 的 TS |
| `npm run ui:test` | typecheck + 单测 + 全部 `scripts/ui-test-*.ts`（共享隔离 server）。需要 `CHROME_BIN` 指向 Chrome/Chromium（macOS 另会试应用默认路径） |
| `npm run theme:check` | 与 pi 导出主题色比对 |
| `npm run shot` | CDP 截图 + `--eval`（SSE 页不可用普通 screenshot） |

UI 测试约定：argv[2] 为 base URL 则不自举；`ui-test-settings-edit.ts` 另需隔离 `PI_CODING_AGENT_DIR`。

调试：`window.piShellDebug`（`app.js`）。

**缺口**：仓库暂无 GitHub Actions；改核心路径建议本地跑 `npm run ui:test`。
