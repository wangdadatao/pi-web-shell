# macOS 常驻服务

**范围**：LaunchAgent。其他平台见 [开发账本](development_plan.md)「M2 下一步」。

```bash
npm run service:install | status | restart | uninstall
```

- Plist：`~/Library/LaunchAgents/dev.pi-web-shell.plist`
- `RunAtLoad` + `KeepAlive`；环境 `PI_SHELL_OPEN_BROWSER=0`
- 入口 `scripts/launchd-run.sh`：source `~/.nvm/nvm.sh`，用 default alias 解析 node（launchd PATH 不含 shell 配置）

<a id="service_logs"></a>
## 日志

- 路径：`~/Library/Logs/pi-web-shell/{stdout,stderr}.log`。目录 `0700`，两个日志文件 `0600`。安装、重启和 `launchd-run.sh` 都会收紧权限；日志路径若是符号链接，删掉的是链接本身，不会 `chmod` 目标。
- stdout **不**写凭证。首次在某浏览器打开时，读取 `~/.pi/agent/web-shell-token`，访问 `http://127.0.0.1:<port>/#token=<文件内容>`。`service:status` 只打印裸地址。详见 [安全边界](security.md#auth_token)。
- 安装后勿再 `npm start`（端口占用）；改代码用 `service:restart`
- 改端口：`.env` 中 `PI_SHELL_PORT` 后重装 `service:install`
