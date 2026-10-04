/**
 * Shell translations.
 *
 * Scope: this web shell's own chrome only. Text that comes from pi (tool
 * output, errors, the model's replies) or from your session files (titles,
 * file paths) is data, not interface, and is never translated.
 *
 * There is no build step and no dependency on an i18n library, so this is a
 * flat dictionary plus string interpolation. A missing key falls back to
 * `zh-CN` and, failing that, renders the key itself — loud on purpose, so a
 * forgotten translation shows up in a screenshot instead of going blank.
 */

export const LOCALES = [
  { id: "zh-CN", label: "中文" },
  { id: "en", label: "English" },
];

const DEFAULT_LOCALE = "zh-CN";

const MESSAGES = {
  "zh-CN": {
    /* ---------- API errors ---------- */
    "api.sessionsFailed": "加载会话失败: {status}",
    "api.promptFailed": "发送失败: {status}",
    "api.modelsFailed": "加载模型列表失败: {status}",
    "api.commandsFailed": "加载命令列表失败: {status}",
    "api.setModelFailed": "切换模型失败: {status}",
    "api.setThinkingFailed": "设置思考等级失败: {status}",
    "api.serverOutdated": "服务端还是旧版本，先跑一次 npm run service:restart",
    "api.usageFailed": "统计失败: {status}",
    "api.environmentFailed": "读取配置失败: {status}",
    "api.saveSettingsFailed": "保存设置失败: {status}",
    "api.newSessionFailed": "新建会话失败: {status}",
    "api.renameFailed": "重命名失败: {status}",
    "api.deleteFailed": "删除失败: {status}",

    /* ---------- shared ---------- */
    "common.copy": "复制",
    "common.copied": "已复制",
    "common.copyFailed": "复制失败",
    "common.copyCode": "复制代码",
    "common.copyDiagram": "复制图表源码",
    "common.copyMessage": "复制这条回复",
    "common.error": "错误：{message}",
    "common.retry": "重试",

    /* ---------- extension UI dialogs / toasts ---------- */
    "ui.cancel": "取消",
    "ui.deny": "否",
    "ui.confirm": "确认",
    "ui.ok": "确定",
    "ui.dismiss": "点击关闭",
    "ui.selectTitle": "请选择",
    "ui.confirmTitle": "请确认",
    "ui.inputTitle": "请输入",
    "ui.editorTitle": "编辑",

    /* ---------- slash-command menu ---------- */
    "command.source.extension": "扩展",
    "command.source.prompt": "模板",
    "command.source.skill": "技能",
    "command.source.other": "命令",

    /* ---------- markdown / mermaid ---------- */
    "mermaid.rendering": "渲染图表中…",
    "mermaid.notLoaded": "mermaid 未加载",
    "mermaid.failed": "图表渲染失败：{message}",

    /* ---------- transcript ---------- */
    "msg.thinking": "思考",
    "msg.you": "你",
    "msg.image": "图片",
    "msg.toolImage": "工具返回的图片",
    "msg.clickToLoad": "点击加载图片",
    "msg.toolFailed": "🔧 {name} · 出错",
    "msg.toolTool": "🔧 {name}",
    "msg.toolResult": "🔧 {name} 结果",
    "msg.errorSuffix": " · 出错",
    "msg.attachment": "附件",
    "msg.emptySession": "(空会话，开始对话吧)",
    "msg.disconnected": "连接已断开。在左侧点一下这个会话即可重连。",
    "group.thinking": "思考",
    "group.toolCalls": "{count} 次工具调用",
    "time.justNow": "刚刚",
    "time.minutes": "{count} 分钟前",
    "time.hours": "{count} 小时前",
    "time.days": "{count} 天前",

    /* ---------- sidebar ---------- */
    "sidebar.folders": "文件夹",
    "sidebar.sessions": "会话",
    "sidebar.collapseFolders": "收起文件夹栏（⌘B）",
    "sidebar.collapseAll": "收起侧栏（⌘B）",
    "sidebar.expand": "展开侧栏（⌘B）",
    "sidebar.newFolder": "在指定文件夹新建会话",
    "sidebar.refresh": "刷新",
    "sidebar.settings": "设置",
    "sidebar.newSession": "在此文件夹新建会话",
    "sidebar.noSessions": "还没有任何会话",
    "sidebar.pickFolder": "选择左侧文件夹",
    "sidebar.noSessionsInFolder": "该文件夹下没有会话",
    "sidebar.folderRunning": "{count} 个会话正在运行",
    "sidebar.folderSub": "{count} 个会话 · {time}",
    "sidebar.folderRunningSuffix": " · {count} 运行中",
    "sidebar.deleteFolder": "删除该目录下的所有会话（不碰目录本身）",
    "session.running": "运行中",
    "session.runningNow": "运行中…",
    "session.pending": "尚未发送第一条消息",
    "session.badgeNew": "新",
    "session.rename": "重命名",
    "session.delete": "删除会话",

    /* ---------- chat ---------- */
    "chat.selectSession": "选择一个会话",
    "chat.noSessions": "还没有会话",
    "chat.noSessionsHint": "点击左上角 ＋ 在 {home} 等目录新建会话",
    "chat.noSessionsNotice": "还没有任何会话。点左上角 ＋ 选个文件夹开始。",
    "chat.stop": "停止",
    "chat.dropHint": "松手即可添加图片",
    "chat.attach": "添加图片",
    "chat.inputPlaceholder": "输入消息…（Enter 发送，Shift+Enter 换行，可直接粘贴/拖拽图片）",
    "chat.send": "发送",
    "chat.sendFailed": "发送失败：{message}",
    "chat.abortFailed": "停止失败：{message}",
    "chat.switchModel": "切换模型",
    "chat.thinkingLevel": "调整思考等级",

    /* ---------- stats bar ---------- */
    "stats.contextTitle": "当前上下文占用 / 模型上下文窗口",
    "stats.context": "上下文 {used} / {window} · {percent}%",
    "stats.tokensTitle": "本次会话累计 token（输入 / 输出）",
    "stats.tokens": "↑ {input} ↓ {output}",
    "stats.cacheTitle": "命中缓存的输入 token",
    "stats.cache": "缓存 {read}",
    "stats.costTitle": "本次会话累计花费（美元）",
    "stats.turnsTitle": "助手回复轮数 / 工具调用次数",
    "stats.turns": "{turns} 轮 · {tools} 工具",
    "stats.speedTitle": "本条回复的解码速度（含思考 token；≈ 表示按字数估算）",
    "stats.speed": "⚡ {speed}",
    "stats.speedIdleTitle": "模型生成时这里显示本条回复的解码速度",
    "stats.speedIdle": "⚡ —",

    /* ---------- settings: navigation ---------- */
    "settings.title": "设置",
    "settings.back": "返回会话（Esc）",
    "settings.loading": "正在读取…",
    "settings.loadingSlow": "正在读取…（首次统计要扫一遍会话文件，可能要一秒）",
    "settings.loadFailed": "读取失败：{message}",
    "settings.noData": "没有数据。",
    "settings.note.readonly": "这里的值都是只读的：pi 在子进程启动时读一次配置，改文件不会影响已打开的会话。",
    "settings.note.mcpNoConnect": "MCP 只列出 mcp.json 里的配置，不建立连接；要看连接状态和工具列表，跑 pi mcp list。",
    "settings.planned": "计划中",
    "settings.plannedNote": "都还没实现，先记在这里：",
    "settings.editTitle": "编辑（写 settings.json）",
    "settings.editLead": "只改白名单内的键；选「未设置」/留空 = 删掉这个键，回退 pi 内置默认（占位符里标了默认值）。保存前自动备份为 settings.json.bak，保存后运行中的 pi 子进程会被回收重开。",
    "settings.unset": "（未设置）",
    "settings.on": "开",
    "settings.off": "关",
    "settings.save": "保存",
    "settings.saving": "保存中…",
    "settings.saved": "已保存（备份 {backup}）；运行中的 pi 子进程已回收，重连后自动按新配置重启",
    "settings.autoHint": "留空 = pi 自动选择",
    "settings.key.defaultProvider": "默认 provider",
    "settings.key.defaultModel": "默认模型",
    "settings.key.defaultThinkingLevel": "默认思考等级",
    "settings.key.defaultTools": "启动工具（支持 +name / -name）",
    "settings.key.hideThinkingBlock": "隐藏思考块",
    "settings.key.showCacheMissNotices": "缓存未命中提示",
    "settings.key.enableSkillCommands": "技能注册为 / 命令",
    "settings.key.markdown.mermaid": "Mermaid 渲染时机",
    "settings.key.compaction.enabled": "自动压缩（compaction）",
    "settings.key.compaction.reserveTokens": "压缩：为回复保留 token",
    "settings.key.compaction.keepRecentTokens": "压缩：保留近期 token",
    "settings.key.images.autoResize": "发送前缩放图片（≤2000px）",
    "settings.key.images.blockImages": "禁止向模型发图",
    "settings.key.retry.enabled": "失败自动重试",
    "settings.key.retry.maxRetries": "重试次数",
    "settings.key.retry.baseDelayMs": "重试基础延迟（ms）",
    "settings.key.retry.maxAgentDelayMs": "重试最大延迟（ms）",
    "settings.menu.usage": "token 统计",
    "settings.menu.usageSub": "全部会话的用量与花费",
    "settings.menu.resources": "技能 / MCP / 插件",
    "settings.menu.resourcesSub": "pi 当前会加载什么",
    "settings.menu.models": "模型配置",
    "settings.menu.modelsSub": "默认值可改（写 settings.json）",
    "settings.menu.appearance": "语言、主题",
    "settings.menu.appearanceSub": "外壳自己的偏好",
    "settings.menu.agent": "agent 设置",
    "settings.menu.agentSub": "部分可编辑，其余计划中",

    /* ---------- settings: token usage ---------- */
    "usage.title": "token 统计",
    "usage.lead": "全部 {files} 个会话文件里，{messages} 条 assistant 消息的 usage 累加。数字来自 pi 写入会话记录的原始值（含缓存与思考 token）。",
    "usage.model": "模型",
    "usage.allModels": "全部模型（{count}）",
    "usage.filterNeedsRestart": "筛选需要重启服务（npm run service:restart）",
    "usage.onlyModel": "只看 {model}",
    "usage.heatNote": "色块越亮 = 当天 token 越多",
    "usage.empty": "还没有任何 usage 记录。",
    "usage.card.cost": "总花费",
    "usage.card.costSub": "{count} 次模型调用",
    "usage.card.total": "总 token",
    "usage.card.totalSub": "输入 {input}",
    "usage.card.output": "输出",
    "usage.card.outputSub": "其中思考 {reasoning}",
    "usage.card.cacheRead": "缓存读取",
    "usage.card.cacheReadSub": "缓存写入 {cacheWrite}",
    "usage.heatmap": "每日热力图",
    "usage.byDay": "按天",
    "usage.byModel": "按模型",
    "usage.byProject": "按项目",
    "usage.bySession": "按会话（花费前 50）",
    "usage.heat.none": "没有带日期的记录。",
    "usage.heat.noRecord": "没有记录",
    "usage.heat.less": "少",
    "usage.heat.more": "多",
    "usage.heat.tipCalls": "{cost} · {calls} 次调用",
    "usage.heat.tipInput": "输入 {input} · 输出 {output}",
    "usage.heat.tipThinking": "（含思考 {reasoning}）",
    "usage.heat.tipCache": "缓存读 {cacheRead} · 写 {cacheWrite}",
    "usage.weekday.mon": "一",
    "usage.weekday.wed": "三",
    "usage.weekday.fri": "五",
    "usage.date.weekday": "{date} 周{weekday}",
    "col.date": "日期",
    "col.model": "模型",
    "col.project": "项目",
    "col.session": "会话",
    "col.calls": "调用",
    "col.input": "输入",
    "col.output": "输出",
    "col.cacheRead": "缓存读",
    "col.cacheWrite": "缓存写",
    "col.total": "总计",
    "col.cost": "花费",

    /* ---------- settings: resources ---------- */
    "resources.title": "技能 / MCP / 插件",
    "resources.lead": "pi 启动会话时实际会加载的东西，读自 {dir}。只做了清单：启用/禁用、安装/卸载还没实现。",
    "resources.skills": "技能（{count}）",
    "resources.mcp": "MCP server（{count}）",
    "resources.paths": "settings.json 里的资源路径",
    "resources.noSkills": "{dir}/skills 下没有技能。",
    "resources.noMcp": "没有配置 MCP server（{dir}/mcp.json）。",
    "resources.noPaths": "settings.json 没有额外的资源路径；技能命令{state}（enableSkillCommands）。",
    "resources.pathsEnabled": "已启用",
    "resources.pathsDisabled": "未启用",
    "resources.enabled": "已启用",
    "resources.disabled": "已禁用",
    "resources.packages": "packages（插件）",

    /* ---------- settings: models (read-only) ---------- */
    "models.title": "模型配置",
    "models.lead": "pi 启动时的默认值。下面可以改前三个默认（写 settings.json，白名单键）；models.json 仍需手动编辑。",
    "models.current": "当前默认（只读）",
    "models.defaultProvider": "默认 provider",
    "models.defaultModel": "默认模型",
    "models.defaultThinking": "默认思考等级",
    "models.theme": "主题",
    "models.hideThinking": "隐藏思考块",
    "models.unsetProvider": "（未设置，pi 自动选）",
    "models.unset": "（未设置）",
    "models.unsetThinking": "（未设置，默认 medium）",
    "models.yes": "是",
    "models.no": "否",
    "models.switchTitle": "切换当前会话的模型",
    "models.switchLead": "已经能用：底部统计条右侧的下拉（按会话生效，数据来自 pi 的 get_available_models）。",
    "models.plan.2": "编辑 models.json：自定义 endpoint、contextWindow、价格、compat 开关。写盘前先用 pi --list-models 验证，写坏会让 pi 整体不可用",
    "models.plan.3": "provider 鉴权状态（pi auth check --provider X --json）。密钥只回写不回显，明文不进浏览器",

    /* ---------- settings: appearance ---------- */
    "appearance.title": "语言、主题",
    "appearance.lead": "只影响这个网页外壳：不读 pi 的主题文件，也不改 pi 的 settings.json。pi 自己的输出（工具名、报错、思考）与这里无关，保持原样。",
    "appearance.theme": "主题",
    "appearance.themeSystem": "跟随系统",
    "appearance.themeDark": "深色",
    "appearance.themeLight": "浅色",
    "appearance.language": "语言",
    "appearance.languageNote": "只翻译外壳自己的界面文案；会话标题、正文、工具输出都是数据，不翻译。",
    "appearance.note": "偏好存在浏览器 localStorage 里，刷新和重启服务都保留。",
    "appearance.storage": "存在哪里",
    "appearance.themeNote": "主题目前只有内建深色/浅色两套：浅色配色是从 pi 的 light 主题取色后写死在本仓库里，运行时不依赖 pi（跟 --md-* 那批变量同样的做法）。",
    "appearance.plan.2": "以后可以考虑自定义主题文件（~/.pi/agent/themes）与字号/密度偏好",

    /* ---------- settings: agent ---------- */
    "agent.title": "agent 设置",
    "agent.lead": "上面是 pi 现在会读到的值与文件状态，中间可以改白名单内的键，下面是这个服务自己的运行参数。",
    "agent.piDefaults": "pi 的默认值（只读）",
    "agent.defaultModel": "默认模型",
    "agent.skillCommands": "技能命令",
    "agent.skillCommandsOn": "启用",
    "agent.skillCommandsOff": "关闭",
    "agent.configFiles": "配置文件",
    "agent.colFile": "文件",
    "agent.colStatus": "状态",
    "agent.colSize": "大小",
    "agent.colMtime": "修改时间",
    "agent.exists": "存在",
    "agent.missing": "不存在",
    "agent.fileLine": "存在 · {size} · {time}",
    "agent.service": "这个服务",
    "agent.host": "监听",
    "agent.sessionsDir": "会话目录",
    "agent.piBin": "pi 可执行文件",
    "agent.idle": "空闲回收",
    "agent.minutes": "{count} 分钟",
    "agent.agentDir": "agent 目录",
    "agent.plan.2": "编辑 AGENTS.md（全局指令）",
    "agent.plan.3": "项目级 .pi/settings.json 的两级作用域",

    /* ---------- prompts / confirms ---------- */
    "prompt.newFolder": "在哪个文件夹新建会话？（输入绝对路径）",
    "prompt.rename": "重命名会话",
    "prompt.newSessionTitle": "新会话",
    "confirm.deleteSession": "删除会话「{label}」？\n{path} · 该操作可在废纸篓找回（如装有 trash）。",
    "confirm.deleteFolder": "删除「{label}」下的全部 {count} 个会话？\n\n只删会话文件（进废纸篓可找回），目录本身和里面的其他文件不会动。",
    "alert.deletedFolder": "已删除 {count} 个会话。",
    "alert.renameFailed": "重命名失败：{message}",
    "alert.deleteFailed": "删除失败：{message}",
  },

  en: {
    /* ---------- API errors ---------- */
    "api.sessionsFailed": "Failed to load sessions: {status}",
    "api.promptFailed": "Send failed: {status}",
    "api.modelsFailed": "Failed to load models: {status}",
    "api.commandsFailed": "Failed to load commands: {status}",
    "api.setModelFailed": "Failed to switch model: {status}",
    "api.setThinkingFailed": "Failed to set thinking level: {status}",
    "api.serverOutdated": "The server is older than this page. Run: npm run service:restart",
    "api.usageFailed": "Failed to total usage: {status}",
    "api.environmentFailed": "Failed to read configuration: {status}",
    "api.saveSettingsFailed": "Failed to save settings: {status}",
    "api.newSessionFailed": "Failed to create session: {status}",
    "api.renameFailed": "Rename failed: {status}",
    "api.deleteFailed": "Delete failed: {status}",

    /* ---------- shared ---------- */
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.copyFailed": "Copy failed",
    "common.copyCode": "Copy code",
    "common.copyDiagram": "Copy diagram source",
    "common.copyMessage": "Copy this reply",
    "common.error": "Error: {message}",
    "common.retry": "Retry",

    /* ---------- extension UI dialogs / toasts ---------- */
    "ui.cancel": "Cancel",
    "ui.deny": "No",
    "ui.confirm": "Confirm",
    "ui.ok": "OK",
    "ui.dismiss": "Click to dismiss",
    "ui.selectTitle": "Choose",
    "ui.confirmTitle": "Confirm",
    "ui.inputTitle": "Input",
    "ui.editorTitle": "Edit",

    /* ---------- slash-command menu ---------- */
    "command.source.extension": "extension",
    "command.source.prompt": "template",
    "command.source.skill": "skill",
    "command.source.other": "command",

    /* ---------- markdown / mermaid ---------- */
    "mermaid.rendering": "Rendering diagram…",
    "mermaid.notLoaded": "mermaid is not loaded",
    "mermaid.failed": "Diagram failed to render: {message}",

    /* ---------- transcript ---------- */
    "msg.thinking": "Thinking",
    "msg.you": "You",
    "msg.image": "Image",
    "msg.toolImage": "Image returned by a tool",
    "msg.clickToLoad": "Click to load the image",
    "msg.toolFailed": "🔧 {name} · error",
    "msg.toolTool": "🔧 {name}",
    "msg.toolResult": "🔧 {name} result",
    "msg.errorSuffix": " · error",
    "msg.attachment": "Attachment",
    "msg.emptySession": "(Empty session — say something)",
    "msg.disconnected": "Connection lost. Click the session in the sidebar to reconnect.",
    "group.thinking": "Thinking",
    "group.toolCalls": "{count} tool calls",
    "time.justNow": "just now",
    "time.minutes": "{count} min ago",
    "time.hours": "{count} h ago",
    "time.days": "{count} d ago",

    /* ---------- sidebar ---------- */
    "sidebar.folders": "Folders",
    "sidebar.sessions": "Sessions",
    "sidebar.collapseFolders": "Hide the folder pane (⌘B)",
    "sidebar.collapseAll": "Hide both panes (⌘B)",
    "sidebar.expand": "Show the panes (⌘B)",
    "sidebar.newFolder": "New session in a folder…",
    "sidebar.refresh": "Refresh",
    "sidebar.settings": "Settings",
    "sidebar.newSession": "New session in this folder",
    "sidebar.noSessions": "No sessions yet",
    "sidebar.pickFolder": "Pick a folder on the left",
    "sidebar.noSessionsInFolder": "No sessions in this folder",
    "sidebar.folderRunning": "{count} sessions running",
    "sidebar.folderSub": "{count} sessions · {time}",
    "sidebar.folderRunningSuffix": " · {count} running",
    "sidebar.deleteFolder": "Delete every session in this folder (the folder itself is untouched)",
    "session.running": "running",
    "session.runningNow": "running…",
    "session.pending": "No messages yet",
    "session.badgeNew": "new",
    "session.rename": "Rename",
    "session.delete": "Delete session",

    /* ---------- chat ---------- */
    "chat.selectSession": "Select a session",
    "chat.noSessions": "No sessions yet",
    "chat.noSessionsHint": "Click ＋ at the top left to start one in {home} or another folder",
    "chat.noSessionsNotice": "No sessions yet. Click ＋ at the top left and pick a folder.",
    "chat.stop": "Stop",
    "chat.dropHint": "Drop to attach the image",
    "chat.attach": "Attach an image",
    "chat.inputPlaceholder": "Message… (Enter to send, Shift+Enter for a newline, paste or drop images)",
    "chat.send": "Send",
    "chat.sendFailed": "Send failed: {message}",
    "chat.abortFailed": "Could not stop: {message}",
    "chat.switchModel": "Switch model",
    "chat.thinkingLevel": "Adjust thinking level",

    /* ---------- stats bar ---------- */
    "stats.contextTitle": "Context used / the model's context window",
    "stats.context": "context {used} / {window} · {percent}%",
    "stats.tokensTitle": "Tokens this session (input / output)",
    "stats.tokens": "↑ {input} ↓ {output}",
    "stats.cacheTitle": "Input tokens served from cache",
    "stats.cache": "cache {read}",
    "stats.costTitle": "Cost of this session (USD)",
    "stats.turnsTitle": "Assistant turns / tool calls",
    "stats.turns": "{turns} turns · {tools} tools",
    "stats.speedTitle": "Decode speed of this reply (thinking included; ≈ means estimated from characters)",
    "stats.speed": "⚡ {speed}",
    "stats.speedIdleTitle": "Decode speed of the current reply shows up here while the model writes",
    "stats.speedIdle": "⚡ —",

    /* ---------- settings: navigation ---------- */
    "settings.title": "Settings",
    "settings.back": "Back to chat (Esc)",
    "settings.loading": "Loading…",
    "settings.loadingSlow": "Loading… (the first run scans every session file, this can take a second)",
    "settings.loadFailed": "Load failed: {message}",
    "settings.noData": "No data.",
    "settings.note.readonly": "Everything here is read-only: pi reads its config once, when a subprocess starts, so editing a file does not affect sessions that are already open.",
    "settings.note.mcpNoConnect": "MCP is listed from mcp.json without connecting; for live state and tool lists, run pi mcp list.",
    "settings.planned": "Planned",
    "settings.plannedNote": "Not implemented yet — recorded here so it is not forgotten:",
    "settings.editTitle": "Edit (writes settings.json)",
    "settings.editLead": "Only whitelisted keys; \u201cunset\u201d/empty removes the key so pi falls back to its built-in default (shown as the placeholder). A settings.json.bak backup is written before every save, and warm pi subprocesses are recycled afterwards.",
    "settings.unset": "(unset)",
    "settings.on": "on",
    "settings.off": "off",
    "settings.save": "Save",
    "settings.saving": "Saving…",
    "settings.saved": "Saved (backup {backup}); running pi subprocesses were recycled and reconnect with the new settings",
    "settings.autoHint": "empty = pi picks automatically",
    "settings.key.defaultProvider": "Default provider",
    "settings.key.defaultModel": "Default model",
    "settings.key.defaultThinkingLevel": "Default thinking level",
    "settings.key.defaultTools": "Startup tools (+name / -name supported)",
    "settings.key.hideThinkingBlock": "Hide thinking blocks",
    "settings.key.showCacheMissNotices": "Cache-miss notices",
    "settings.key.enableSkillCommands": "Register skills as / commands",
    "settings.key.markdown.mermaid": "Mermaid rendering mode",
    "settings.key.compaction.enabled": "Auto compaction",
    "settings.key.compaction.reserveTokens": "Compaction: tokens reserved for the reply",
    "settings.key.compaction.keepRecentTokens": "Compaction: recent tokens kept",
    "settings.key.images.autoResize": "Resize images before sending (≤2000px)",
    "settings.key.images.blockImages": "Block images to models",
    "settings.key.retry.enabled": "Automatic retry on failure",
    "settings.key.retry.maxRetries": "Retry attempts",
    "settings.key.retry.baseDelayMs": "Retry base delay (ms)",
    "settings.key.retry.maxAgentDelayMs": "Retry max delay (ms)",
    "settings.menu.usage": "Token usage",
    "settings.menu.usageSub": "Usage and cost across all sessions",
    "settings.menu.resources": "Skills / MCP / packages",
    "settings.menu.resourcesSub": "What pi will load",
    "settings.menu.models": "Models",
    "settings.menu.modelsSub": "Defaults editable (writes settings.json)",
    "settings.menu.appearance": "Language, theme",
    "settings.menu.appearanceSub": "preferences of this shell",
    "settings.menu.agent": "Agent",
    "settings.menu.agentSub": "Partly editable, rest planned",

    /* ---------- settings: token usage ---------- */
    "usage.title": "Token usage",
    "usage.lead": "Sums the `usage` of {messages} assistant messages across {files} session files. The numbers are pi's own records (cache and thinking tokens included).",
    "usage.model": "Model",
    "usage.allModels": "All models ({count})",
    "usage.filterNeedsRestart": "Filtering needs a server restart (npm run service:restart)",
    "usage.onlyModel": "{model} only",
    "usage.heatNote": "brighter = more tokens that day",
    "usage.empty": "No usage recorded yet.",
    "usage.card.cost": "Total cost",
    "usage.card.costSub": "{count} model calls",
    "usage.card.total": "Total tokens",
    "usage.card.totalSub": "input {input}",
    "usage.card.output": "Output",
    "usage.card.outputSub": "thinking {reasoning}",
    "usage.card.cacheRead": "Cache reads",
    "usage.card.cacheReadSub": "cache writes {cacheWrite}",
    "usage.heatmap": "Daily heatmap",
    "usage.byDay": "By day",
    "usage.byModel": "By model",
    "usage.byProject": "By project",
    "usage.bySession": "By session (top 50 by cost)",
    "usage.heat.none": "No dated records.",
    "usage.heat.noRecord": "No records",
    "usage.heat.less": "less",
    "usage.heat.more": "more",
    "usage.heat.tipCalls": "{cost} · {calls} calls",
    "usage.heat.tipInput": "input {input} · output {output}",
    "usage.heat.tipThinking": " (thinking {reasoning})",
    "usage.heat.tipCache": "cache read {cacheRead} · write {cacheWrite}",
    "usage.weekday.mon": "M",
    "usage.weekday.wed": "W",
    "usage.weekday.fri": "F",
    "usage.date.weekday": "{date} {weekday}",
    "col.date": "Date",
    "col.model": "Model",
    "col.project": "Project",
    "col.session": "Session",
    "col.calls": "Calls",
    "col.input": "Input",
    "col.output": "Output",
    "col.cacheRead": "Cache read",
    "col.cacheWrite": "Cache write",
    "col.total": "Total",
    "col.cost": "Cost",

    /* ---------- settings: resources ---------- */
    "resources.title": "Skills / MCP / packages",
    "resources.lead": "What pi loads when it starts a session, read from {dir}. Read-only: enabling, disabling, installing are not implemented.",
    "resources.skills": "Skills ({count})",
    "resources.mcp": "MCP servers ({count})",
    "resources.paths": "Resource paths in settings.json",
    "resources.noSkills": "No skills under {dir}/skills.",
    "resources.noMcp": "No MCP server configured ({dir}/mcp.json).",
    "resources.noPaths": "settings.json has no extra resource paths; skill commands are {state} (enableSkillCommands).",
    "resources.pathsEnabled": "enabled",
    "resources.pathsDisabled": "disabled",
    "resources.enabled": "enabled",
    "resources.disabled": "disabled",
    "resources.packages": "packages",

    /* ---------- settings: models (read-only) ---------- */
    "models.title": "Models",
    "models.lead": "The defaults pi starts with. The first three are editable below (settings.json, whitelisted keys); models.json still needs manual editing.",
    "models.current": "Current defaults (read-only)",
    "models.defaultProvider": "Default provider",
    "models.defaultModel": "Default model",
    "models.defaultThinking": "Default thinking level",
    "models.theme": "Theme",
    "models.hideThinking": "Hide thinking blocks",
    "models.unsetProvider": "(unset — pi picks one)",
    "models.unset": "(unset)",
    "models.unsetThinking": "(unset — defaults to medium)",
    "models.yes": "yes",
    "models.no": "no",
    "models.switchTitle": "Switching the model of the open session",
    "models.switchLead": "Already available: the dropdown at the right of the stats bar (per session, fed by pi's get_available_models).",
    "models.plan.2": "Edit models.json: custom endpoints, contextWindow, prices, compat flags. Validate with `pi --list-models` before writing — a broken file makes pi unusable",
    "models.plan.3": "Provider auth status (pi auth check --provider X --json). Keys are write-only: never echoed back, never sent to the browser",

    /* ---------- settings: appearance ---------- */
    "appearance.title": "Language, theme",
    "appearance.lead": "Affects this web shell only: it does not read pi's theme files and does not write pi's settings.json. pi's own output (tool names, errors, thinking) is unrelated and stays as it is.",
    "appearance.theme": "Theme",
    "appearance.themeSystem": "System",
    "appearance.themeDark": "Dark",
    "appearance.themeLight": "Light",
    "appearance.language": "Language",
    "appearance.languageNote": "Translates this shell's interface only. Session titles, message bodies, and tool output are data and are never translated.",
    "appearance.note": "Stored in the browser's localStorage, so it survives reloads and service restarts.",
    "appearance.storage": "Where this is stored",
    "appearance.themeNote": "Only the two built-in themes exist. The light palette was resolved from pi's light theme once and hardcoded in this repo, the same way the --md-* variables are — nothing reads pi at runtime.",
    "appearance.plan.2": "Possible later: custom theme files (~/.pi/agent/themes), font size and density preferences",

    /* ---------- settings: agent ---------- */
    "agent.title": "Agent",
    "agent.lead": "Above: what pi reads today, and the state of its files. Middle: edit the whitelisted keys. Below: how this server itself is configured.",
    "agent.piDefaults": "pi's defaults (read-only)",
    "agent.defaultModel": "Default model",
    "agent.skillCommands": "Skill commands",
    "agent.skillCommandsOn": "enabled",
    "agent.skillCommandsOff": "disabled",
    "agent.configFiles": "Config files",
    "agent.colFile": "File",
    "agent.colStatus": "Status",
    "agent.colSize": "Size",
    "agent.colMtime": "Modified",
    "agent.exists": "present",
    "agent.missing": "missing",
    "agent.fileLine": "present · {size} · {time}",
    "agent.service": "This service",
    "agent.host": "Listening on",
    "agent.sessionsDir": "Sessions directory",
    "agent.piBin": "pi binary",
    "agent.idle": "Idle timeout",
    "agent.minutes": "{count} min",
    "agent.agentDir": "Agent directory",
    "agent.plan.2": "Edit AGENTS.md (global instructions)",
    "agent.plan.3": "Two-level scope: project .pi/settings.json on top of the user file",

    /* ---------- prompts / confirms ---------- */
    "prompt.newFolder": "Which folder should the session live in? (absolute path)",
    "prompt.rename": "Rename session",
    "prompt.newSessionTitle": "New session",
    "confirm.deleteSession": "Delete the session “{label}”?\n{path} · It goes to the trash when the `trash` command is available.",
    "confirm.deleteFolder": "Delete all {count} sessions under “{label}”?\n\nOnly session files are removed (recoverable from the trash); the directory and everything else in it stay.",
    "alert.deletedFolder": "Deleted {count} sessions.",
    "alert.renameFailed": "Rename failed: {message}",
    "alert.deleteFailed": "Delete failed: {message}",
  },
};

let locale = DEFAULT_LOCALE;

export function getLocale() {
  return locale;
}

export function isLocale(id) {
  return LOCALES.some((entry) => entry.id === id);
}

/**
 * Switch languages and re-translate the static markup. Dynamic parts (the
 * sidebar, the transcript, the settings page) are re-rendered by the caller.
 */
export function setLocale(id) {
  locale = isLocale(id) ? id : DEFAULT_LOCALE;
  document.documentElement.lang = locale;
  applyStaticText();
}

/**
 * Look up `key` and fill `{placeholder}` slots from `params`.
 *
 * Falls back to the default locale, then to the key itself: a missing
 * translation should be visible, not silent.
 */
export function t(key, params) {
  const text = MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_LOCALE]?.[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Fill the static markup from index.html.
 *
 * `data-i18n` replaces the text, `-title` / `-placeholder` / `-aria` the
 * corresponding attributes. Elements whose content is dynamic must not carry
 * `data-i18n`.
 */
export function applyStaticText(root = document) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll("[data-i18n-aria]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAria));
  }
}
