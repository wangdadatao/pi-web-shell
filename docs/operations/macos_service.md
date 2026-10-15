# macOS 常驻服务

**范围**：LaunchAgent。其他平台见 [开发账本](development_plan.md)「M2 下一步」。

```bash
npm run service:install | status | restart | uninstall
```

- Plist：`~/Library/LaunchAgents/dev.pi-web-shell.plist`
- `RunAtLoad` + `KeepAlive`；环境 `PI_SHELL_OPEN_BROWSER=0`
- 入口 `scripts/launchd-run.sh`：source `~/.nvm/nvm.sh`，用 default alias 解析 node（launchd PATH 不含 shell 配置）
- 日志：`~/Library/Logs/pi-web-shell/{stdout,stderr}.log`
- 首次在某浏览器打开时，用 stdout 日志里那条带 `#token=` 的地址；`service:status` 打印的裸地址不含凭证。详见 [安全边界](security.md#auth_token)。
- 安装后勿再 `npm start`（端口占用）；改代码用 `service:restart`
- 改端口：`.env` 中 `PI_SHELL_PORT` 后重装 `service:install`
