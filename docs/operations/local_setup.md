# 本地运行与配置

**范围**：依赖、启动方式、环境变量。用户向说明见 [README](../../README.md)。

## 要求

- **Node** `>=22.19.0`（`--env-file-if-exists`）
- **pi** 在 PATH（或 `PI_SHELL_PI_BIN`）
- 可选：**Chrome/Chromium**（`npm run ui:test`、`npm run shot`、`theme:check` 需要 pi + CDP）

## 常用命令

```bash
npm install    # postinstall 跑 vendor
npm start      # 前台；终端打印带 #token= 的地址并尝试打开浏览器
npm run dev    # --watch
npm test
npm run typecheck
npm run ui:test
npm run plan   # 读 development_plan 账本
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PI_SHELL_HOST` | `127.0.0.1` | 绑定地址 |
| `PI_SHELL_PORT` | `4711` | `0` 随机 |
| `PI_SHELL_SESSIONS_DIR` | pi 默认 | 自定义则平铺 + 需 CLI `--session-dir` |
| `PI_SHELL_PI_BIN` | `pi` | 可执行文件 |
| `PI_SHELL_OPEN_BROWSER` | `1` | 启动时打开带 `#token=` 的地址 |
| `PI_SHELL_IDLE_TIMEOUT_MS` | `900000` | 空闲回收 |

模板：`.env.example`。

首次打开页面要用终端打印的完整地址。凭证存在 `<agentDir>/web-shell-token`（`0600`），同一浏览器之后可直接打开不带片段的地址。详见 [安全边界](security.md#auth_token)。
