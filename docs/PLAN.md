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

- [x] 文件夹列表用 `~` 表示家目录：`/Users/you` 之前被渲染成 `Users/you`，看起来像不存在 — 验证：DOM 断言该条目 label = `~`
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
- [x] 不写死 Node 版本：启动脚本 source `nvm.sh` + 用 `alias/default` 兜底 — 验证：日志里解析到 `/Users/you/.nvm/versions/node/v22.22.3/bin/node`
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
  `--Users-you-aiwork--/` 后 `/resume` 可见 — 验证：`SessionManager.list('/Users/you/aiwork')` 命中

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

- [ ] 分支树可视化（`get_tree` / `fork` / `clone`）
- [ ] 把 UI 断言固定成 `npm run ui:test`（目前靠 `npm run shot ... --eval` 手跑）
- [ ] 多会话同屏 / 标签页
- [ ] 工具图点击放大（现在最大 320px）
- [ ] Linux / Windows 的等价开机自启（systemd user unit / 计划任务）
- [ ] 可选的 Docker 部署（供另一台机器使用）
- [ ] 窄屏自适应布局（统计条 + 两个下拉在窄屏下会换行，未调）

## M2.5 整体代码 review 整改（2026-10-03）

全量走读 src/ + scripts/ 后的问题清单（typecheck 与单测 13/13 当时为绿）。

P1 — 真实缺陷，建议尽快修（2026-10-03 已全部修复并提交）：

- [x] SSE 断连竞态泄漏子进程：`httpServer.ts` 的 `res.on("close", finish)` 注册晚于 `registry.acquire` 的 await；浏览器在 pi 冷启动 1-3s 窗口内刷新/切换会话时 refs 永不释放，子进程只能靠 15 分钟 idle 兜底回收 — 修法：提前置 closed 标志，acquire 返回后补判 finish() — 验证：隔离环境 PI_SHELL_IDLE_TIMEOUT_MS=3000，冷启动窗口 300ms 断开流，t+3000ms pi 子进程数 0（修复前 refs 泄漏进程永挂）
- [x] rename 跨会话竞态：`app.js` 对未打开会话先 `openSession()` 但 EventSource 建连即返回，pi 冷启动期间 `registry.get` 未命中 → 404 — 修法（服务端）：handleRename 未命中时 fallback `acquire`（与流同去重），rename 完 release — 验证：服务冷启动后直接 rename 未打开会话返回 `{"ok":true}`，且 fallback 的 ref 正确归还（idle 3s 后子进程回收）
- [x] 符号链接路径双开会话：registry 键与校验用 `resolve()`（不展开 symlink），sessionsDir 处于符号链接下时同一路径注册两个子进程写同一文件 — 修法：新增 `paths.ts#normalizeSessionKey`（realpath 至最深存在祖先，pending 会话键落盘前后一致），registry 全部键与 httpServer 三个入口校验统一归一 — 验证：隔离 sessionsDir 走 symlink，同一文件经 link/real 两路径各开流，均收到 snapshot 且服务端只有 1 个子进程；新增 `test/paths.test.ts` 5 例（symlink 解析/pending 一致性/幂等），单测 18/18

P2 — 健壮性：

- [ ] `piSession.ts:163` stdin.write 无 error 监听：子进程自行崩溃瞬间写入会抛未捕获 EPIPE 异常，整个服务崩（launchd 会拉起但所有会话断线）— 修法：`child.stdin.on("error", …)` 静默兜底一行
- [ ] EventSource 无限自动重连：服务端 finish() 关流后浏览器默认无限重连 `/api/stream`，会把刚回收的子进程重新拉活 — 修法：onerror 中 close 并提示手动重开，或限次重连
- [ ] 前端 `api.abort()` 不检查响应：停止失败时用户无感知（后端 60s RPC 超时也拿不到反馈）— 修法：检查 res.ok，失败给 notice

P3 — 代码质量 / 小问题（可攒着一起清）：

- [ ] `httpServer.ts:129` `void config;` 是压 unused 告警的应付写法，连带 `collectSessions` 内重复解构 — 应在上层解构一次
- [ ] `index.ts:33` 「Avoid leaking AWT/Java side-effects」注释与本项目无关（疑从其他项目带入），应删除
- [ ] `sessionIndex.ts:152` createdAt 缺头时间戳时回退 mtime，「创建时间」语义变成「修改时间」
- [ ] `readSlices` 头尾切片可能截断 UTF-16 代理对，占位符会污染标题最后一个字（极低概率）
- [ ] ImageStore 单图超过 256MB 上限时绕过缓存（每次 snapshot 重新 put）；由 pi 历史写入的 base64 理论可超，快照仍正确只是浪费
- [ ] `plan.ts` 总数把「已知取舍」3 项也计入（110），进度条分母含非待办项
- [ ] `handleDeleteFolder` 串行删除大会话目录时可能顶到 HTTP 超时，可改 `Promise.all` 并发（注意失败聚合语义不变）

结论记录：整体无明显过度设计（零依赖、无构建的约束贯彻得好），vendor 方案与错误处理风格符合本项目定位；上述 P1 三项为迭代修复优先级。

## 已知取舍

- [ ] 会话标题最多读文件头 256KB；极端情况下首条用户消息超出则回退为占位标题
- [ ] 未处理 RPC 的扩展 UI 对话框（`extension_ui_request`），目前忽略
- [ ] 单用户单浏览器假设，未做多客户端并发写入保护
