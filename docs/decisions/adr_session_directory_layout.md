# ADR：默认不传 `--session-dir`

- **状态**：accepted
- **日期**：2026-10（M1.10）

## 背景

早期 web 子进程统一传 `--session-dir`，pi 将会话**平铺**在目录根，pi CLI `/resume` 只扫 `--<cwd>--/` 子目录，导致 web 建的会话 CLI 看不见。

## 决策

- **默认** spawn **不传** `--session-dir`，使用 pi 分组布局 `<sessions>/--<encoded-cwd>--/`。
- 仅当 `PI_SHELL_SESSIONS_DIR` 覆盖且与 pi 默认目录不同时，传 `--session-dir` 钉住目录（平铺）；用户需在 CLI 传相同 `--session-dir` 才能互通。

## 后果

- `SessionIndex` 仍扫描平铺与分组两种布局。
- `config.test.ts` 锁定三种 env 组合行为。

## 相关

- [会话索引与布局](../domains/session_indexing.md#session_dir_policy)
