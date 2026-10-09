# pi-web-shell — 开发计划

跟踪方式：每项 [ ] → 开发 → 验证 → 改成 [x] → 进入下一项。
随时运行 `npm run plan` 查看进度条和「下一项」。

## M1 最小可用（已完成）

- [x] 搭建 Node + TypeScript 骨架，零运行时依赖，Node 直接跑 .ts — 验证：`npm start` 正常启动
- [x] 扫描 `~/.pi/agent/sessions`，按文件头 `cwd` 分组，只显示有会话的文件夹 — 验证：单元测试 + 冒烟 `/api/sessions`
- [x] 会话列表：优先 `session_info` 名字，否则首条用户消息，配相对时间 — 验证：单元测试 6/6
- [x] 大文件只读头尾（256KB/128KB）+ 按 mtime 缓存 — 验证：161MB / 136 文件扫描不卡
- [x] 打开会话：`pi --mode rpc --session <file>` 子进程加载历史 — 验证：快照返回 2 条消息
- [x] SSE 流式对话：转发 text/thinking/tool 事件，`agent_settled` 收尾 — 验证：端到端收到「好的」
- [x] 图片输入：`prompt.images` 传输 + 历史图片渲染 — 验证：图片块回读进 snapshot
- [x] 子进程生命周期：引用计数 + 空闲 15 分钟回收 + SIGINT 优雅退出 — 验证：进程随服务退出
- [x] 安全：只绑 127.0.0.1、会话路径与静态文件均做包含校验 — 验证：`/etc/passwd` 路径返回 400，静态穿越返回 404
- [x] 启动后自动打开浏览器 — 验证：`open` 被调用

## M1.1 修复回归（已完成）

- [x] 修复：输入框被挤出视口、历史区无法滚动（grid 行高改为 `minmax(0,1fr)`，pane/messages 补 `min-height:0`）— 验证：DOM 断言 `composer.bottom<=innerHeight`、`messages.scrollHeight>clientHeight`
- [x] 修复：横向溢出，消息气泡与工具卡片戳出右边界（flex 项补 `min-width:0`，`pre` 限 `max-width:100%`）— 验证：`scrollWidth === innerWidth`
- [x] 修复：标题栏文字溢出重叠 — 验证：截图
- [x] 改进：思考块、工具调用与工具结果默认折叠为 `<details>` — 验证：DOM 断言 153 个 details
- [x] 新增回归工具 `scripts/screenshot.ts`（CDP 截图 + `--eval` 断言，零依赖）— 验证：本轮所有页面检查均由此完成
- [x] UI 端到端：输入 → 发送 → 流式回复 → 输入框清空 → 状态回到 idle — 验证：回「收到了」，耗时 1.0s
- [x] UI 端到端：附加图片 → 发送 → 气泡内渲染 → 模型识别 — 验证：模型描述出图片内容（「测试图片」紫粉渐变）

## M1.2 Markdown 渲染（已完成）

- [x] 接入 `marked` + `DOMPurify`，vendor 到 `src/web/vendor/`，保持无构建步骤、运行时零依赖 — 验证：`npm run vendor` 输出 44.9KB + 82.4KB，且脚本校验被 vendor 的 ESM 无外部 import
- [x] 支持 GFM：标题 / 有序与无序列表 / 嵌套列表 / 表格 / 引用 / 围栏代码块 / 行内代码 / 删除线 / 分隔线 / 链接 — 验证：专用回归会话下 DOM 断言（h1=1、h2=1、table=1、tr=3、pre code=1、blockquote=1、ul ul li=1、hr=1）
- [x] XSS 消毒：`<script>` 移除、`onerror` 剥离 — 验证：恶意 payload 下 `window.__pwned === undefined`，`#messages script` = 0，带 `onerror` 的 img = 0
- [x] 外链新窗口 + `rel="noopener noreferrer"` — 验证：断言 `target="_blank"`、`rel="noopener noreferrer"`
- [x] 工具输出保持纯文本，不被 Markdown 重新解释（命令输出里的 `#`/`**` 不能被当成标题/加粗）— 验证：`.tool-result .md` = 0，且 `.tool-result .plain` 内容逐字保留
- [x] 流式结束后按 Markdown 重渲染（流式过程中仍为纯文本，保证性能）— 验证：真实会话 `.md` 块 35 个、表格 3、代码块 11

## M1.3 新建会话（已完成）

- [x] 文件夹列表用 `~` 表示家目录：家目录路径之前被渲染成 `Users/<you>`，看起来像不存在 — 验证：DOM 断言该条目 label = `~`
- [x] 会话面板 `＋`：在当前选中的文件夹新建会话 — 验证：UI 点按后出现待建条目
- [x] 文件夹面板 `＋`：输入任意绝对路径新建（新文件夹也会出现在列表，即使尚未落盘）— 验证：`…/tmp/pi-ui-new` 出现在文件夹列表
- [x] 待建会话：文件未落盘时也能打开流、发消息 — 验证：快照 messages=0、无错误、状态 idle
- [x] 发第一条消息后自动转为正式会话：标题取首条消息、`新` 徽章消失 — 验证：标题变为「只回复两个字：好的」，pending=false
- [x] 修复：spawn 的 pi 未传 `--session-dir`，新会话可能落在我们索引不到的目录（设置 `PI_SHELL_SESSIONS_DIR` 时必现）— 验证：隔离会话目录下新会话正确落盘
- [x] 修复：传 `--session-dir` 时 pi 把会话平铺在该目录根，而索引只扫子目录，导致新会话落盘后反而消失 — 验证：新增单元测试 + 端到端回归
- [x] 单元测试 7/7（新增「平铺布局也能被索引」）

> 上面两条在 M1.10 被回退：默认不再给子进程传 `--session-dir`。平铺布局仍然支持，但只在 `PI_SHELL_SESSIONS_DIR` 这种 web 专属覆盖时才会出现。

## M1.4 工具调用聚合（已完成）

- [x] 连续的工具调用聚合成一个折叠块，不再每条一个气泡 — 验证：真实会话 305 条条目 → 40 个折叠块，消息区滚动高度 85859 → 13186（-85%）
- [x] 只有思考、没有正文的助手回合不再单独占一个气泡，思考并入活动块 — 验证：空气泡 57 → 0
- [x] 一次调用的 start/end（实时）与 toolCall/toolResult（历史）合并为同一条，计数不再翻倍 — 验证：条目 362 → 210，孤立结果 0，摘要显示「bash ×2」而非 ×4
- [x] 实时运行中活动块保持展开（能看到进展），助手重新说话或 `agent_settled` 后自动折叠 — 验证：流式中 `.tool-group[open]` > 0，settle 后 = 0
- [x] 块摘要按工具名计数（最多列 6 种）— 验证：「思考 + 12 次工具调用 · read ×4、bash ×8」

## M1.5 常驻与开机自启（已完成）

- [x] LaunchAgent 安装/卸载/状态/重启四个子命令，写 plist 并 bootstrap — 验证：`npm run service:install` 成功，plist 落在 `~/Library/LaunchAgents/dev.pi-web-shell.plist`
- [x] 登录自启 + 崩溃自愈 — 验证：`kill -9` 后 launchd 自动拉起新 pid（90004 → 90450），`state = running`
- [x] 不写死 Node 版本：启动脚本 source `nvm.sh` + 用 `alias/default` 兜底 — 验证：日志里解析到 `~/.nvm/versions/node/v22.22.3/bin/node`
- [x] launchd 精简 PATH 下仍能找到并 spawn `pi` — 验证：服务进程下打开会话流，快照正常返回 34 条消息
- [x] 服务模式关闭浏览器自动弹出 — 验证：plist 中 `PI_SHELL_OPEN_BROWSER=0`
- [x] 端口被占用时给可操作提示（提示改用 `service:restart`）— 验证：`npm start` 输出提示并非堆栈
- [x] 评估 Docker 并记录为何不用 — 见 README「为什么没做成 Docker」

## M1.6 可读性与观测（已完成）

- [x] 代码块语法高亮：vendor Prism 核心 + 13 种语言（bash/java/python/ts/json/yaml/sql/markdown/go/rust/docker/properties/diff），保持无构建步骤 — 验证：JSON 的 key/字符串/数字、bash 的命令/参数/注释均分色
- [x] 未标注或未知语言优雅降级为纯文本，**不猜语言**（错误高亮比不高亮更差）— 验证：本会话 18 个代码块中 10 个无语言标记，仅做转义
- [x] 代码块复制按钮 — 验证：点击后写回剪贴板的内容 = 代码原文，按钮变「已复制」
- [x] 整条回复复制按钮（只取可见正文，不含思考与工具输出）— 验证：剪贴板内容为正文
- [x] 剪贴板降级方案（非 secure context 时走 textarea + execCommand）
- [x] 顶部统计条：上下文进度条 + 已用/窗口 + 累计 input/output + 缓存 + 花费 + 轮数/工具数 — 验证：5 个 stat 全部渲染
- [x] 实时 token 速度（流式中每 500ms 刷新，结束后保留最后一次）— 验证：≈14.2 → ≈96.9 tok/s，settle 后保留 110.8 tok/s；估算值与实际 `↓229` 相符
- [x] 服务端在 snapshot 和 `agent_settled` 时推送 `get_session_stats` — 验证：快照携带 stats（tokens/cost/contextUsage）
- [x] 修复：静态资源加 `Cache-Control: no-store`。之前浏览器会拿旧 `app.js`，改完刷新也看不到新功能 — 验证：响应头为 `no-store, must-revalidate`
- [x] 速度位常驻（空闲显示暗色 `⚡ —`），让人知道该看哪里 — 验证：静默会话下仍渲染该槽位
- [x] 暴露 `window.piShellDebug` 供自动化 UI 断言使用

## M1.7 排版对齐 CLI（已完成）

问题：同一段回复，Web 比 CLI 明显“挤”。第一版矫拱过正（字大、间距夸张），第二版回调到下面这组值。

- [x] 正文字号定为 **14px**，行高 **1.68**（23.5px）
- [x] 段间距 **9px**；列表项间距 **4px**；列表左缩 26px
- [x] 标题上/下边距：h1 20/10，h2 19/9，h3 17/8，h4 15/7；标题用暖色 `--heading: #e3c08d` 区分层级（贴近 CLI 的标题配色）
- [x] 行内代码去掉边框，只留底色 — 一行里好几个 `code` 的描边是“碎”的主要来源
- [x] 表格边框加粗到 `--border-strong: #414c5c`，外框圆角 + 表头底色 `#232b36` — 之前 `#262d38` 太淡
- [x] 表格首列 `nowrap`，标签类列不再被折断（“整条回复复制”不再变两行）
- [x] 气泡内边距 12/15；代码块外边距 10px，内边距 10/12px；hr 外边距 18px
- [x] 思考块行高 1.65，与正文统一

验证：同一条回复（「好 👍 那我把这轮的东西…」）在 Web 重新渲染，与 CLI 截图并排对比；计算样式实测 `font-size 14px`、`line-height 23.52px`、`th border rgb(65,76,92)`、首列各行高度均 36.5px（不折行）

## M1.8 配色向 CLI 对齐（已完成）

问题：CLI 里英文（其实是**行内代码**）是紫色的，web 是白的。之前靠猜，这次直接读源码。

- [x] 定位 pi 的 markdown 主题键：`dist/modes/interactive/theme/theme.js` 的 `getMarkdownTheme()`（`mdHeading/mdLink/mdCode/mdCodeBlock/mdCodeBlockBorder/mdQuote/mdHr/mdListBullet` + `syntax*`）
- [x] 真值来源：`dist/modes/interactive/theme/dark.json` 用的是 `okhsl()`，不手算色彩空间 — 改用 `pi` 自带的 `export_html` RPC，把它解析好的 `:root` hex 直接读出来
- [x] 复刻：行内代码 **紫** `#a798d7`、列表圆点紫、标题 **琥珀** `#cd9a22`、链接 蓝 `#69add0`、表格边框 `#9da5a9`、未标记语言的代码块 **绿** `#68b78d`（之前是白的）
- [x] Prism token 重映射到 pi 的 `syntax*` 语义色 — 关键差异：**字符串是橙色** `#de8d5a`（之前错用了绿色）、关键字蓝、函数琥珀、类型紫、变量青
- [x] 新增 `npm run theme:check`：导出会话读 `:root` 变量，与 CSS 逐项比对 — 验证：故意把 `--md-code` 改成红色后能报出该行 drift，还原后 18/18 匹配

验证：计算样式实测 `h2 = rgb(205,154,34)`、`code = rgb(167,152,215)`、`li::marker = rgb(167,152,215)`、`th border = rgb(157,165,169)`、`a = rgb(105,173,208)`

## M1.9 体积与加载（已完成）

问题：切会话时“连接中”闪一下；一个会话 27.9MB。

- [x] 定位体积元凶：28.4MB 会话里 **26.56MB 是图片 base64** — 21 张来自 `read` 工具（22.0MB）、4 张用户粘贴（4.6MB），其余文本一共才 1.8MB
- [x] 图片改为内容寻址：快照只发 sha1，字节按需从 `/api/image/<sha1>` 取，响应带 `immutable` 缓存 — 反覆切会话不重下
- [x] **按 pi 的规则区分来源**：用户图内联（懒加载）；工具图折叠成 `🖼 [image/png 2000×1250] · 855 KB` 占位符，点击才请求 — 依据是 `dist/core/export-html/tool-renderer.js` 里的 `showImages: false`
- [x] 服务端解析图片尺寸（PNG/JPEG/GIF 文件头，零依赖），让浏览器预留空间、占位符能显示尺寸
- [x] SSE 加 gzip（逐帧 flush），文本再压 ~74%
- [x] 去掉“连接中…”闪字，改为 **延迟 250ms 才出骨架屏**（加载快就完全看不到）
- [x] 截图工具新增页面异常捕获 — 就是它抓出了我引入的 `SyntaxError: Identifier 'renderToolResultContent' has already been declared`（`new Function` 语法检查抛不出来，因为不是严格模式）

实测（本会话，705 条消息）：

| | 首帧体积 | 耗时 |
|---|---|---|
| 原始 | 27.9 MB | 1.56 s |
| 只把图片换成 hash | 1.84 MB | 28 ms |
| 再加 gzip | **494 KB** | ~30 ms |

浏览器实际传输降 **98.2%**。

## M1.10 会话与 CLI 互通（已完成）

问题：web 里创建的会话在 `pi` 的 `/resume` 里看不到。

- [x] 定位：服务端每个子进程都传 `--session-dir ~/.pi/agent/sessions`，pi 因此把会话平铺在
  `<sessions>/<file>.jsonl`，而 `/resume` 只扫 `<sessions>/--<encoded-cwd>--/`；`/resume` 的
  「全部会话」页签也只遍历子目录，同样漏掉平铺文件 — 验证：读 pi 源码
  `core/session-manager.ts`（`SessionManager.list` / `listAll`）确认两处过滤
- [x] 默认不再传 `--session-dir`，交给 pi 按 cwd 分组落盘 — 验证：`test/config.test.ts` 断言
  `sessionDirArg === null`，且端到端新建会话落到 `<sessions>/--<cwd>--/`
- [x] 仅 `PI_SHELL_SESSIONS_DIR`（pi 不认识的 web 专属开关）仍需 `--session-dir` 钉住目录；
  与 pi 自己的默认目录相同时也不传 — 验证：单测覆盖三种 env 组合
- [x] 修复历史遗留：一条 web 建出来的会话文件平铺在 sessions 根目录，移回
  `--Users-<you>-aiwork--/` 后 `/resume` 可见 — 验证：`SessionManager.list('~/aiwork')` 命中

## M2.1 模型 / 思考等级切换（已完成）

问题：M2 里列着「模型切换 UI」「思考等级切换」，但 `POST /api/model` 一直没有前端入口，
模型和思考等级只能开新会话时改，或在 TUI 里改。

- [x] 底部统计条右侧放两个原生下拉：模型 + 思考等级（等级直接显示 pi 的英文枚举，不做中文翻译）
  — 验证：本机解析出 2 个模型、4 个等级（off/low/high/max）
- [x] 新增 `GET /api/models?path=`：`get_available_models` + `get_available_thinking_levels` + `get_state`，返回精简后的 `{ models, model, thinkingLevels, thinkingLevel }`
  （完整 Model 对象带价格/限额，picker 用不到）— 验证：响应仅含 provider/id/name
- [x] 新增 `POST /api/thinking { path, level }` → `set_thinking_level` — 验证：改成 low 后重新查询返回 `thinking: low`
- [x] 切换模型后自动重拉等级列表：模型不支持原等级时由 pi 落到它支持的档位 — 验证：flash 的 low 切到 v4-pro 后自动落回 high，等级列表由 4 个变 3 个（off/high/max）
- [x] `thinking_level_changed` 事件回写下拉与标题栏，标题栏与 picker 不会互相矛盾 — 验证：两处同时更新
- [x] 统计条拆成「数据区 `#stats-items` + 操作区 `#stats-actions`」：`renderStats()` 每 500ms 重写数据区，
  不会再冲掉 picker — 验证：流式过程中下拉仍在、可操作
- [x] 降级：只有 1 个模型或 1 个等级时隐藏对应下拉；没有会话（进程不在线）时整条隐藏 — 验证：404 时控件不出现
- [x] 错误可见：切到不存在的模型返回 `Model not found: deepseek/nope`，前端 `addNotice` 提示 — 验证：curl 与页面均可见

验证方式：临时在 `/tmp/pi-web-shell-smoke` 建一个用完即删的会话，走完 `/api/sessions/new` →
`/api/stream` → `/api/models` → `POST /api/thinking` → `POST /api/model`，确认后删掉会话文件，
没往任何真实会话里写脏数据。

## M2.2 截图工具硬化（已完成）

问题：用 `npm run shot ... --eval` 点了一下「新会话」，headless Chrome 弹出原生
`prompt`/`alert`，没人关它就卡住渲染进程，脚本挂了十几分钟不返回。

- [x] 监听 `Page.javascriptDialogOpening` 并自动 `handleJavaScriptDialog`（accept）— 验证：
  `--eval "alert('x')"` 能正常跑完并截图，不再挂死
- [x] 加 90s 硬超时兜底，超时就 kill Chrome 并以非 0 退出，不再无限等 — 验证：超时分支会被触发

## M2.3 会话重命名 / 删除（已完成）

问题：列表标题直接显示首条消息原文（含 Markdown 记号），无法改名，也无法删掉废弃会话。

- [x] 重命名走 pi 官方 RPC `set_session_name`：追加 `session_info` 行 + 广播 `session_info_changed`（前端已有监听，标题栏同步更新）— 验证：隔离目录下改名后 `tail -1` 为 `{"type":"session_info",...,"name":"M2-改名二号"}`，列表/标题栏均更新
- [x] 待建（pending，文件未落盘）会话也能改名：名字存在子进程内存里，首条消息触发全量 flush 时一并落盘 — 验证：pending 改名 → 列表立即显示（`collectSessions` 现向 `get_state` 读 sessionName）→ 发消息后文件里 `session_info` 带原名
- [x] 删除照抄 pi TUI 策略：优先 `trash` 命令进废纸篓（可找回），无 trash 则 unlink 永久删除；删除前先 dispose 活跃子进程 — 验证：`method:"trash"`、`method:"gone"`（纯 pending）、文件消失、列表归零
- [x] 路径安全：只允许删 `sessionsDir` 内的 `.jsonl` — 验证：`/etc/passwd` → 400，目录内 `.txt` → 400
- [x] 边界：空名 → 400；未打开的会话改名 → 404 — 验证：curl 断言
- [x] UI：会话条目悬停显示 ✎/🗑 按钮，悬停时标题右缩省略号（修掉了按钮盖字的回归）— 验证：CDP 断言按钮 2 个、`nameRight-padding < actsLeft`、`scrollWidth > clientWidth`（截断生效）
- [x] UI 端到端：✎ 改名（列表+标题栏更新）、🗑 删除（条目消失、打开中的会话关闭回到占位态）— 验证：`npm run shot --eval`，`listTitle:"M2-UI改名新"`、`itemsLeft:0`
- [x] 目录级批量删除：左栏条目悬停 🗑，删除该目录下**全部会话**（pending+落盘都清），只动会话文件不碰目录本身与目录内其他文件 — 验证：隔离环境 3 会话（2 trash + 1 gone）全清、`notes.txt` SURVIVED、项目目录 SURVIVED、文件夹条目自动消失；空 cwd→400、无会话→404；UI 端到端 `folderLeft:0, chatTitle:"选择一个会话"`

## M2.4 abort 端到端回归（已完成）

问题：「停止」按钮已实现但从未压测过，中断路径容易埋雷（挂死、状态卡 live、会话损坏）。

- [x] API 压测：长文生成中（文件 16s 内 11413→19717 持续增长）abort → 6s 内文件完全冻结（真停）；部分输出已持久化（2390 字）— 验证：`stat -f%z` 三次采样不变
- [x] abort 后会话可用：追加提问正常回复「好的」，会话文件未损坏 — 验证：读回最后助手消息
- [x] UI 端到端：composer 发长任务 → `status live`、停止按钮激活 → 点「停止」→ `status idle` 按钮恢复禁用 — 验证：CDP 断言 `liveSeen:true, idleAfterAbort:true`
- [x] abort 响应耗时 0.03s（RPC 立即返回，等待由事件流收尾）— 验证：计时

## M2 下一步

- [x] Web 会话注入端专属规则：spawn 时统一带 `--append-system-prompt`（仅 web 子进程携带，CLI 不受影响），告知「本地图片用 ![描述](/绝对/路径.png) 内联」；同时把上一条补在 image-gen SKILL.md 里的展示规则撤回，单一事实源随代码走 — 验证：隔离环境新会话问「展示 dog.png」，模型主动回 `![dog.png](/绝对路径)`；会话文件 system 消息含注入文本（resume 会重放）；浏览器渲染为 /api/local-image 且真实解码；typecheck + 单测 31/31
- [x] pi 发图：模型不能附图，改为正文 Markdown 引用本地图（`![alt](/abs/path.png)`、`file://`、`~/` 三种写法），新增 `GET /api/local-image` 代理——魔数嗅探只放行 PNG/JPEG/GIF/WEBP（不是任意文件读接口），ETag+mtime 缓存 — 验证：单测 31/31（sniff/扩展名伪装/相对路径 400/缺失 404）；curl 端到端（200+字节一致、txt 与 /etc/passwd 均 415、If-None-Match 304、URL 编码路径）；CDP 断言三种写法均重写为 `/api/local-image?path=`、外链不动、`md-img-local` 穿过 DOMPurify、图片在页面内真实解码（naturalWidth=1）
- [x] 分支树可视化（`get_tree` / `fork` / `clone`）— 已交付 M2.15（只读树+分叉+克隆+活动分支高亮；label 编辑与节点预览为二期）
- [x] 把 UI 断言固定成 `npm run ui:test`（当初靠 `npm run shot ... --eval` 手跑）— 已固化：`scripts/ui-test.ts` 一条命令跑 typecheck + 单测 + 全部 `ui-test-*.ts`（共享一个隔离服务端；脚本约定：首参为 base URL 则不自举）— 验证：`npm run ui:test` 全绿
- [x] 多会话同屏 / 标签页 — 试过监控栏方案（M2.17），实测无价值已删除（见 M2.18）；真要做须一步到位上完整分屏（每窗格独立输入框+流），暂缓
- [x] 工具图点击放大（现在最大 320px）— 已随 M2.15 lightbox 交付（#messages 任意图片点击全尺寸查看）
- [ ] Linux / Windows 的等价开机自启（systemd user unit / 计划任务）
- [ ] 可选的 Docker 部署（供另一台机器使用）
- [ ] 窄屏自适应布局（统计条 + 两个下拉在窄屏下会换行，未调）

## M2.5 整体代码 review 整改（2026-10-03）

全量走读 src/ + scripts/ 后的问题清单（typecheck 与单测 13/13 当时为绿）。

P1 — 真实缺陷，建议尽快修（2026-10-03 已全部修复并提交）：

- [x] SSE 断连竞态泄漏子进程：`httpServer.ts` 的 `res.on("close", finish)` 注册晚于 `registry.acquire` 的 await；浏览器在 pi 冷启动 1-3s 窗口内刷新/切换会话时 refs 永不释放，子进程只能靠 15 分钟 idle 兜底回收 — 修法：提前置 closed 标志，acquire 返回后补判 finish() — 验证：隔离环境 PI_SHELL_IDLE_TIMEOUT_MS=3000，冷启动窗口 300ms 断开流，t+3000ms pi 子进程数 0（修复前 refs 泄漏进程永挂）
- [x] rename 跨会话竞态：`app.js` 对未打开会话先 `openSession()` 但 EventSource 建连即返回，pi 冷启动期间 `registry.get` 未命中 → 404 — 修法（服务端）：handleRename 未命中时 fallback `acquire`（与流同去重），rename 完 release — 验证：服务冷启动后直接 rename 未打开会话返回 `{"ok":true}`，且 fallback 的 ref 正确归还（idle 3s 后子进程回收）
- [x] 符号链接路径双开会话：registry 键与校验用 `resolve()`（不展开 symlink），sessionsDir 处于符号链接下时同一路径注册两个子进程写同一文件 — 修法：新增 `paths.ts#normalizeSessionKey`（realpath 至最深存在祖先，pending 会话键落盘前后一致），registry 全部键与 httpServer 三个入口校验统一归一 — 验证：隔离 sessionsDir 走 symlink，同一文件经 link/real 两路径各开流，均收到 snapshot 且服务端只有 1 个子进程；新增 `test/paths.test.ts` 5 例（symlink 解析/pending 一致性/幂等），单测 18/18

P2 — 健壮性（2026-10-03 全部修复，含一项新挖出来的真 bug）：

- [x] `piSession.ts` stdin.write 无 error 监听：**子进程把自己的 stdin 关掉、而我们的写端还「可写」时**，写入会抛**未处理**的 `write EPIPE` 事件，整个服务进程直接死（launchd 会拉起，但所有会话一起断线）— 修法：`child.stdin.on("error", …)` 记一行日志兜底。请求本身不会丢：`exit` 处理器会把 pending 全部 reject
  验证：新增 `test/piSession.test.ts`，用「关掉 fd 0 但还活着」的 sh 子进程复现（要把 64KB 管道缓冲写满，内核才报 EPIPE）。断言跑在**子进程**里——要验的是「进程别死」，所以失败必须是退出码而不是把测试进程带崩：**去掉监听后 fixture 以 `node:events:497 Unhandled 'error' event: write EPIPE` 退出 1**，加上后 `survived` / exit 0
- [x] `/api/stream` 的 EventSource 无限自动重连：服务端 `finish()` 关流后浏览器会一直重连，**每次重连都让服务端 acquire 一次 → 拉起一个没人看的 pi 子进程** — 修法：接管重连（`STREAM_MAX_RETRIES=3`，0.5s/1s/2s 退避），用尽后 `close()` 并给一条可操作的提示（「在左侧点一下这个会话即可重连」）
  验证：杀服务端进程 → 页面重试 3 次后 `streamEnded=true`、`state.stream=null`、恰好一条 `.msg.error`、状态 idle；杀单个 pi 子进程 → **自愈**（新流 readyState=1、服务端换上新子进程、快照重绘把临时提示冲掉）
- [x] 前端 `api.abort()` 不检查响应：停止失败时用户无感知（后端 RPC 超时的话按钮已灰、会话还在跑）— 修法：检查 `res.ok` 抛错，调用处用 `chat.abortFailed` 提示

P2.1 — 顺手挖出来的真 bug（本轮才发现，比上面三条都严重）：

- [x] **pi 子进程崩溃后，那个会话就永久废了**。子进程退出后 `SessionRegistry.live` 仍留着这条记录、`rpc` 指向死进程；此后重新打开会话 / 前端重连 / `curl /api/stream` 都会拿到这具「尸体」：写入被静默丢弃、`get_state` 永不返回，**流永远等不到 snapshot**（实测 `curl -m 5` 直接超时），而挂着的那条流还占着 ref，连 15 分钟空闲回收都救不回来
  修法四处：`ManagedSession.dead` 标记；`onExit` 标 dead 且在无人消费时**立即** dispose；`acquire()` 遇到 dead 先 dispose 再 spawn；`release()` 在最后一个消费者离开且 dead 时立即 dispose；外加 `PiRpcSession.stop()` 对已退出的子进程直接返回（否则要白等 5s 宽限期才对死 pid 发 SIGKILL）
  验证：杀子进程 → 服务端换新子进程、页面自愈不挂骨架屏；同一会话重新 `curl /api/stream` 能拿到快照（修复前 5s 超时）
- [x] 上条的评审补丁：`acquire()` 对 dead 条目 `await dispose` 后直接往下走，若等待期间别的消费者恰好
  spawn 了新子进程，落空后会把 `live` 覆盖成第二个写者（窗口经 `stop()` 的 exited 快路径已收窄到
  微任务级，但不变量不该依赖事件循环时序）；且 `release()` 按路径键查表，会命中替换者、错扣它的 refs —
  修法三处：dispose 后**循环重解析**；`release()` 改按 **managed 实例**归还；dispose 拆出按**同一性**校验的
  `retire()`，被替换的旧条目不能把新条目带下去
  验证：新增 `test/sessionRegistry.test.ts`（fake-pi 二进制，真子进程）：并发双 acquire 崩溃会话 →
  同一 ManagedSession、refs=2、总共只 spawn 过 2 个子进程；旧条目晚到的 release 后新条目 refs 不动、
  其子进程仍存活（改回路径键实现时第二条断言失败）

P3 — 代码质量 / 小问题（2026-10-03 全部清完）：

- [x] `httpServer.ts` `void config;` 是压 unused 告警的应付写法 — 直接删掉（`config` 在闭包里真用得到，不需要压）
- [x] `index.ts` 「Avoid leaking AWT/Java side-effects」注释与本项目无关（疑从其他项目带入）— 删除
- [x] `sessionIndex.ts` createdAt 缺头时间戳时回退 mtime，「创建时间」变成「修改时间」— 改用 `birthtime`（拿到 0 时才退回 mtime）
- [x] ~~`readSlices` 头尾切片可能截断 UTF-16 代理对~~ — **这条的前提是错的，所以代码没动，只补了注释**：实测被截断的 UTF-8 序列解码出来是 U+FFFD，**永远不会是「半个代理对」**；而且坏掉的那行必然是残行，`lines()` 里的 `JSON.parse` 会失败并丢弃它，到不了标题
- [x] ImageStore 单图超过上限时每次 snapshot 重新 put（重复 sha1、重复解析尺寸）— 修法：`evict(pin)` 永不淘汰**刚写入**的那条（等下一次插入再淘汰它），代价是内存上限最多被单图超出一次
- [x] `plan.ts` 进度条分母把「已知取舍」3 项也计入，`next` 还会指向一个没人能勾的项 — 修法：非待办分区（`NON_WORK_SECTIONS`）不参与进度与 next，列表里用 `•` 显示
- [x] `handleDeleteFolder` 串行删除大会话目录可能顶到 HTTP 超时 — 改 `Promise.all`，报告结构不变（只有顺序变）
  验证：临时 sessions 目录放 40 个会话 + PATH 里放一个 `sleep 0.2` 的假 `trash`（串行需要 8s）→ 实测 **0.76s**、`{"ok":true,"deleted":40}`、目录本身存活、40 个文件都进了「废纸篓」


结论记录：整体无明显过度设计（零依赖、无构建的约束贯彻得好），vendor 方案与错误处理风格符合本项目定位；上述 P1 三项为迭代修复优先级。

## M2.8 侧栏折叠重做（2026-10-03）

M2.7 的一刀切折叠难用：开关在右上角、离它控制的侧栏太远；且文件夹/会话两栏同时消失，没有中间态。

- [x] 开关搬家：按钮移到窗口左上角（文件夹栏头部，挨着「文件夹」标题），并随最左侧可见面板移动——仅会话态停在会话栏头部、全屏态停在 chat 头部最左，「在哪收起就在哪展开」 — 验证：CDP 断言三态下按钮 host 分别为 folders/sessions/chat-head，x=14/14/18
- [x] 面包屑退役：会话名已在标题栏、目录路径本就在 chat-meta 里，crumb 是冗余信息 — 验证：DOM 断言元素不存在，代码无引用残留
- [x] 三态循环：全展开（240/280）→ 仅会话（0/280）→ 全屏（0/0）→ 回全展开；tooltip 明示下一步动作 — 验证：断言三档列宽与 tooltip「收起文件夹栏/收起侧栏/展开侧栏（⌘B）」
- [x] ⌘B 语义改为「全屏 ↔ 上次展开态」直跳，不经过中间态；上次展开态持久化到 piShellSidebarLast — 验证：full→⌘B→fullscreen→⌘B→full；no-folders→⌘B→fullscreen→⌘B→no-folders
- [x] localStorage 迁移：旧值 "0"/"1" 映射 fullscreen/full，新键 piShellSidebar 存三态字符串 — 验证：写入 "0" 后 reload 进入 fullscreen 且按钮在 chat-head
- [x] 回归：ui-test-sidebar 重写为 25 断言全过；typecheck 干净；单测 31/31

## 已知取舍

- [ ] 会话标题最多读文件头 256KB；极端情况下首条用户消息超出则回退为占位标题
- [x] ~~未处理 RPC 的扩展 UI 对话框（`extension_ui_request`），目前忽略~~ — 已处理：`extensionUi.ts` + 前端 `handleExtensionUiRequest`（对话框/状态/widget，含快照重放），单测 `test/extensionUi.test.ts`
- [ ] 单用户单浏览器假设，未做多客户端并发写入保护

## M2.6 开源准备（2026-10-03）

- [x] LICENSE（MIT）+ package.json 去 `private`、加 `license: MIT` — 验证：文件落仓库
- [x] Host 头校验防 DNS rebinding：新增 `src/server/hostCheck.ts`（仅 loopback 绑定时启用，非 loopback 绑定视为显式放弃本地模型跳过），httpServer 入口统一拦截 — 验证：单测 7 例；隔离环境实测 `Host: evil.com` / `127.0.0.1.evil.com` → 403，正常 / `localhost` / `[::1]:port` → 200；常驻服务 `service:restart` 后 4711 正常 200
- [x] README 脱敏：网关描述泛化（去项目名与具体端口）、加非官方声明、加 MIT/LICENSE 与 vendored 许可证指引 — 验证：grep 全仓库网关项目名零命中；docs/PLAN 历史验证行中的真实家目录路径同步泛化
- [x] vendored 库许可证清单写进 `scripts/vendor.ts` 生成器（marked MIT / DOMPurify Apache-2.0 OR MPL-2.0 / Prism MIT，文件头声明保留） — 验证：`npm run vendor` 再生成 README 含清单，25/25 测试过

## M2.7 侧栏整体折叠（2026-10-03）

- [x] chat 头部新增折叠按钮（‹/»）+ 折叠态面包屑（文件夹/会话名，title 带全路径） — 验证：CDP 断言 11 项全过（`scripts/ui-test-sidebar.ts`）
- [x] 折叠实现：`#app.sidebar-collapsed` → `grid-template-columns: 0 0 1fr`（0.18s 过渡），pane 隐藏边框/事件；顺手合并 style.css 里重复定义的 `#app` 规则 — 验证：折叠后 folders/sessions 宽 0/0、chat 占满 1440 视口、SSE 流存活、无页面异常
- [x] 记忆：localStorage `piShellSidebar`（默认展开），reload 后保持折叠态 — 验证：断言 reload 后宽度仍为 0
- [x] 面包屑随 session_info_changed/rename 自动更新（走 renderSessions 公共路径） — 验证：代码路径覆盖 717/812/1275 三处标题变更点
- 回归：typecheck 干净；31/31（含新增本地图测试）；常驻服务 restart 后正常

## M2.8 Markdown 里的 mermaid 图表（2026-10-03）

- [x] ```mermaid 围栏渲染成图表：`marked` renderer 只产出占位块，`MutationObserver` + 串行队列在 DOM 里补 SVG — 验证 `scripts/ui-test-mermaid.ts` 17 项断言全过（flowchart 画出 3 个节点、SVG 在 DOM、围栏原文保留在 `.mermaid-source`）
- [x] 失败降级：语法错误显示「图表渲染失败：<首行>」并展开源码，不留空白框 — 验证：`pie title Bad` 与未闭合 fence 均进入 failed 态且 `.mermaid-source` 可见
- [x] 安全：产物绕过 DOMPurify，所以 `securityLevel: 'strict'` 不能改；标签里的 `<img onerror>` 不执行 — 验证：`window.__pwned === undefined`，`img[onerror]` = 0
- [x] 源码不能走 `data-*`：DOMPurify 会丢掉值里含注释终止符（`-->`）的属性，改用文本节点承载，复制按钮读同一份 — 验证：`data-x="a--&gt;b"` 经 sanitize 后属性消失，文本节点方案往返一致
- [x] 按需加载 3.4 MB 包：首个图表出现才插 `<script src="/vendor/mermaid.min.js">`；`npm run vendor` 与许可证清单同步 — 验证：无图表时 `typeof globalThis.mermaid === "undefined"`，注入后为 `object`
- [x] 与 Prism 共存：同一气泡里 mermaid 块 + json 代码块，后者仍有 `.token` 高亮；流式 `text_end` 重写气泡不重复渲染 — 验证：`.mermaid-block svg` = 1 且 `.code-block .token` > 0；连渲两次仍只有 1 个 `.mermaid-body`
- 回归：typecheck 干净；单测 31/31；`ui-test-sidebar` 26 项仍全过

## M2.9 输出速度口径修正（2026-10-03）

问题：M1.6 的速度是「从 `agent_start` 起算的整轮平均」，但分子在 provider 报出 usage 后就
换成单条消息的累计值 —— 一量两用拆分不开。后果是工具轮被工具耗时稀释，多轮时分子还会
被新消息的小值覆盖而断崖下跌。CLI 的 `~/.pi/agent/extensions/token-speed.ts` 是另一个
方向的偏差：计时从首个 `text_delta` 起，分子却含 thinking token，先思考后出字的轮次虚高数倍。

- [x] Web 口径改为按单条 assistant 消息：`message_start` 重置计数、首个 delta 启动时钟、文本/思考/工具参数三类 delta 都计入分子 — 验证：`scripts/ui-test-token-speed.ts` 15 项断言全过，首 token 前挂 2s 延迟时 `streamStart - t0` = 2045ms（时钟没被提前启动）
- [x] `message_end` 采用消息里权威的 `usage.output` 冻结终值（provider 只在收尾报 usage 时也能拿到真实值）— 验证：终值按 50 token 计且 `≈` 前缀消失
- [x] 工具参数也是产出 token：只有 `toolcall_delta` 的轮次同样能测到速度（旧实现此时分子为 0）— 验证：10 次 `toolcall_delta` 得 30 token
- [x] 多轮不再断崖：第二条消息重置后速率与第一条同量级 — 验证：25.4 → 26.3 tok/s
- [x] CLI 扩展同步修正：时钟改由任意 `*_delta`（含 `thinking_delta`）启动、估算同时统计 text/thinking/toolCall 内容、估算器换成与 Web 一致的 CJK 加权（1.4 / 4 字每 token）— 验证：esbuild 转译 + `node --check` 通过（该文件不在本仓库，无法进回归）
- 回归：把旧实现临时放回，速度断言立刻失败 3 项（证明断言有效），恢复后 15/15 过；typecheck 干净

## M2.10 设置页（2026-10-03）

问题：外壳的偏好和 pi 的配置都散在文件里，界面上没有任何入口；也没地方看跨会话花了多少。

范围：先做「只读、不碰 pi 子进程」的部分，可写/难做的先占位（不摆假控件）。

- [x] 设置页外壳：文件夹栏左下角固定入口（不随列表滚动）→ `#app[data-view="settings"]` 隐藏三个 pane，
  由 `#settings-view` 左菜单 + 右内容占满窗口，Esc / `‹` 返回 — 验证：CDP 断言 `dataset.view`、
  Esc 后回到 `chat`；`scrollTop=844` 时 `.pane-foot` 的 top 不变、`list.bottom === foot.top === 649`
- [x] 侧栏全屏态下设置菜单不能被一起隐藏（`.pane:not(#settings-nav)`）— 验证：`data-sidebar=fullscreen`
  下 `#settings-nav` width 240 / opacity 1 / pointer-events auto，而 `#folders` display none
- [x] token 统计：`src/server/usageStats.ts` 扫 session jsonl 里 assistant 消息的 `usage`，按天 / 模型 /
  项目 / 会话合计 input/output/cache/reasoning/花费 — 验证：212MB/153 文件冷扫 0.5s；单测 4 例
  （两种落盘布局、截断行忽略、缓存只重读变化的文件）
- [x] 技能 / MCP / 插件清单：`src/server/environment.ts` 扫 agent 目录 `skills/`（含 YAML 块标量
  `description: |`）、读 `mcp.json`、列出 `settings.json` 的资源数组 — 验证：单测 3 例；真实 agent 目录下
  列出 4 个技能与 0 个 MCP server
- [x] 只读但真实：模型配置 / agent 设置两页显示 pi 当前会读到的默认值与文件状态（不摆假表单）；
  语言/主题与所有写操作明写「计划中」 — 验证：截图 + DOM 断言
- [x] 每日热力图（GitHub 式日历）：一列一周、一格一天（周一起），四档蓝色分位深浅；
  未来日期不留色块，今天带描边 — 验证：真实数据 9 列 / 62 天，
  分档为 0:38、1:7、2:6、3:6、4:5（无单日翘尾把其余压成最浅）；月份标签只在月首列出现
- [x] 模型筛选：默认为「全部模型」，切换后卡片 + 热力图 + 按天/按项目/按会话都只看该模型 —
  验证：切到 `gptge/glm-5.3` 后总花费 $62.36→$26.10、着色格 28→1（另 4 格是图例）、表格 4→3
  （筛选时隐藏「按模型」全量表），而热力图列数仍为 9（横轴不跟着缩）
- [x] 热力图悬停卡片：不用原生 `title`（~1s 延迟 + 系统样式），改用 `#heat-tip` 固定定位卡片，
  内容为 `日期+周几 / 总 token / 输入·输出（含思考）/ 缓存读写 / 花费·调用次数`；空记录日显示「没有记录」，
  未来日期不挂数据；卡片贴上方、越界时自动翻到下方并横向夹紧，滚动/关闭设置页时隐藏 —
  验证：CDP 事件断言 `hidden=false` 且内容逐项匹配、`above=true`、左右均在视口内、
  `pointerout` 后隐藏、DOM 里 `title` 数量 0
- [x] 服务端带 per-model 切片（`models: { [provider/model]: { totals, byDay, byProject, bySession } }`），
  扫描时多记一层 day × model（不能用 `byDay × byModel` 相乘代替）— 验证：单测新增 1 例
  （一个文件两个模型两天，断言不串天）；真实数据 payload 98KB、冷扫 0.5s
- [x] `/api/settings/*` 加 `Cache-Control: no-store`（顺手给 `sendJson` 全量加上）— 验证：响应头
- 回归：typecheck 干净；单测 39/39（新增 8）

## M2.11 语言与主题（2026-10-03）

问题：设置页里「语言、主题」是占位。当时的顾虑是「要读 pi 的主题文件、要抽 100+ 条中文」。
结论：**外壳自己的偏好，跟 pi 解耦**，两边都不依赖外部。

- [x] 主题三档（跟随系统 / 深色 / 浅色）+ 语言两档（中文 / English），实时生效，存 localStorage —
  验证：CDP 断言 `data-theme` 切换、`document.documentElement.lang` 切换
- [x] 浅色配色：`--md-*` / `--syntax-*` 取 pi 的 light 主题解析值，界面色自己定；
  并**把原来写死在样式表各处的 20 处颜色收成角色变量**（`--tool-border`/`--thinking-text`/
  `--skeleton-*`/`--code-bg` …），否则第二套主题无从附着 — 验证：浅色下逐屏截图
  （对话/工具块/代码高亮/热力图/表格），`npm run theme:check` 现在两套主题各 18/18 匹配
- [x] `theme:check` 覆盖浅色块，且故意改错一个值能被抓出（`--md-code` → 报 drift 并指出两边的值）—
  验证：故意注入 `#ff0000` 后 ❌，还原后 ✅
- [x] 首屏不闪：index.html 内联脚本在样式表前算好 `data-theme` / `lang` — 验证：seed localStorage 后
  首次加载即为浅色（截图无深色瞬间）
- [x] i18n：`src/web/i18n.js` 字典 + `t()` 插值 + `data-i18n*` 静态标记，翻译 74 处 app.js 文案与
  24 处 HTML 标记 — 验证：English 下五个设置页 `missingKeys` 空、CJK 泄漏 0（除语言选择器
  里「中文」自身与用户数据）
- [x] 语言切换 reload 而非原地重译（正文气泡的文案是渲染时带上的）— 验证：切到 English 后页面、
  侧栏、统计条、设置页全为英文
- [x] 服务端不再返回中文脚注：`notes: string[]` → `noteIds: string[]`，措辞进客户端字典 —
  验证：单测断言 `noteIds: ["readonly","mcpNoConnect"]`；English 下脚注为英文
- [x] 顺手修真 bug：设置页快速切换菜单时，第二次进入的分页会永远停在「正在读取…」
  （`settingsLoading` 单标志把另一次请求挡掉了）→ 改成按 payload 键记 `pendingKey` / `failedKey`
  并递归补取 — 验证：连点 usage→resources→models，三页都渲染出内容
- 回归：typecheck 干净；单测 39/39；`ui-test-sidebar` / `ui-test-mermaid` / `ui-test-token-speed` 全过

## M2.12 发送滚动、设置页路由与一键回归（2026-10-04）

问题：发送后自己的气泡停在视口外，要等模型首个 delta 把它顺带滚进来——模型慢时用户以为没发出去，
只能手动上拖；设置页只切视图不压历史，浏览器返回键没有应用内条目可回退，一下就退出了整个 shell；
UI 断言有 5 个脚本但要逐个手跑。

- [x] 发送即滚动：`sendMessage` 在 `addMessage` 后立即 `scrollToEnd`，不再依赖首个 delta；用户附图在
  `addFiles` 时量出 intrinsic 尺寸随消息带上，`renderImage` 预留占位（data URL 解码后不再把滚动顶短）—
  验证：`ui-test-scroll` 12 断言（顶部/中途/带图发送、输入清空、无异常）；临时还原修复后 5 项 FAIL，
  确认测试真能抓到
- [x] 设置页路由：`openSettings` pushState `/settings`，popstate 双向同步视图；应用内 ‹/Esc 走
  `history.back()`；深链/刷新由服务端回落到 index.html + 启动时按 pathname 恢复视图；深链关闭用
  replaceState 原地回 `/`（这条没有的话返回键仍会退出应用）— 验证：`ui-test-settings-route` 11 断言；
  还原修复后 `history.back()` 实测把页面卸载（Inspected target navigated or closed），即原 bug 复现；
  curl：`/settings` 200、`/settings/` 200、`/nope` 仍 404（未知路径不掩盖）
- [x] ui:test 固化：`scripts/ui-test.ts` 一条命令 typecheck + 单测 + 全部 `ui-test-*.ts`（约定：首参为
  base URL 则用之，裸跑则自举隔离服务端）— 验证：`npm run ui:test` 全绿；顺手修两个新脚本的 harness
  bug（`BASE` 常量在 argv 赋值前捕获默认端口 4711，裸跑时打到了线上服务）
- [x] 账本订正：「已知取舍」里 extension_ui_request 一条已过时（extensionUi.ts 早已落地），勾掉
- 回归：typecheck 干净；单测 57/57；5 个 ui-test 全过

## M2.13 设置页写操作：settings.json 白名单编辑（2026-10-04）

问题：设置页的模型配置 / agent 设置两页只读，「计划中」列着改 settings.json 与生效机制。
做法：**补丁式写盘**——浏览器永不发整份 JSON，只发扁平 `{点分键: 值|null}`，键必须落在
服务端白名单里（17 个对 web 有意义的键；theme/tuiMode/fullscreen*/terminal.* 等 TUI 专属键
不进页面），每个值过类型与范围校验；null/空串 = 删键回退 pi 内置默认。

- [x] `settingsStore.ts`：白名单 + 校验 + 嵌套合并（`compaction.modelOverrides`、`retry.provider`
  这类兄弟键原样保留；theme/packages 等未知键不动）；写前备份 `settings.json.bak`；tmp+rename
  原子写；文件存在但解析失败时拒绝覆写 — 验证：单测 11 例（合并保留/备份演进/新建无备份/
  删键/空数组归一/未知键不动盘/类型范围/坏 JSON 拒写/无 tmp 残留），其中两例先抓出真 bug：
  enum 的空串没归一成 null、JSON.parse 异常被当「文件不存在」继续覆写
- [x] `POST /api/settings/save`：校验失败 400；成功后 `registry.disposeAll()` 回收全部
  暖子进程——pi 每个子进程只读一次配置，打开的流走 SSE 自愈路径重连，新子进程即读新配置 —
  验证：sessionRegistry 单测新增 1 例（两会话 disposeAll 后 list 空、两个 pid 实测退出）
- [x] environment 载荷新增 `editable`（白名单 spec + 当前值）；模型页三个默认值、agent 页
  14 个键变成真控件（布尔三态/枚举/数字/字符串/工具列表），「未设置」显式可选并标注 pi
  内置默认；保存后乐观更新 + 后台刷新，提示语存 state 不被重渲染抹掉 — 验证：
  ui-test-settings-edit 20 断言（种子渲染/改值保存/删默认 provider/超范围 400 且不动盘/
  盘上 JSON 逐键核对：未知键与嵌套兄弟键保留、.bak 为改前内容、无页面异常）
- [x] 隔离：ui-test 编排器给共享服务端挂临时 `PI_CODING_AGENT_DIR`，settings-edit 测试
  自带独立 agent 目录——测试永不读写真实 `~/.pi/agent`
- [x] i18n：新增 31 词条中英对齐（268/267+locale 名）；models/agent 菜单副标题摘掉「只读」；
  已完成的 plan 条目（models.plan.1 / agent.plan.1 / agent.plan.4）从字典与页面移除
- 回归：typecheck 干净；单测 69/69；`npm run ui:test` 6 个脚本全绿

## M2.14 设置页写操作二期：AGENTS.md 编辑 + MCP 启用禁用（2026-10-04）

一期只写了 settings.json；这期补上全局指令和 MCP 开关，写盘纪律不变：备份、原子替换、
拒写坏文件、写完 disposeAll 让子进程重读。

- [x] AGENTS.md 编辑器：agent 页新增「全局指令（AGENTS.md）」分节，textarea 直编；服务端
  `POST /api/settings/agents-md` 校验字符串与 1MB 上限，备份 `AGENTS.md.bak` 后原子写；
  超限/缺失在页面明说（超限不进编辑器） — 验证：单测 3 例（改写+备份/新建无备份/非字符串
  拒绝）；UI 断言种子渲染→编辑保存→磁盘逐字节核对（含 .bak 为改前内容）
- [x] MCP 启用/禁用：resources 页每个 server 加开关；`POST /api/settings/mcp` 按 pi 自己的
  写法——禁用写 `enabled: false`（保留条目不连接），启用删掉这个键（缺省即启用），
  同文件其他条目与字段原样保留，备份 mcp.json.bak；写完 disposeAll 重连 — 验证：单测
  3 例（禁用/启用删键/未知条目与缺文件拒绝）；UI 断言点禁用→磁盘 enabled:false、按钮翻
  转→点启用→磁盘键被删且 command 等字段原样
- [x] settingsStore 收敛出公共 `backupAndWrite`（备份+tmp+rename），三个写路径共用；
  顺手修了 UI 测试里 agentDir 种子写错文件的测试 bug
- [x] i18n 新增 11 词条中英对齐（279/278+locale 名）；CSS 补 textarea/开关样式
- 回归：typecheck 干净；单测 75/75；`npm run ui:test` 全绿（settings-edit 扩到 28 断言）

## M2.15 分支树面板 + 图片 lightbox（2026-10-04）

官方 next：会话是 append-only 的树，但 web 上既看不到分支也没法 fork/clone。
第一期做只读树 + 两个动作；label 编辑、节点跳转预览留给二期。

- [x] 服务端三端点：`GET /api/tree` 代理 get_tree 并重塑（treeView.ts：entry 瘦身为
  id/kind/preview(≤120字)/label，用 leafId+parentId 走出活动路径并打标）；`POST /api/fork`
  转发 fork(entryId)；`POST /api/clone` 转发 clone——clone 不回新文件路径，补一发 get_state
  拿 sessionFile，若子进程已切文件则 dispose 该会话防漂移 — 验证：treeView 单测 5 例
  （活动路径不按兄弟顺序、多 root、label/截断/非消息条目、leafId=null、垃圾输入）
- [x] 前端树面板：chat 头 🌳 按钮（随会话开关启停）→ 遮罩卡片；用户消息节点挂「从这里分叉」，
  活动分支左侧高亮线，label 渲染成胶囊；fork/clone 后关闭面板、重挂 SSE 流拿新快照、
  克隆后刷新会话列表；Esc/点遮罩关闭（Escape 顺序：对话框 > 遮罩 > 设置页）
- [x] 图片 lightbox（顺手项）：#messages 里任意图片点击改为应用内全尺寸查看（原来 md 本地图
  是开新标签页、工具图 320px 不可放大），Esc/点击关闭 — 验证：ui-test-tree 15 断言
  （渲染计数/用户节点 fork 按钮/高亮 4 节点/label 胶囊/fork 提交 entryId+面板关闭+提示/
  clone 一次+提示/Esc 与遮罩关闭/lightbox 开与关/无页面异常；接口在页面内 stub，
  服务端重塑由单测覆盖）
- [x] i18n 新增 12 词条中英对齐（293/292+locale 名）；CSS：overlay 面板/树节点/lightbox
- 回归：typecheck 干净；单测 80/80；`npm run ui:test` 7 个脚本全绿

## M2.16 分支树布局重做：主干平铺 + 折叠分支（2026-10-04）

M2.15 一版把每条消息渲染成一层，线性会话成了长楼梯（一轮=2 层缩进），没法看。
重做为「一行一轮、只有分支缩进」：

- [x] 布局规则：活动 root→leaf 链平铺成主干（顶格，每行=用户消息+其后回复合并，
  回复折叠为行下第二行）；每个岔路收成「⑂ 分支 · N 条 · 预览」胶囊默认折叠，
  点击展开后同规则递归（分支内无 active 标记，以首子链代替主干）；展开态存
  state.treeExpanded，重渲染不丢 — 验证：ui-test-tree 重写为 21 断言
  （主干 2 轮、旧分支折成 1 胶囊且标注 1 条、pi 回复折入行内、展开后 3 轮且
  分支内用户消息也有分叉按钮、label 胶囊、fork/clone/Esc/遮罩/lightbox 回归）
- [x] 服务端 reshape 不动（preview/label/active 契约不变），仅前端 renderTree 重写
- 回归：typecheck 干净；单测 80/80；`npm run ui:test` 8 个脚本全绿

## M2.17 多会话同屏 MVP：右侧监控栏（2026-10-04）

完整分屏（每窗格独立输入框+流+状态）需要把全局单会话 state 全部实例化，是史上最大重构。
先交付痛点本体：**盯着另一个会话跑**。MVP 为只读尾巴，将来直接进化成窗格。

- [x] 侧栏每个会话加 👁：开/停监控（同一会话再点即停，行内左侧高亮标出在盯谁）；右侧滑出
  只读栏——标题/路径/状态灯（连接中黄、运行中绿脉冲、空闲灰）+ 消息尾巴
- [x] 独立第二条 SSE：复用 /api/stream（registry 引用计数本来就支持多会话并存，盯着的
  会话保活子进程，停止后靠空闲回收）；重试策略与主流一致（3 次退避，用尽后留提示可手动重开）
- [x] 迷你渲染器：快照取末 40 条渲染成一行一条（你/pi/🔧 工具），流式 text_delta 原位
  累积进当前行（110 字预览），message_end 原位定稿；工具行可插在流式中而不丢流式行
  （按 class 查找而非依赖末元素——测试抓出的真 bug）；上行数上限 120；贴底自动滚动
- [x] 布局零重构：#chat:has(#watch-panel:not([hidden])) 让出右侧 348px（含过渡动画），
  输入框/统计条/消息区同步收窄；Esc 不关监控栏（非模态）
- 验证：ui-test-watch 21 断言（页内替换 EventSource 喂合成帧：开面板/独立流指向正确
  路径/快照尾巴/状态灯翻转/流式累积/工具行/message_end 定稿/重试用尽留提示/Esc 不误关/
  停止即断流）；npm run ui:test 9 个脚本全绿

## M2.17.1 修复：监控栏从首帧就显示、眼睛关不掉（2026-10-04）

用户实测抓到：监控栏从页面加载起就显示，点 👁 停止也藏不掉。根因与 overlay-panel
当年踩过的同一颗雷——`#watch-panel { display: flex }` 压过 UA 的 `[hidden] { display: none }`，
`hidden` 属性形同虚设；树面板/lightbox 当初各自打过补丁，监控栏漏了。

- [x] `#watch-panel[hidden] { display: none }` 守卫补上；窄屏（≤860px）监控栏改为
  全宽覆盖而非挤压对话列（用户 748px 截图里对话被挤到没法看）
- [x] 测试升级：watch/tree 两脚本改断言 **computed display**（属性断言抓不到这类 bug
  ——之前全绿的盲区），首帧不可见/打开渲染/停止归零三处都看真实样式
- 验证：watch 23 断言、tree 17 断言全过；npm run ui:test 全绿

## M2.18 删除监控栏（2026-10-04）

M2.17 的监控栏实测后删除。用户结论：展示的东西没有价值——
①分不清是哪个会话的内容（盯当前会话时等于照镜子，无提示）；②点不了、跳不到对应会话；
③一行 110 字的消息预览看不出它在干啥。根因是形态猜错了：「盯会话」要的不是对话残影，
而是可读的状态呈现（在干什么、进展到哪、何时完），那是另一个设计。

- [x] 彻底移除：HTML 面板、app.js 全部 watch 函数与 👁 按钮、CSS、i18n 18 词条、
  ui-test-watch.ts；服务端本就零改动（复用 /api/stream），无需回退
- 保留：computed-display 断言升级（watch/tree 测试里防「hidden 属性失效」的那套，
  已并入 tree 测试继续生效）；「多会话同屏」待办改为记录结论
- 回归：typecheck 干净；单测 80/80；npm run ui:test 8 个脚本全绿

## M2.19 文档对齐（2026-10-06）

问题：README / ARCHITECTURE 停在 M2.12 前后，M2.13–M2.16 的写操作、分支树、lightbox
一条没写进去；设置页自己的文案还留着两处已完成的「计划中」（agent 页的 AGENTS.md、
resources 页的「只读」脚注与「启用/禁用还没实现」）。

- [x] README 功能清单对齐：补会话改名/删除、分支树（fork/clone）、图片 lightbox、`/` 命令菜单
  与扩展 UI、模型与思考等级下拉；统计条从「顶部」改正为「底部」；设置页的「模型配置 / agent 设置」
  从「只读 + 计划中」改为真实写路径；resources 页的 MCP 标注为可启用/禁用 — 验证：逐条对照
  `src/web/index.html` 与 `app.js` 里的实际控件
- [x] ARCHITECTURE 对齐：`/api` 表从 13 行补到 26 行（补 rename / delete / delete-folder、
  tree / fork / clone、local-image、ui-response、commands 与三个 settings 写端点，并修正
  `/settings` 回落说明）；安全节补 Host 校验与 local-image 魔数嗅探；代码地图补 10 个 server 文件、
  `test/` 与全部 `ui-test-*.ts`；设置页一节重写为「清单 + 写路径」（白名单补丁、备份 + 原子写、
  坏 JSON 拒写、写完 `disposeAll()`，菜单表顺序改回与页面一致）；新增「分支树面板」「扩展 UI」
  两节 — 验证：表内每行都能在 `httpServer.ts` 找到对应 route，菜单表与 `index.html` 顺序一致
- [x] UI 文案修正：`agent.plan.2`（编辑 AGENTS.md）已实现，从计划列表与字典移除；
  `resources.lead`、`settings.note.readonly` 不再声称只读；`index.html` 里两处过时的兜底副标题
  （模型「只读」/ agent「只读 + 计划中」）同步 — 验证：中英字典 292/292 对齐、无 `agent.plan.2` 残留
- [x] 顺手修 `httpServer.ts` 里「Settings page. Both are read-only」的过时注释
- 回归：typecheck 干净；单测 80/80；`npm run ui:test` 8 个脚本全绿

## M2.20 切走的会话跑完了能提醒（2026-10-07）

问题：一个会话跑着，切去看别的；它跑完时只有侧栏绿点悄悄熄灭，人看不到。
结论：检测早就有了——`/api/events` 的 activity 通道本来就为「你切走的会话还在干活」
建的（M2.17 删监控栏时保留），缺的只是「提醒」这一层。

- [x] 后端 activity 帧加 `reason`（`started`/`settled`/`exited`/`retired`）：
  `setStreaming` 三处调用点分别标 settle、exit、retire——否则空闲回收也会被当成「跑完」
  弹通知（60s 内 user abort 也算 abort）。 — 验证：`sessionRegistry.test.ts` 新增 3 例
  （fake pi 发 `agent_start`/`agent_settled`；kill 子进程得 `exited`；运行中 `disposeAll` 得 `retired`）
- [x] 前端 `applyActivity(path, running, reason)`：只在「不是当前打开的会话 + settled/exited」时提醒；
  点过「停止」的路径先进 `abortedPaths` 抑制（abort 走的也是 settled，事件本身分不开），
  再开新轮或开会话时清掉；`showToast` 接受可点击回调，点 toast 直接跳会话
- [x] 标题未读角标：`unreadDone` + `applyDocumentTitle()` 单点写 `document.title`，
  与扩展 `setTitle` 叠加（两个来源不能各写各的）；打开会话即已读
- [x] 通知 toast 标 `toast-global`：`resetExtensionUi()` 只清扩展通知，不清跨会话通知 —
  否则点一条通知会连带把另一条未读通知也清掉（测试抓出）
- [x] i18n 新增 4 词条中英对齐（`chat.backgroundDone`/`backgroundFailed`/`ui.openSession` + 角标）
- 验证：`scripts/ui-test-notify.ts` 23 断言（started 不弹 / settled 弹且带会话名 / 角标 (1) /
  当前会话不弹 / retired 不弹 / exited 措辞不同 / abort 不弹 / 重跑清旧角标 / 点 toast 跳会话
  并清角标 / 扩展标题与角标叠加 / 无页面异常）；后端 3 例
- 回归：typecheck 干净；单测 95/95；`npm run ui:test` 9 个脚本全绿
