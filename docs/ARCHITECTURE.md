# pi-web-shell — 架构说明

一个跑在本地的 **Web 外壳**，包在官方 `pi` 之上，用来替代「开一堆终端」。

它不是 pi 的替代品，也不是分支：它启动的就是你 PATH 里的那个 `pi`，
所以 `models.json` / `auth.json` / `settings.json` / `AGENTS.md` / skills /
历史会话全部原样复用。

## 全局结构

```
浏览器 UI
   │  HTTP + SSE
   ▼
本地 Node 服务（本项目）
   │  spawn + JSONL over stdin/stdout（pi 官方 RPC 协议）
   ▼
pi --mode rpc 子进程（每个打开的会话一个）
   │
   ▼
~/.pi/agent/sessions/**/*.jsonl（pi 自己读写）
```

## 进程模型

- **1 个 Node 服务**：托管前端、扫描会话目录、管理 pi 子进程。
- **每个「已打开的会话」1 个 pi 子进程**：用 `pi --mode rpc --session <path>`
  启动，`cwd` 设为该会话所属的项目目录，工具的相对路径才对。
- 同一个会话文件**只有一个写者**：所有消费者共享同一子进程（引用计数）。
- 最后一个消费者离开后，子进程保持 `PI_SHELL_IDLE_TIMEOUT_MS`（默认 15 分钟），
  然后优雅关闭（关 stdin → 等退出 → 超时才 SIGKILL）。
  **正在运行的会话不回收**：`agent_start` 会清掉回收定时器，`agent_settled` 且无人
  消费时才重新起算。所以刷新页面 / 关标签页只会断开消费者，不会杀掉还在干活的 agent。
- **崩溃的子进程立即作废，不进入「温着」状态**。`ManagedSession.dead` 在 `onExit` 时置位；
  没人消费就马上 dispose，还有人消费就等最后一个消费者 `release()` 时 dispose。
  `acquire()` 遇到 dead 记录会先 dispose 再**重新解析**，绝不把死进程发出去（不能顺着往下 spawn：
  dispose 的等待期间别的消费者可能已注册新子进程，落穿会造出第二个写者）。
  `release()` 按 **managed 实例**归还引用，dispose 按**同一性**拆卸条目：持有已被替换旧条目的
  消费者，晚到的 release 不会扣到新条目的 refs，更不会把新子进程带下去。
  这条不是洁癖：pi 对已销毁的 stdin 是静默丢弃、`get_state` 永不回，所以把死进程发给
  一条新流，那条流会**永远等不到 snapshot**（挂骨架屏），而且它占着 ref，连空闲回收都
  触发不了 —— 一个崩溃的 pi 会让那个会话永久不可用。另外 `PiRpcSession.stop()` 对已退出的
  子进程直接返回，否则要白等完 5s 宽限期才对死 pid 发 SIGKILL。

### 运行态怎么来的

每个子进程在 `SessionRegistry.watch()` 里挂一个常驻监听：`agent_start` → 运行中，
`agent_settled`（或进程退出）→ 结束。pi 的 RPC 事件在整个子进程生命周期内都会到达，
**跟有没有浏览器在看无关**，所以这是权威信号，不需要轮询或猜会话文件的 mtime。
变化通过 `onActivity` 广播，`/api/sessions` 的每个会话据此带 `running` 字段。

每条 activity 帧还带一个 `reason`，因为「不再运行」有四种来源，客户端必须能区分：
`started`（开跑）、`settled`（正常跑完，含 abort）、`exited`（子进程死了）、
`retired`（空闲回收 / 改配置后 `disposeAll`）。前两者是「这次任务结束了」，
后两者不是。前端只对 `settled` / `exited` 弹通知，且 `retired` 绝不能弹——
否则每次回收暖会话都会变成一次骚扰。

局限：只有本服务 own 的子进程能被感知。你在终端里另起的 `pi`（交互式或 RPC）没有
接入这个注册表，看不到运行态。

## 只依赖官方的两个契约

| 用途 | 契约 | 文档 |
|---|---|---|
| 对话 / 读历史 / 切模型 / 发图 | RPC JSONL 协议 | `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md` |
| 列文件夹、列会话 | 会话文件头（`cwd`/`id`/`timestamp`）+ `session_info` | `docs/session-format.md` |

不使用任何 pi 内部实现细节。pi 升级时，只要这两个文档化的接口不变就不受影响。

### 会话目录名是不可信的

`--Users-you-my-project--` 是把路径里的 `/` 换成 `-` 得到的，**有损**
（真实目录名里的 `-` 会混淆）。所以工作目录永远读文件头里的 `cwd` 字段，
绝不解析目录名。

### 索引要兼容两种会话布局

pi 有两种落盘方式：

```
<sessionsDir>/--<encoded-cwd>--/<file>.jsonl   # pi 自己的分组（默认）
<sessionsDir>/<file>.jsonl                     # 传了 --session-dir 时（平铺）
```

**默认不传 `--session-dir`**：让 pi 自己按上面的分组布局落盘。只有分组布局才会被
CLI 的 `/resume`（它只扫 `<sessionsDir>/--<cwd>--/`）看到；一旦传了 `--session-dir`，
pi 会把文件平铺在该目录根，`/resume` 的「本项目」和「全部会话」两个页签都看不到，
只有本项目的 `SessionIndex` 认这种布局。

唯一的例外是 `PI_SHELL_SESSIONS_DIR`：这是我们自己的开关，pi 不会去读，所以必须用
`--session-dir` 把子进程钉到同一个目录（否则新会话落到 pi 的默认目录，会被路径校验拒掉）。
此时同样使用平铺布局，需要在 CLI 里用同样的 `--session-dir` 才能看到。

`SessionIndex.listSessions()` 两种布局都扫。

### 新会话的文件是“未来路径”

pi 只有在第一条消息时才会把会话写盘。所以新建会话后 `get_state` 返回的
`sessionFile` 可能还不存在：

- `/api/sessions` 把它们作为 `pending: true` 的条目返回，前端显示「新」徽章；
- `/api/stream` 对这类 path 不要求文件存在，有活子进程就够；
- 第一条消息发出后文件落盘，自动转为正式会话。

### 大文件只读头尾

`~/.pi/agent/sessions` 实测 161MB / 136 个文件（21 个 >2MB）。
列会话时只读文件头 256KB（拿 header + 首条用户消息）和尾部 128KB（拿最近的
`session_info` 名字），并按 `mtime + size` 缓存。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | `{ home, folders, sessions }`，只包含有会话的文件夹；每条带 `running`（运行态）与 `pending`（文件未落盘） |
| POST | `/api/sessions/new` | `{ cwd }` → 在该目录启动新会话，返回 `{ path, cwd, state }` |
| POST | `/api/rename` | `{ path, name }` → `set_session_name`；未打开的会话先 acquire 一次、写完归还 |
| POST | `/api/delete` | `{ path }` → 会话文件进废纸篓（没有 `trash` 就 unlink），删前先 dispose 活跃子进程 |
| POST | `/api/delete-folder` | `{ cwd }` → 删除该目录下全部会话文件（并行），不碰目录本身与其他文件 |
| GET | `/api/stream?path=<file>` | SSE：先发 `snapshot`（state + messages + stats），后转发实时事件。响应 gzip |
| GET | `/api/events` | SSE：全局会话运行态。每帧 `{type:"activity", path, running, reason}`，连接时先补发当前运行中的会话。与具体会话无关，所以没打开该会话也能收到 |
| GET | `/api/tree?path=<file>` | 代理 `get_tree`，再经 `treeView.ts` 瘦身成面板要的 `{ nodes, leafId }`（只有 id/kind/preview/label/active） |
| POST | `/api/fork` | `{ path, entryId }` 或 `{ path, fromEnd }` → `fork`；返回 `{ ok, cancelled, text, entryId, sessionFile }`。`fromEnd` 用于内联编辑/删除（快照里的消息没有 entry id） |
| POST | `/api/clone` | `{ path }` → `clone`，再 `get_state` 补回副本路径；子进程若切了文件就 dispose 它防漂移 |
| GET | `/api/image/<sha1>` | 快照里的图片字节，内容寻址 + `immutable` 缓存 |
| GET | `/api/local-image?path=<abs>` | 正文 Markdown 引用的本地图；魔数嗅探只放行 PNG/JPEG/GIF/WEBP，ETag 用 size+mtime |
| POST | `/api/prompt` | `{ path, message, images? }`，流式中自动用 `followUp` |
| POST | `/api/ui-response` | 回填扩展 UI 请求（`extension_ui_request`）的答案 |
| POST | `/api/abort` | `{ path }` |
| POST | `/api/model` | `{ path, provider, modelId }` → `set_model` |
| POST | `/api/thinking` | `{ path, level }` → `set_thinking_level` |
| GET | `/api/models?path=<file>` | `{ models, model, thinkingLevels, thinkingLevel }`；需要该会话的子进程在线，客户端在 `snapshot` 后调用 |
| GET | `/api/commands?path=<file>` | `get_commands` 精简后的命令表，供 `/` 菜单用 |
| GET | `/api/settings/usage` | 全部会话的 token / 花费汇总（只读，见下） |
| GET | `/api/settings/environment` | pi 会加载什么 + 可写白名单 + 本服务运行参数（见下） |
| POST | `/api/settings/save` | 白名单补丁 `{点分键: 值|null}`；校验失败 400；写成功后**不回收任何子进程**（见下「为什么设置保存不回收」） |
| POST | `/api/settings/agents-md` | `{ content }` → 重写 AGENTS.md（备份 + 原子写），之后 `disposeAll()` |
| POST | `/api/settings/mcp` | `{ name, enabled }` → 按 pi 的写法改 mcp.json 条目的 `enabled`，之后 `disposeAll()` |
| GET | `/` | 静态前端（`src/web`）；`/settings` 回落到同一个 `index.html`，其他路径不回落（打错的资源仍 404） |

SSE 帧格式：`snapshot` | `event`（pi 原始事件） | `stats`（`get_session_stats` 结果） | `error`。
`stats` 在开流时随 `snapshot` 一起下发，并在每次 `agent_settled` 后重新推送，
所以统计条不需要轮询。

`/api/events` 是另一条独立的长连接，只推运行态。页面加载时 `refreshSessionList()` 先用
`/api/sessions` 拿一次当前状态，`/api/events` 连接时再补发运行中的会话，避免两次请求之间的空窗丢事件。
它驱动三件事：侧栏的绿点（会话级 + 文件夹聚合）、「你切走的会话跑完了」的通知、
以及标题栏的 `(n)` 未读角标。

后端会话不进 `SessionRegistry`，所以**切走只是关掉 `/api/stream`，不是停掉子进程**：
`release()` 在 `streaming` 时不 arm 空闲回收，子进程继续把这一轮跑完。
前端 `applyActivity(path, running, reason)` 只在「不是当前打开的会话、且 reason 是
settled/exited」时提醒；用户点过「停止」的路径会先记进 `abortedPaths` 抑制掉，
因为 abort 走的也是 `settled`，和自然结束无法从事件本身区分。

提醒的 toast 带 `toast-global` 类：`resetExtensionUi()`（切会话时）只清扩展的通知，
不清这类跨会话的通知。`document.title` 由 `applyDocumentTitle()` 单点写入，
把扩展的 `setTitle` 和未读角标叠在一起（两个互不相关的来源不能各写各的）。
打开会话即视为已读，开跑新一轮也会清掉该会话的旧角标。

**两条长连接的重连策略不一样，因为代价不一样**：

| 连接 | 断了会怎样 | 策略 |
|---|---|---|
| `/api/events` | 只是丢运行态 | 交给浏览器自动重连，无限次都无所谓 |
| `/api/stream` | 服务端会 `acquire` 这个会话 → **拉起一个 pi 子进程** | 前端接管重连：3 次（0.5s/1s/2s 退避），用尽后 `close()` 并提示「在左侧点一下这个会话即可重连」 |

所以「pi 崩了」既不会让会话永久废掉（服务端会换新子进程），也不会变成无限拉起进程的
循环（前端有上限）：实测杀掉子进程后页面 1 秒内自愈，杀服务端后重试 3 次停手。

## 安全

- 默认只绑 `127.0.0.1`，并校验 `Host` 头（只放行 loopback 名字），挡 DNS rebinding ——
  见 `src/server/hostCheck.ts`。绑到非 loopback 时视为显式放弃本地模型，跳过这项检查。
- `/api/stream` 与静态文件都做路径包含校验，session 路径必须在配置的
  sessions 目录内且以 `.jsonl` 结尾。
- `/api/local-image` **不是通用文件读接口**：路径必须绝对存在，且类型由**魔数**决定、
  不看扩展名，只有真的 PNG/JPEG/GIF/WEBP 字节能离开进程；单文件上限 64MB。
- 设置页的写路径不收整份 JSON：只认白名单里的扁平 `{点分键: 值|null}` 补丁，逐值做类型/范围校验，
  白名单外的键原样保留（见下「设置页」）。
- 不引入任何运行时依赖（只用 Node 内置模块），减少升级面。

## 前端第三方库

`src/web/vendor/` 里的文件由 `npm run vendor` 从 `node_modules` 生成
（`postinstall` 会自动跑）。前端是原生 ES module，没有打包器，也不需要 CDN。

| 文件 | 用途 | 加载方式 |
|---|---|---|
| `marked.esm.js` | Markdown 解析 | ES module |
| `purify.es.mjs` | 消毒（模型/工具输出均不可信） | ES module |
| `prism.js` | 代码高亮核心 | classic script（定义全局 `Prism`） |
| `prism-languages.js` | 13 种语言定义，仓 vendor 时拼接成一个文件 | classic script，必须在 `prism.js` 之后 |
| `mermaid.min.js` | 图表渲染（~3.4 MB） | classic script，**按需**注入，不用就不下载 |

Prism 以 `window.Prism = { manual: true }` 加载，禁止它自己扫描 DOM；
高亮在 `marked` 的 `code` renderer 里显式调用，顺便把语言标签和复制按钮一并生成。
未标注语言的代码块不做猜测，直接转义——错误的高亮比不高亮更坏。

Markdown 渲染路径：`marked.parse()` → `DOMPurify.sanitize()` → `innerHTML`。
工具输出、思考块不走 Markdown，保持逐字显示。

## Mermaid 图表

```mermaid 围栏被 `marked` 渲染成一个占位块，真正的图在 DOM 里再异步补上：

1. renderer 产出 `.mermaid-body`（占位）+ `.mermaid-source`（围栏原文，默认 `hidden`）。
2. `MutationObserver` 盯着 `#messages`，发现新的 `.mermaid-body` 就排队渲染。
3. 队列串行执行 `mermaid.render()`，成功写回 SVG，失败显示原因并展开源码。

几个不得不这样的理由：

- **源码不能放在属性里**。DOMPurify 会丢掉值里带注释终止符（`-->`）的属性，
  而箭头是每个图表都有的东西，所以只能用文本节点带过去。
- **不能用 `data-*` + `innerHTML` 一次成型**：mermaid 是异步的，且需要活着的元素。
  流式结束时气泡会整个重写，`MutationObserver` + 每块的状态标记保证重复渲染幂等。
- **渲染结果不再过 DOMPurify**（它绕过 sanitize 直接写 DOM），所以 `securityLevel: 'strict'`
  不能改：标签转义、禁用 `click` 指令，由 mermaid 自己用 DOMPurify 做。
- **按需加载**：3.4 MB 是 Prism 全集的两倍多，而多数会话没有图表，
  所以脚本在第一个 ```mermaid 出现时才插入（`loadMermaid()`）；代价是首图有一次本地请求延迟。

## 配色来自 pi，不是自己调的

`style.css` 里 `--md-*` 和 `--syntax-*` 这两组变量**逐个复制自 pi 的主题**，
来源是 pi 自己的源码：

```
dist/modes/interactive/theme/theme.js    getMarkdownTheme() —— 哪个元素用哪个键
dist/modes/interactive/theme/dark.json   配色定义（okhsl 色彩空间）
dist/core/export-html/template.css       pi 官方把会话渲染成 HTML 的样式
```

`dark.json` 用的是 `okhsl()`，手动换算容易出错，所以取值走 pi 自己的
`export_html` RPC：它会先把主题解析成 `:root` 里的一堆 hex，直接读就行。

因为 pi 升级后主题可能变，`npm run theme:check` 会重新导出并逐项比对：

```bash
npm run theme:check
# ✅ 18 colours match pi's current theme
# 或 ❌ 列出每一个漂移的变量
```

几处容易搞错、但已对齐的点：

| 元素 | pi 的颜色 |
|---|---|
| 标题 | `mdHeading` 琥珀 `#cd9a22` |
| 行内代码 | `mdCode` 紫 `#a798d7` |
| 列表圆点 | `mdListBullet` 紫 |
| 未标记语言的代码块 | `mdCodeBlock` 绿 `#68b78d` |
| 字符串（高亮时） | `syntaxString` **橙色** `#de8d5a` |
| 表格边框 | `mdCodeBlockBorder` `#9da5a9` |

另外 pi 的 `highlightCode` 明确写了：没有合法语言时**不高亮**，
因为 cli-highlight 的自动识别会把普通英文单词误判成关键字。我们保持同样策略。

## 代码地图

```
src/shared/types.ts        wire 类型（服务端与前端共享的定义）
src/server/config.ts       环境变量配置
src/server/index.ts        入口：启动 + 开浏览器 + 信号处理
src/server/httpServer.ts   HTTP 路由、SSE、静态文件
src/server/sessionIndex.ts 扫描/缓存会话，按 cwd 分组
src/server/sessionRegistry.ts  子进程生命周期与引用计数
src/server/piSession.ts    单个 pi RPC 子进程：JSONL 编解码、请求/响应关联、事件分发
src/server/paths.ts        会话路径归一（realpath 到最深存在祖先，pending 键落盘前后一致）
src/server/hostCheck.ts    Host 头校验（DNS rebinding）
src/server/commands.ts     get_commands 结果瘦身
src/server/extensionUi.ts  扩展 UI 请求/状态（对话框、状态行、widget），含快照重放
src/server/imageStore.ts   快照里图片字节的内容寻址缓存（LRU）
src/server/localImage.ts   /api/local-image 的魔数嗅探与读取
src/server/treeView.ts     get_tree 结果重塑成分支树面板的 payload
src/server/settingsStore.ts  settings.json / AGENTS.md / mcp.json 的白名单写路径
src/server/usageStats.ts   跨会话 token / 花费统计（按 mtime+size 缓存）
src/server/environment.ts  只读地读 pi 的配置、skills、mcp.json
src/web/                   无构建步骤的前端（HTML/CSS/JS）
src/web/i18n.js            外壳文案字典（zh-CN / en，含 data-i18n 填充）
src/web/vendor/            vendored 的 marked / DOMPurify / Prism / Mermaid
test/*.test.ts             node:test 单测（单测与编排见 package.json）
scripts/plan.ts            读 docs/PLAN.md 打印进度与下一项
scripts/screenshot.ts      CDP 截图 + 断言（普通 --screenshot 会被 SSE 长连接卡住）
scripts/theme.ts           与 pi 主题逐项比对配色是否漂移
scripts/vendor.ts          拷贝前端第三方库
scripts/launchd.ts         LaunchAgent 安装/卸载/状态/重启
scripts/ui-test.ts         ui:test 总入口：typecheck + 单测 + 全部 ui-test-*.ts
scripts/ui-test-*.ts       各功能的 CDP 断言（侧栏/mermaid/token 速度/滚动/设置页路由/
                           设置页写操作/分支树），一套隔离服务端共用
```

## 前端渲染模型

消息区只有两种东西：

- **正文气泡**：助手有文字/图片的回合，以及用户消息。
- **活动块（`.tool-group`）**：连续的思考 + 工具调用 + 工具结果，聚成一个
  `<details>`，默认收起，摘要形如 `思考 + 12 次工具调用 · read ×4、bash ×8`。

规则：思考 + 工具调用之间没有正文的回合不单独占气泡（否则一个长任务会刷出
几十个空洞的气泡）；一旦助手重新说话就关掉活动块，开新的。

**一次工具调用 = 一个条目**。实时路径靠 `tool_execution_start` 建条目、
`tool_execution_end` 回填结果；历史路径拿 `toolCall.id` 与
`toolResult.toolCallId` 做匹配，效果一致。

实时渲染时活动块保持展开（能看到进展），`agent_settled` 后折叠。

## 分支树面板

pi 的会话是 append-only 的树：每条 entry 带 `parentId`，当前叶子是 `leafId`（`get_tree`）。
面板只需要「谁在说话 + 一行预览 + 在不在当前分支」，所以服务端 `treeView.ts` 先瘦身：
丢掉完整消息内容与工具结果，只留 `id / kind / preview(≤ 120 字) / label / active`。

`active` 是**算出来的**，不是读出来的：从 `leafId` 沿 `parentId` 往上走到 root，
路上的节点进集合。当前在哪条分支只由 `leafId` 决定，跟同一层兄弟节点的先后顺序无关。

前端布局（M2.16 重做，之前每轮缩进一层，线性会话成了长楼梯）：活动 root→leaf 链平铺成
主干（顶格，每行 = 一条用户消息 + 其后的回复，回复折到行下第二行）；每个岔路收成一个默认
折叠的「⑂ 分支 · N 条 · 预览」胶囊，展开后按同样规则递归（分支内部没有 active 标记，
以首子链代替主干）。展开态存在 `state.treeExpanded`，重渲染不丢。

两个动作直接转发官方 RPC：`fork(entryId)`（从某条用户消息分叉）与 `clone`（复制整条会话）。

**关键事实：RPC 的 `fork` 每次都新建一个 session 文件**（`createBranchedSession` 把 active path
拷贝到新文件，`parentSession` 指回原文件），不是在原文件里就地开分支——官方 `/tree` 的就地
导航没有 RPC 入口。但 `fork` 的 response 只回 `text`，**不回新路径**，所以 `/api/fork`、`/api/clone`
都要补一发 `get_state` 拿 `sessionFile`：

- `clone` 把副本当新会话，原标签页继续看原文件 → 把切走的子进程 `dispose` 掉，下次 acquire 重新
  spawn 在原文件上。
- `fork`（分叉、以及内联编辑/删除）则**切到新文件**：返回 `sessionFile` 给前端，前端 `refreshSessionList()`
  再 `openSession(新路径)`。不这么做，标签页会继续拿着一个「已经在写别的文件」的子进程，
  标题/路径与实际内容对不上。

### 内联「编辑 / 删除重发」

用户消息气泡悬停下出三个**纯图标**按钮（✎ 编辑 / 🗑 删除 / 📋 复制，文案只在 `title` 里），
编辑与删除就是 pi 官方的「回到这条之前再重发」（`/tree` 选中→改→提交）的
RPC 版：

- `fork` 只接受 **user 消息**，语义是「把叶子回退到它的 `parentId` 并返回它的文本」。
  所以「编辑」= fork + 把 text 填回输入框，「删除」= fork + 不填。被丢掉的旧内容**并未删除**，
  只是不再是活动分支（旧 session 文件仍在磁盘上）。
- 快照里的消息来自 `get_messages`，**不带 entry id**；而 `get_fork_messages` 不做分支过滤。
  所以前端发「倒数第 N 条 user 消息」（`fromEnd`），服务端用 `treeView.activeUserEntryIds()`
  从 `leafId` 沿 `parentId` 走出活动分支的用户消息再取第 N 条。从**末尾对齐**是安全的：
  压缩只会丢掉旧消息、不会重排，所以尾部总是对得上。
- `fromEnd` **在点击时才算**，不能用渲染时写进 `data-*` 的值——期间新发一条消息就会指错 entry。
- 运行中点编辑/删除会先 `abort` 并等 `agent_settled`（`waitForIdle`），否则会在飞行中的一轮
  底下把 agent 拆了。
- `fork` 只回文本，**图片不回来**：带图的消息会额外提示「图片不会自动带回」。

**旧文件不再出现在侧栏**（`supersessions.ts`）：用户的认知是「编辑就发生在当前会话里」，
但 fork 必然新建文件，两个同名会话会被当成 bug。所以 `/api/sessions` 把链折叠到 tip：
某文件只要存在一个**fork 后就再没写过**的子文件（header `parentSession` 指向它，且父文件
最后写入 ≤ 子文件创建时间）就从列表里隐去。**比较基准是子文件的创建时间而不是它的最后
活动**——fork 之后还在旧文件里继续写（或后来又 resume）的父会话是独立线程，永远保持可见，
不管子文件后来多活跃。规则能自愈：子文件被删则父文件重新出现。两类「故意复制」豁免：
`clone` 和分支树里的显式 `fork(entryId)` 会在 agent 目录旁的
`<dirname(agentDir)>/web-shell/branch-marks.jsonl`（默认 `~/.pi/web-shell/…`，跟随
`PI_CODING_AGENT_DIR` 隔离）给子文件打 keep-parent 标，父会话保持可见；内联编辑/删除
（`fromEnd`）不打标，父文件折叠。「删除整个目录」（`handleDeleteFolder`）传
`includeSuperseded` 绕过折叠，保证隐藏文件也能被删到。

同一条动作行还兼顾时间与统计（M2.21.1）：

- 用户气泡 hover 时行首是**发送时间**（`message.timestamp`，本地 `YYYY-MM-DD HH:mm:ss`）。
- 助手气泡的复制按钮从右上角移到这里，**最后一条回复**的统计行常驻：
  `用时 · ↑input ↓output · 结束时间`（箭头与底部统计条同一口径），数据来自消息自带的 `usage.input`/`usage.output` 与
  `timestamp`；**input/output 是整轮累加**——带工具的一轮是几十次模型调用，只取最后一条会
  严重偏小（实测 575 vs 40,839）；用时 = 该轮用户消息 ts → 回复 ts（直播时用客户端记的 `turnStartMs`）。
  只有最后一条常驻——它后面没有消息，绝对定位的浮动行不会压到别的气泡；旧回复 hover 才显示。
- 行本身是 `position: absolute; top: calc(100% + 1px)`：不占高、不撑气泡，
  hover 过渡区用 `padding` 不用 `margin`（margin 会在气泡与按钮之间留一段死区，
  鼠标下移时 `:hover` 断掉、按钮闪）。

### 一个被测试盲区掩盖的真 bug（M2.21 修）

`treeView.convert` 一直从 entry 顶层读 `role`/`content`，但 pi 的 entry 是
`{type:"message", id, parentId, timestamp, message:{role, content}}`——role/content 在 `message` 里。
后果是**每个节点都被当成 assistant、预览全是「…」，用户节点永远没有「从这里分叉」按钮**。
UI 测试 stub 的是已经重塑好的 payload、单测的 fixture 又把 role/content 放在顶层，
两边都刚好绕过了真实形状。修法：从 `entry.message` 读，并按 CLI 的默认视图
隐掉 system 消息与 `usage/model_change/thinking_level_change/...` 这些簿记 entry——
隐掉时**子节点上提**（hoist），否则夹在中间的簿记节点会把后面整条分支吞掉。

图片查看是顺手加的同层交互：`#messages` 里任意图片（正文本地图、工具截图占位符）点击都
在应用内 lightbox 打开全图，Esc 或点遮罩关闭，不再依赖开新标签页。

## 扩展 UI

pi 扩展可以通过 `extension_ui_request` 向宿主弹对话框（`select` / `confirm` / `input` / `editor`），
或设置状态行、编辑器上/下方的 widget 与标题。这不是 TUI 专属能力，所以外壳接住它：

- **有状态的部分**（`setStatus` / `setWidget` / `setTitle`）由 `extensionUi.ts` 折叠进每个子进程
  常驻的 `managed.ui`；省略 payload 即撤回该键（这就是扩展的清理方式）。快照帧带 `ui` 字段，
  所以刷新 / 重连后状态能重放，不会只剩对话框。
- **一次性的对话框**以原始事件推给前端，在页面上真实渲染成表单；提交走 `POST /api/ui-response`，
  由 `buildUiResponse` 塑形回 `extension_ui_response` —— `cancelled` 优先于值（不能既回答又取消），
  `confirm` 是布尔、`select` / `input` / `editor` 是字符串，其他一律拒绝而不是猜。
- 这些规则都是纯函数放在 `extensionUi.ts`，不用 spawn pi 就能单测。

## 统计条

数据全部来自 pi 的 `get_session_stats`：上下文占用、累计 input/output、
缓存命中、花费、轮数与工具次数。服务端在开流和每次 settle 后推送，客户端不轮询。

**token 速度是客户端算的，粒度是单条 assistant 消息**：分子是该消息的累计输出
（`usage.output`，provider 没报时按 delta 估算，CJK 字符 ≈ 1.4 字/token、其他 ≈ 4 字/token），
分母是从**该消息第一个 delta** 到当前时刻。三条规则保证比值两边覆盖同一段工作：

1. 计时起点是首个 delta，不是 `agent_start` —— 首 token 延迟不算解码时间；
2. 文本、思考、工具参数三类 delta 都计入分子，也都会启动时钟（思考的 token 和它的耗时
   必须成对出现，否则先思考后出字的轮次会虚高）；
3. 计数在每条 `message_start` 重置，因此工具执行时间和轮次间隙天然不进分母，
   多轮也不会出现「拿上一条的 token 数除整轮耗时」的错算。

`message_end` 时用消息里权威的 `usage.output` 冻结终值（provider 只在收尾报 usage 时，
这一步才拿到真实值）；`agent_settled` 之后保留该终值，直到下一轮开始。带 `≈` 前缀表示
分子是估算的。

## 体积策略

一个实战数据：某个会话文件 28.4MB，其中 **26.56MB 是图片 base64**（21 张来自 `read`
工具、4 张用户粘贴），文本部分只有 1.8MB。把 pi 的 `get_messages` 直接转发给浏览器，
每次打开会话就要传 28MB。

三层处理：

1. **图片换成引用**：快照里每个 image block 只发 `{hash, mimeType, width, height, bytes}`，
   字节存在服务端内存（`ImageStore`，LRU 上限 256MB），由 `/api/image/<sha1>` 提供。
   因为 URL 就是内容哈希，可以 `immutable` 永久缓存。
2. **按来源决定显示**（照搬 pi）：用户贴的图内联并 `loading="lazy"`；工具返回的图
   只给 `🖼 [image/png 2000×1250] · 855 KB` 占位符，点击才请求。
   依据：`dist/core/export-html/tool-renderer.js` 对 tool result 写的是 `showImages: false`，
   而 `dist/core/tools/render-utils.js` 的 `getTextOutput` 会回退到 `imageFallback()` 占位符。
3. **SSE gzip**：文本（thinking、工具入参、工具输出）压缩比约 4x，逐帧 `Z_SYNC_FLUSH`
   保证流式不被缓冲。

结果：首帧 27.9MB → 494KB，1.56s → ~30ms。

另外，切换会话时不会立刻闪占位文字：只有超过 250ms 还没拿到快照才显示骨架屏。

## 设置页

文件夹栏左下角的「⚙ 设置」进入一个独立视图（`#app[data-view="settings"]` 把三个 pane 隐藏掉，
由 `#settings-view` 自己占满窗口），布局是左菜单 + 右内容，Esc 返回。

菜单五项（按页面顺序）：

| 菜单 | 状态 | 数据来源 |
|---|---|---|
| token 统计 | ✅ 只读 | `usageStats.ts`：扫 session jsonl 里每条 assistant 消息的 `usage`；按天 / 模型 / 项目 / 会话汇总，带 GitHub 式每日热力图与模型筛选 |
| 技能 / MCP / 插件 | 清单只读，MCP 可开关 | `environment.ts`：扫 agent 目录的 `skills/`、读 `settings.json` / `mcp.json`；MCP 的启用/禁用写回 `mcp.json` |
| 模型配置 | ✅ 可写（白名单） | `settings.json` 的默认值、文件状态，以及三个可编辑键 |
| 语言、主题 | ✅ 可切换 | 外壳自己的偏好，存 localStorage；浅色配色是从 pi 的 light 主题取色后写死的（见下） |
| agent 设置 | ✅ 可写（白名单） | 同模型页，外加 AGENTS.md 编辑器 |

两条刻意的取舍：

- **读的部分不碰 pi 的子进程**。token 统计从会话文件里算，skills / MCP 从配置文件里读，
  所以没有打开任何会话时这个页面也能用。也因此不跑 `pi mcp list`（它会真的去连 server、
  可能拉起 `npx` 或弹 OAuth），代价是看不到连接状态，页面会直说。
- **没实现的就直说没实现**（「计划中」+ 打算怎么做），不摆假控件。

### 写路径

写盘纪律只有一条：**浏览器永远不发一份要照抄的 JSON**。

- `POST /api/settings/save` 收的是扁平 `{ "点分键": 值 | null }`，键必须落在服务端的
  白名单（`EDITABLE_KEYS`，17 个对 web 有意义的键）里，逐值做类型与范围校验；
  `null` / 空串 = 删键、回退 pi 内置默认。嵌套键（`compaction.modelOverrides`、
  `retry.provider` 这类兄弟键）与 theme/packages 等白名单外的键**原样保留**。
- TUI 专属键（`theme`、`tuiMode`、`fullscreen*`、`terminal.*`）刻意不进页面——那是 pi TUI 的事。
- 每次写入先备份 `*.bak`（存改前的字节），再 `tmp` + `rename` 原子替换：
  中途崩掉不会留下半个文件。文件存在但 JSON 解析失败时**拒绝覆写**，不当成「文件不存在」继续。
- AGENTS.md 与 mcp.json 走同一条 `backupAndWrite`。MCP 按 pi 自己的写法：禁用写
  `enabled: false`（保留条目不连接），启用则删掉该键（缺省即启用）。
- **写完不回收子进程**（曾经的 `disposeAll()` 已移除）。settings.json 里这些键是 pi 的
  **启动默认值**，而我们一度把「让改动立即生效」和「不打断会话」两个目标混在一起了：
  回收全部暖子进程会（a）把正在跑的一轮掐断，（b）让**每个仍然用默认值的旧会话在重开后换模型**
  ——后者不是用户要的。pi 自己的恢复逻辑（`core/sdk.js`）是：会话有 `model_change` 条目就
  用会话里的模型，只有从未选过模型的会话才回退到 `defaultProvider`/`defaultModel`
  （thinking level 同理）。所以正确的语义是「**只对之后 spawn 的子进程生效**」：
  新建会话自然拿到新默认值，已在运行的会话不受影响；旧会话被回收后重开时才会读到新默认值，
  那是 pi 的行为、不是我们在保存瞬间强行改的。
- **AGENTS.md / mcp.json 仍然在写完 `disposeAll()`**：这两样是子进程启动时一次性注入的
  提示词与 MCP 连接，不回收则页面上改了、跑着的会话仍是旧的。它们的语义更接近「连接」
  而不是「默认值」，所以保留强制生效（代价同样是打断运行中的一轮，见待办）。

为什么 token 统计要自己扫文件：pi 只有 `get_session_stats`（单会话、且需要子进程在线），
没有任何跨会话的用量存储。而每条 assistant 消息都带着 provider 报的 token 与花费，
所以文件就是权威账本。212MB / 153 个文件的目录实测冷扫 0.5s，之后按 `mtime + size` 命中缓存。

热力图与模型筛选的两个决定：

- **扫描时多记一列 day × model**。总量、项目、会话的「按模型」切片能从每个文件的 `byModel` 推出来，
  但「某天某模型用了多少」不行（`byDay × byModel` 相乘是错的），所以文件里额外存一层 `byDayModel`。
  `/api/settings/usage` 因此直接带 `models: { [模型]: 切片 }`，切模型只是换数据源，
  不再跑第二遍扫描（真实数据 6 个模型 / 154 文件约 98KB）。
- **热力图横轴固定为全量的日期范围**，不跟着筛选后的模型缩，否则切模型时格子数量会变、
  两张图无法对比；而四档分位阈值按当前选择的数据算（每个非零日的 p25/p50/p75），
  这样单独一天特别大时不会把其余日子全压成最浅一档。
  深色背景下用「越亮 = 越多」（同 GitHub 暗色模式），再深就看不出格子了。
  悬停用一个固定定位的卡片（`#heat-tip`，`<body>` 的子节点，不会被滚动容器裁掉）显示
  `日期+周几 / 总 token / 输入·输出（含思考）/ 缓存读写 / 花费·调用次数`，
  而不是原生 `title`：后者有约 1s 延迟、样式不可控，也显示不了多行拆分。
  事件用委托 + `relatedTarget` 判相邻格子，避免在格子间滑动时闪烁；滚动或退出设置页时隐藏。

## 主题与语言

两者都是**外壳自己的偏好**，存在 localStorage（`piShellTheme` / `piShellLocale`），
不写 pi 的 `settings.json`：pi 的 `theme` 是 TUI 的事，跟这个页面的颜色无关；
pi 也没有任何 locale 设置，硬写进去等于偷偷改了另一个程序。

**主题**（`system` / `dark` / `light`）：

- CSS 只认 `:root` 一整套变量 + `:root[data-theme="light"]` 的覆盖；`system` 在 JS 里
  用 `prefers-color-scheme` 解析成具体值写进 `data-theme`，CSS 不需要跟媒体查询打交道。
- 顺带把原来写死在样式表各处的颜色（工具块、思考块、骨架屏、行号底色……）收成了
  一层 `--tool-border` / `--thinking-text` 之类的角色变量 —— 这是加第二套主题的前提。
- 浅色配色的来路分两半：`--md-*` / `--syntax-*` 是 pi 自己的 light 主题解析出来的 hex
  （跟深色那批同样的做法，`npm run theme:check` 现在会**同时比对两套**，因为 HTML 导出
  取的是 `theme` 设置而不是 `--use-theme`，比对浅色得临时指一个只写了
  `{"theme":"light"}` 的 agent 目录）；界面本身的底色/边框/气泡是这里设计的——
  pi 的主题只覆盖 markdown 与语法高亮，网页外壳的“面板色”本来就得自己定。
- 首屏不闪：`index.html` 里有一段内联脚本，在样式表之前把 `data-theme` 算好
  （逻辑与 `applyTheme()` 重复是有意的，内联才能跑在首次绘制之前）。
- 深色下热力图是「越亮越多」，浅色下是「越深越多」——同一套 `--heat-0..4`，
  两套值方向相反。在浅色背景上再亮就看不出格子了。

**语言**（`zh-CN` / `en`）：

- 字典在 `src/web/i18n.js`：平坦的 `key: text` + `{placeholder}` 插值，
  没有 i18n 库、没有构建步骤。取不到的 key 会显示成 key 本身（宁可刺眼也不要空白）。
- 静态标记用 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` /
  `data-i18n-aria` 标注，`applyStaticText()` 统一填；动态部分（侧栏、设置页）由
  `t()` 生成。
- **服务端不返回文案**：`/api/settings/environment` 的脚注返回的是 id
  （`noteIds: ["readonly", "mcpNoConnect"]`），措辞在客户端字典里 ——
  服务端没道理知道浏览器在用哪种语言。
- 不翻的东西：会话标题、消息正文、工具输出、skill 的 description、路径（都是数据），
  以及 pi 自己吐的文本（工具名、报错、思考）。语言选择器里「中文 / English」
  也永远各自显示自己的名字。
- 切语言会 **reload**：正文气泡是渲染时就带上文案的，原地重译等于要再留一份消息副本；
  localhost 上重载是瞬时的，SSE 会自己重连。会话正在跑的时候重载也丢不了东西
  （内容在会话文件里，快照会补回来）。

## 为什么用 SSE 而不是 WebSocket

事件是单向的（服务端 → 浏览器），命令是低频 POST。SSE 是普通 HTTP，
浏览器原生 `EventSource` 支持、自动重连、无需额外依赖。够用且简单。
