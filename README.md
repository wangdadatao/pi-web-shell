# pi-web-shell

一个跑在本地的 **Web 外壳**，包在官方 [`pi`](https://github.com/earendil-works/pi) 之上。

> 非官方社区项目，与 pi 官方（earendil-works）无关。pi 只是它驱动的 coding agent。

用来替代「开一堆终端」：一个页面里按文件夹浏览历史会话、继续对话、流式看回复、直接贴图。
它启动的就是你 PATH 里的那个 `pi`，所以模型、密钥、`AGENTS.md`、skills、历史会话全部原样复用。

```
浏览器 UI  ←HTTP/SSE→  本地 Node 服务  ←JSONL RPC→  pi --mode rpc 子进程
```

## 快速开始

```bash
npm install          # 装 devDependencies（typescript / @types/node / marked / dompurify）并自动 vendor 前端依赖
npm start            # 前台启动，自动打开浏览器
```

想让它在后台常驻、重启电脑后不用手动开，装成 macOS LaunchAgent：

```bash
npm run service:install    # 写入 LaunchAgent 并启动
npm run service:status     # 查看状态 / pid / 日志路径
npm run service:restart    # 改完代码后重启
npm run service:uninstall  # 移除
```

装了服务之后**不要再跑 `npm start`**（会报端口占用），用 `service:restart`。

运行时零依赖：`marked` / `DOMPurify` / `Prism` 已拷贝到 `src/web/vendor/`，前端不需要任何构建步骤。
升级这些库后跑一下 `npm run vendor`（`npm install` 也会自动跑）。

默认地址 <http://127.0.0.1:4711/>。

```bash
npm run dev          # 带 --watch 的开发模式
npm test             # 单元测试（node:test）
npm run typecheck    # tsc --noEmit
npm run plan         # 查看 docs/PLAN.md 的进度和下一项
```

## 配置

复制 `.env.example` 为 `.env`（可选，全部有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_SHELL_HOST` | `127.0.0.1` | 绑定地址，别改成外网 |
| `PI_SHELL_PORT` | `4711` | 端口，`0` 表示随机 |
| `PI_SHELL_SESSIONS_DIR` | `~/.pi/agent/sessions` | 会话目录。**设成自定义路径时会话会平铺在该目录根，`pi --resume` 看不到**；不设则沿用 pi 自己的按项目分组布局，两边都能看到 |
| `PI_SHELL_PI_BIN` | `pi` | pi 可执行文件 |
| `PI_SHELL_OPEN_BROWSER` | `1` | 启动时开浏览器 |
| `PI_SHELL_IDLE_TIMEOUT_MS` | `900000` | 空闲多久回收 pi 子进程 |

## 功能

- 左侧：有会话的文件夹（家目录显示为 `~`）。中间：该文件夹的会话列表。
- 两个 `＋` 按钮新建会话：中间那个在当前文件夹新建，左上角那个让你输入任意路径。
- 侧栏三档折叠：左上角的 `‹` 依次收起文件夹栏 → 整个侧栏（对话区全屏）；`⌘B` 在全屏与上次布局之间直跳。开关始终留在窗口左上角，在哪收起就在哪展开。
- 新建的会话在发第一条消息前文件还不在磁盘上，此时会以「新」徽章显示；发完自动转正。
- 右侧：对话区，流式输出；回复按 Markdown 渲染（GFM：标题/列表/表格/代码块/引用/链接）。
- 配色**逐个复制自 pi 主题**（行内代码紫、标题琥珀、代码块绿、字符串橙），不是自己调的。
- 代码块带语言标签 + 语法高亮 + 复制按钮；未标注语言的块按纯文本显示（不猜语言）。
- 每条助手回复右上角有复制按钮（悬停出现），只复制正文，不含思考与工具输出。
- 顶部统计条：上下文进度条、累计 token、缓存命中、花费、轮数/工具数、实时 token/s。
- 连续的工具调用聚合成一个折叠块（如「思考 + 12 次工具调用 · read ×4、bash ×8」），默认收起。
- 一次调用的入参和结果是同一条，展开即可核对。
- 输入框：Enter 发送、Shift+Enter 换行、粘贴/拖拽/选择图片。
- 历史里的图片按内容哈希按需加载；工具截图默认只显示 `🖼 [image/png 2000×1250] · 855 KB` 占位符，点击才请求（跟 pi 自己的网页导出一致）。
- 「停止」按钮中断当前运行。

## 开机自启（macOS）

`npm run service:install` 会写一个 LaunchAgent 到
`~/Library/LaunchAgents/dev.pi-web-shell.plist`，并立即 `bootstrap` 起来：

- `RunAtLoad` — 登录/开机就启动，不用手点
- `KeepAlive` — 进程挂了自动拉起
- `PI_SHELL_OPEN_BROWSER=0` — 服务模式不会登录就弹浏览器，需要时自己开 <http://127.0.0.1:4711/>
- 日志：`~/Library/Logs/pi-web-shell/{stdout,stderr}.log`

**PATH 是这里唯一的坑**：launchd 不读你的 shell 配置。所以真正被启动的是
`scripts/launchd-run.sh`，它先 source `~/.nvm/nvm.sh`，再用 `~/.nvm/alias/default`
做兜底，因此**升级 Node 不会把这个服务搞挂**，也不会写死版本号。

改端口：在项目根目录建 `.env` 写 `PI_SHELL_PORT=xxxx`，然后 `npm run service:install`
重装（安装脚本会读 `.env`）。

## 为什么没做成 Docker

这个壳必须拿到宿主机的三样东西：`pi` 命令、`~/.pi/agent`（auth / models / 会话），
以及**项目目录的原始绝对路径**（会话里的 `cwd` 直接拿去当工作目录）。容器里做到这些要：

- 把家目录整个挂进去（那隔离就没了）
- `models.json` 里指向本机网关的 `http://localhost:<port>/v1` 得改成
  `host.docker.internal:<port>`（或加入网关所在的网络），所以得额外维护一份容器专用配置
- 在镜像里装齐 `mvn` / `java` / `python3` / `git`，否则 pi 的工具在容器里**跑不了构建和测试**

换句话说：Docker 能跑，但你要先把它的好处拆掉才能用。只想“重启不用手动开”，
LaunchAgent 是对的工具。真要在别的机器上跑再上 Docker。

## 回归验证

```bash
npm test                       # 单元测试
npm run typecheck              # 类型检查
npm run theme:check            # 我们的 Markdown/语法配色是否还和 pi 主题一致
npm run shot -- <url> <out.png> --wait 6000 \
  --eval "document.getElementById('input').value"
```

`scripts/screenshot.ts` 通过 Chrome DevTools Protocol 截图，并可用 `--eval` 跑断言。
用它是因为普通 `chrome --screenshot` 会卡在页面上的 SSE 长连接上。

页面把内部状态挂在 `window.piShellDebug` 上（`state` 及几个格式化函数），
方便断言“统计条到底算了什么”，不用去抓 DOM 文本。

## 设计原则

- **只依赖官方契约**：RPC 协议 + 会话文件格式，不碰 pi 内部实现，pi 升级不受影响。
- **运行时零依赖**：服务端只用 Node 内置模块；前端第三方库 vendor 进仓库，无构建步骤。
- **只读历史**：列出会话只读文件头尾，不修改任何已有会话。
- **不可信渲染**：模型输出、工具输出、文件内容全部先过 `DOMPurify` 再上屏；工具输出不做 Markdown 解释。
- **本地安全边界**：默认只绑 `127.0.0.1`，并校验 Host 头（拒绝 DNS rebinding）；见 `src/server/hostCheck.ts`。

本项目基于 MIT 协议开源（见 [LICENSE](LICENSE)）。前端 vendored 库的许可证见
[`src/web/vendor/README.md`](src/web/vendor/README.md)。

细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，进度与待办见 [`docs/PLAN.md`](docs/PLAN.md)。

## 目录结构

```
src/shared/types.ts            wire 类型
src/server/config.ts           配置
src/server/sessionIndex.ts     会话扫描/缓存/分组
src/server/piSession.ts        单个 pi RPC 子进程
src/server/sessionRegistry.ts  子进程生命周期
src/server/httpServer.ts       路由 + SSE + 静态文件
src/server/index.ts            入口
src/web/                       前端（无构建步骤）
src/web/vendor/                vendored 的 marked / DOMPurify / Prism（由 npm run vendor 生成）
scripts/plan.ts                计划进度工具
scripts/screenshot.ts          CDP 截图 + 断言
scripts/theme.ts               配色比对（npm run theme:check）
scripts/vendor.ts              拷贝前端第三方库到 src/web/vendor/
test/                          单元测试
docs/                          架构与计划
```
