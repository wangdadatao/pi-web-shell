/* global EventSource, fetch, document, window, FileReader */

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

/** Loaded as a classic script in index.html (with `manual: true`). */
const prism = globalThis.Prism;

// Open links in a new tab; never leak the opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const api = {
  async sessions() {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error(`加载会话失败: ${res.status}`);
    return res.json();
  },
  async prompt(path, message, images) {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, message, images }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `发送失败: ${res.status}`);
    return data;
  },
  async abort(path) {
    await fetch("/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  },
  async models(path) {
    const res = await fetch(`/api/models?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`加载模型列表失败: ${res.status}`);
    return res.json();
  },
  async setModel(path, provider, modelId) {
    const res = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, provider, modelId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `切换模型失败: ${res.status}`);
    return data;
  },
  async setThinking(path, level) {
    const res = await fetch("/api/thinking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, level }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `设置思考等级失败: ${res.status}`);
    return data;
  },
  async newSession(cwd) {
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `新建会话失败: ${res.status}`);
    return data;
  },
  async rename(path, name) {
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `重命名失败: ${res.status}`);
    return data;
  },
  async deleteSession(path) {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `删除失败: ${res.status}`);
    return data;
  },
  async deleteFolderSessions(cwd) {
    const res = await fetch("/api/delete-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `删除失败: ${res.status}`);
    return data;
  },
};

const el = {
  folderList: document.getElementById("folder-list"),
  sessionList: document.getElementById("session-list"),
  sessionsTitle: document.getElementById("sessions-title"),
  chatTitle: document.getElementById("chat-title"),
  chatMeta: document.getElementById("chat-meta"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  abort: document.getElementById("abort"),
  attach: document.getElementById("attach"),
  file: document.getElementById("file"),
  attachments: document.getElementById("attachments"),
  status: document.getElementById("status"),
  refresh: document.getElementById("refresh"),
  newSession: document.getElementById("new-session"),
  newFolder: document.getElementById("new-folder"),
  stats: document.getElementById("stats"),
  statsItems: document.getElementById("stats-items"),
  statsActions: document.getElementById("stats-actions"),
  modelSelect: document.getElementById("model-select"),
  thinkingSelect: document.getElementById("thinking-select"),
  dropHint: document.getElementById("drop-hint"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebarCrumb: document.getElementById("sidebar-crumb"),
};

const state = {
  home: null,
  folders: [],
  sessions: [],
  cwd: null,
  path: null,
  stream: null,
  streaming: false,
  attachments: [],
  live: null,
  toolGroup: null,
  toolEntryIndex: new Map(),
  stats: null,
  models: [],
  thinkingLevels: [],
  modelLabel: null,
  thinkingLevel: null,
  streamStart: 0,
  streamReportedTokens: 0,
  streamEstimatedTokens: 0,
  statsTimer: null,
  lastSpeed: null,
  loadTimer: null,
};

// ---------------------------------------------------------------- rendering

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Render model/user prose as sanitized Markdown. */
function renderMarkdown(text) {
  if (!text) return "";
  const html = marked.parse(String(text));
  return `<div class="md">${DOMPurify.sanitize(html)}</div>`;
}

/**
 * Fenced code blocks get a header with the language and a copy button.
 * Prism highlights the code; unknown languages fall back to escaped text.
 */
marked.use({
  renderer: {
    code({ text, lang, escaped }) {
      const language = (lang || "").trim().split(/\s+/)[0] || "";
      const code = text.replace(/\n$/, "");
      const grammar = language ? prism?.languages?.[language] : undefined;
      let body = null;
      if (grammar && !escaped) {
        try {
          body = prism.highlight(code, grammar, language);
        } catch {
          body = null;
        }
      }
      const label = language ? `<span class="code-lang">${esc(language)}</span>` : "<span></span>";
      const className = language ? "code-block" : "code-block no-lang";
      return (
        `<div class="${className}">` +
        `<div class="code-head">${label}` +
        `<button class="copy-btn" type="button" data-copy="code" aria-label="复制代码">复制</button></div>` +
        `<pre class="language-${esc(language)}"><code class="language-${esc(language)}">${body ?? esc(code)}</code></pre>` +
        `</div>`
      );
    },
    image({ href, title, text }) {
      const alt = esc(text || "");
      const titleAttr = title ? ` title="${esc(title)}"` : "";
      const local = localImageSrc(href);
      if (!local) return `<img src="${esc(href || "")}" alt="${alt}"${titleAttr} />`;
      return `<img src="${esc(local)}" alt="${alt}"${titleAttr} class="md-img-local" loading="lazy" decoding="async" />`;
    },
  },
});

/** Render literal text (tool output, thinking) without Markdown interpretation. */
function renderPlain(text) {
  return `<div class="plain">${esc(text)}</div>`;
}

/**
 * Recognize a local filesystem path in a Markdown image href.
 *
 * The model cannot attach images to a reply, but it can write
 * `![alt](/abs/path.png)` (see the image-gen skill). Those bytes are streamed
 * from /api/local-image, which only ever serves sniffed image files. Anything
 * else (http(s), data:, relative) is left for DOMPurify to judge as-is.
 */
function localImageSrc(href) {
  const raw = String(href ?? "").trim();
  let path = null;
  if (raw.startsWith("file://")) {
    path = raw.slice("file://".length);
    if (!path.startsWith("/")) path = `/${path}`;
  } else if (raw.startsWith("~/") && state.home) {
    path = state.home + raw.slice(1);
  } else if (raw.startsWith("/") && !raw.startsWith("/api/")) {
    path = raw;
  }
  return path ? `/api/local-image?path=${encodeURIComponent(path)}` : null;
}

function renderBlock(block) {
  if (typeof block === "string") return renderMarkdown(block);
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return renderMarkdown(block.text || "");
  if (block.type === "thinking") return renderThinking(block.thinking || "", false);
  if (block.type === "image") return renderImage(block);
  if (block.type === "toolCall") {
    return renderToolChip(block.toolName || block.name || "tool", block.arguments ?? block.args, false, false);
  }
  return "";
}

function renderThinking(text, open) {
  return `<details class="thinking-block"${open ? " open" : ""}><summary>思考</summary><div class="thinking-body">${esc(text)}</div></details>`;
}

function renderImage(block) {
  const src = imageSrc(block);
  if (!src) return "";
  // width/height let the browser reserve space, so scrolling does not jump
  // while images stream in.
  const size =
    block.width && block.height ? ` width="${Number(block.width)}" height="${Number(block.height)}"` : "";
  return `<img src="${esc(src)}" alt="图片" loading="lazy" decoding="async"${size} />`;
}

function imageSrc(block) {
  if (block.hash) return `/api/image/${block.hash}`;
  if (block.data) return `data:${block.mimeType || "image/png"};base64,${block.data}`;
  return "";
}

/**
 * Images produced by a tool (e.g. `read` on a png) are not inlined.
 *
 * pi's own HTML export sets `showImages: false` for tool results and prints an
 * `[image/png 1920x1080]` placeholder instead. We match that, and only fetch the
 * bytes when the placeholder is clicked — tool-result images were 85% of one
 * session's 28 MB.
 */
function renderToolImage(block) {
  const src = imageSrc(block);
  if (!src) return "";
  const dimensions = block.width && block.height ? ` ${block.width}×${block.height}` : "";
  const bytes = block.bytes ? ` · ${formatBytes(block.bytes)}` : "";
  const label = `🖼 [${block.mimeType || "image"}${dimensions}]`;
  return (
    `<button class="image-placeholder" type="button" data-image="${esc(src)}" ` +
    `title="点击加载图片">${esc(label)}${esc(bytes)}</button>`
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return renderMarkdown(content);
  if (Array.isArray(content)) return content.map(renderBlock).join("");
  return "";
}

/**
 * Tool output is rendered literally (Markdown would reinterpret shell output),
 * but image blocks survive as click-to-load placeholders.
 */
function renderToolResultContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return renderPlain(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return renderPlain(block.text || "");
      if (block.type === "image") return renderToolImage(block);
      return "";
    })
    .join("");
}


function formatToolValue(value) {  if (value === undefined || value === null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw;
}

/**
 * One tool call. `resultContent` is only known once the call finishes, so a
 * caller can re-render the same entry with the output attached.
 */
function renderToolChip(name, args, isError, open, resultContent) {
  const argsText = formatToolValue(args);
  const body =
    (argsText ? `<pre class="tool-args">${esc(argsText)}</pre>` : "") +
    renderToolResultContent(resultContent);
  const label = isError ? `🔧 ${esc(name)} · 出错` : `🔧 ${esc(name)}`;
  return `<details class="tool-chip${isError ? " error" : ""}"${open ? " open" : ""}><summary class="tool-name">${label}</summary>${body}</details>`;
}

function messageNode(role, content) {
  const node = document.createElement("div");
  node.className = `msg ${role}`;
  if (role === "user") {
    node.innerHTML = `<div class="role-tag">你</div>${renderContent(content)}`;
  } else if (role === "assistant") {
    node.innerHTML = `${assistantHead()}${renderContent(content)}`;
  } else {
    node.innerHTML = renderContent(content);
  }
  return node;
}

function assistantHead() {
  return (
    `<div class="msg-head"><span class="role-tag">pi</span>` +
    `<button class="copy-btn" type="button" data-copy="message" aria-label="复制这条回复">复制</button></div>`
  );
}

function addMessage(msg) {
  const role = msg && msg.role ? msg.role : "notice";
  if (role === "system") return;
  closeToolGroup();
  el.messages.appendChild(messageNode(role, msg.content));
}

// ------------------------------------------------------------ tool grouping

/**
 * Consecutive tool calls and their results collapse into a single block.
 *
 * A long agent run can emit dozens of them; rendering each as its own bubble
 * buries the actual conversation. A group stays open while the run is live so
 * progress is visible, and collapses as soon as the assistant talks again.
 */
function ensureToolGroup() {
  if (state.toolGroup) return state.toolGroup;
  const details = document.createElement("details");
  details.className = "tool-group";
  details.open = state.streaming;
  const summary = document.createElement("summary");
  summary.className = "tool-group-summary";
  const body = document.createElement("div");
  body.className = "tool-group-body";
  details.append(summary, body);
  el.messages.appendChild(details);
  state.toolGroup = { details, summary, body, names: [], hasThinking: false };
  updateToolGroupSummary(state.toolGroup);
  return state.toolGroup;
}

function addToolEntry(html, name) {
  const group = ensureToolGroup();
  if (name) group.names.push(name);
  else group.hasThinking = true;
  const entry = document.createElement("div");
  entry.className = "tool-entry";
  entry.innerHTML = html;
  group.body.appendChild(entry);
  updateToolGroupSummary(group);
  scrollToEnd();
  return entry;
}

/** Update the entry created by `tool_execution_start` instead of adding a second one. */
function finishToolEntry(event) {
  const tracked = event.toolCallId ? state.toolEntryIndex.get(event.toolCallId) : undefined;
  const html = renderToolChip(
    event.toolName,
    tracked ? tracked.args : undefined,
    Boolean(event.isError),
    true,
    toolResultContent(event.result),
  );
  if (tracked) {
    tracked.entry.innerHTML = html;
    scrollToEnd();
    return;
  }
  addToolEntry(html, event.toolName);
}

function updateToolGroupSummary(group) {
  const counts = new Map();
  for (const name of group.names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));

  const head = [];
  if (group.hasThinking) head.push("思考");
  if (group.names.length > 0) head.push(`${group.names.length} 次工具调用`);

  const shown = parts.slice(0, 6).join("、");
  const detail = parts.length > 0 ? `${shown}${parts.length > 6 ? " …" : ""}` : "";
  group.summary.textContent = detail ? `${head.join(" + ")} · ${detail}` : head.join(" + ");
}

function closeToolGroup() {
  if (state.toolGroup) state.toolGroup.details.open = false;
  state.toolGroup = null;
  state.toolEntryIndex = new Map();
}

/**
 * Split assistant content into prose and tool calls.
 *
 * `hasText` is false for a turn that only thought and called tools - such a
 * turn gets no bubble of its own; its thinking folds into the activity group.
 */
function splitAssistant(content) {
  if (typeof content === "string") {
    return content.trim() === ""
      ? { prose: [], tools: [], hasText: false }
      : { prose: [{ type: "text", text: content }], tools: [], hasText: true };
  }
  if (!Array.isArray(content)) return { prose: [], tools: [], hasText: false };

  const prose = [];
  const tools = [];
  let hasText = false;
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "toolCall") {
      tools.push(block);
      continue;
    }
    prose.push(block);
    if (!block || typeof block !== "object" || block.type !== "thinking") hasText = true;
  }
  return { prose, tools, hasText };
}

function renderToolResult(msg) {
  const name = esc(msg.toolName || "tool");
  return `<details class="tool-result"><summary>🔧 ${name} 结果${msg.isError ? " · 出错" : ""}</summary>${renderToolResultContent(msg.content)}</details>`;
}

/** Render a stored transcript, grouping consecutive tool activity. */
function renderHistory(messages) {
  state.toolGroup = null;
  state.toolEntryIndex = new Map();
  for (const msg of messages) {
    const role = msg && msg.role ? msg.role : "notice";
    if (role === "system") continue;

    if (role === "toolResult") {
      // Fold the output back into the call that produced it, so one tool call
      // is one entry (same shape as the live path).
      const tracked = msg.toolCallId ? state.toolEntryIndex.get(msg.toolCallId) : undefined;
      if (tracked) {
        tracked.entry.innerHTML = renderToolChip(
          msg.toolName || "tool",
          tracked.args,
          Boolean(msg.isError),
          false,
          msg.content,
        );
      } else {
        addToolEntry(renderToolResult(msg), msg.toolName || "tool");
      }
      continue;
    }

    if (role === "assistant") {
      const { prose, tools, hasText } = splitAssistant(msg.content);
      if (hasText) {
        closeToolGroup();
        el.messages.appendChild(messageNode("assistant", prose));
      } else {
        for (const block of prose) {
          if (block && block.type === "thinking") addToolEntry(renderThinking(block.thinking || "", false), null);
        }
      }
      for (const tool of tools) {
        const name = tool.toolName || tool.name || "tool";
        const args = tool.arguments ?? tool.args;
        const entry = addToolEntry(renderToolChip(name, args, false, false), name);
        const id = tool.id || tool.toolCallId;
        if (id) state.toolEntryIndex.set(id, { entry, args });
      }
      continue;
    }

    closeToolGroup();
    el.messages.appendChild(messageNode(role, msg.content));
  }
  closeToolGroup();
}

function addNotice(text, cls = "notice") {
  const node = document.createElement("div");
  node.className = `msg ${cls}`;
  node.textContent = text;
  el.messages.appendChild(node);
}

function scrollToEnd() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function skeletonHtml() {
  return `<div class="skeleton"><i></i><i></i><i></i></div>`;
}

// ---------------------------------------------------------------- sidebar

function shortPath(cwd) {
  const { prefix, rest } = splitHome(cwd);
  if (!rest) return prefix || "/";
  const parts = rest.split("/").filter(Boolean);
  const tail = parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
  return prefix ? `${prefix}/${tail}` : tail;
}

/** Full path with the home directory collapsed to ~. */
function prettyPath(cwd) {
  const { prefix, rest } = splitHome(cwd);
  if (!prefix) return cwd;
  return rest ? `${prefix}/${rest}` : prefix;
}

function splitHome(cwd) {
  const home = state.home;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return { prefix: "~", rest: cwd.slice(home.length).replace(/^\//, "") };
  }
  return { prefix: "", rest: cwd.replace(/^\//, "") };
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------- sidebar

const SIDEBAR_KEY = "piShellSidebar";

/** Current folder (or selected session's folder) shown while collapsed. */
function updateSidebarCrumb() {
  const parts = [];
  if (state.cwd) parts.push(shortPath(state.cwd));
  const current = state.sessions.find((s) => s.path === state.path);
  if (current) parts.push(current.title);
  el.sidebarCrumb.textContent = parts.join(" / ");
  el.sidebarCrumb.title = parts.join(" / ");
}

function setSidebar(collapsed) {
  document.getElementById("app").classList.toggle("sidebar-collapsed", collapsed);
  el.sidebarToggle.textContent = collapsed ? "»" : "‹";
  el.sidebarToggle.title = collapsed ? "展开侧栏" : "折叠侧栏";
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "0" : "1");
  } catch {
    // Private mode etc. — the toggle still works, just not remembered.
  }
}

function initSidebar() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_KEY) === "0";
  } catch {
    // ignore
  }
  if (collapsed) setSidebar(true);
  const app = document.getElementById("app");
  el.sidebarToggle.onclick = () => setSidebar(!app.classList.contains("sidebar-collapsed"));
  // Cmd/Ctrl+B mirrors the editor convention for toggling side panels.
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setSidebar(!app.classList.contains("sidebar-collapsed"));
    }
  });
}

function renderFolders() {
  el.folderList.innerHTML = "";
  if (state.folders.length === 0) {
    el.folderList.innerHTML = `<div class="empty">还没有任何会话</div>`;
    return;
  }
  for (const folder of state.folders) {
    const node = document.createElement("div");
    node.className = `item folder${folder.cwd === state.cwd ? " active" : ""}`;
    node.innerHTML = `<div class="name" title="${esc(folder.cwd)}">${esc(shortPath(folder.cwd))}</div>
      <div class="sub">${folder.sessionCount} 个会话 · ${relativeTime(folder.lastActivity)}</div>
      <div class="item-actions">
        <button class="icon-btn folder-act" data-act="delete" title="删除该目录下的所有会话（不碰目录本身）">🗑</button>
      </div>`;
    node.onclick = () => selectFolder(folder.cwd);
    node.querySelector(".item-actions").onclick = (event) => {
      event.stopPropagation();
      if (event.target.closest(".folder-act")) deleteFolderSessions(folder);
    };
    el.folderList.appendChild(node);
  }
}

function renderSessions() {
  const list = state.sessions.filter((s) => s.cwd === state.cwd);
  el.sessionsTitle.textContent = state.cwd ? shortPath(state.cwd) : "会话";
  updateSidebarCrumb();
  el.sessionList.innerHTML = "";
  if (!state.cwd) {
    el.sessionList.innerHTML = `<div class="empty">选择左侧文件夹</div>`;
    return;
  }
  if (list.length === 0) {
    el.sessionList.innerHTML = `<div class="empty">该文件夹下没有会话</div>`;
    return;
  }
  for (const session of list) {
    const node = document.createElement("div");
    node.className = `item session${session.path === state.path ? " active" : ""}${session.pending ? " pending" : ""}`;
    const badge = session.pending ? `<span class="badge">新</span>` : "";
    const sub = session.pending ? "尚未发送第一条消息" : relativeTime(session.updatedAt);
    node.innerHTML = `<div class="name" title="${esc(session.title)}">${esc(session.title)}${badge}</div>
      <div class="sub">${esc(sub)}</div>
      <div class="item-actions">
        <button class="icon-btn session-act" data-act="rename" title="重命名">✎</button>
        <button class="icon-btn session-act" data-act="delete" title="删除会话">🗑</button>
      </div>`;
    node.onclick = () => openSession(session);
    node.querySelector(".item-actions").onclick = (event) => {
      event.stopPropagation();
      const act = event.target.closest(".session-act")?.dataset.act;
      if (act === "rename") renameSession(session, node);
      else if (act === "delete") deleteSession(session, node);
    };
    el.sessionList.appendChild(node);
  }
}

async function selectFolder(cwd) {
  state.cwd = cwd;
  renderFolders();
  renderSessions();
}

// ---------------------------------------------------------------- session

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearTimeout(state.loadTimer);
  state.loadTimer = null;
  stopStatsTicker();
  state.streaming = false;
  state.live = null;
  state.toolGroup = null;
  state.toolEntryIndex = new Map();
  state.stats = null;
  state.streamStart = 0;
  state.streamReportedTokens = 0;
  state.streamEstimatedTokens = 0;
  state.lastSpeed = null;
  resetModelControls();
  renderStats();
  setStatus("idle");
}

function setStatus(kind) {
  el.status.className = `status ${kind}`;
  el.abort.disabled = kind !== "live";
}

async function openSession(session) {
  closeStream();
  state.path = session.path;
  state.cwd = session.cwd;
  el.messages.innerHTML = "";
  el.chatTitle.textContent = session.title;
  el.chatMeta.textContent = session.cwd;
  renderFolders();
  renderSessions();
  setStatus("loading");

  // Only show a skeleton if the snapshot is actually slow; a fast load should
  // not flash a placeholder at all.
  const sessionPath = session.path;
  clearTimeout(state.loadTimer);
  state.loadTimer = setTimeout(() => {
    if (state.path === sessionPath) el.messages.innerHTML = skeletonHtml();
  }, 250);

  const stream = new EventSource(`/api/stream?path=${encodeURIComponent(session.path)}`);
  state.stream = stream;

  stream.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.type === "snapshot") return handleSnapshot(frame);
    if (frame.type === "event") return handleEvent(frame.event);
    if (frame.type === "stats") {
      state.stats = frame.stats;
      renderStats();
      return;
    }
    if (frame.type === "error") {
      addNotice(`错误：${frame.error}`, "error");
      setStatus("idle");
    }
  };

  stream.onerror = () => {
    addNotice("连接已断开（pi 进程可能已退出）", "error");
    setStatus("idle");
  };
}

function handleSnapshot(frame) {
  clearTimeout(state.loadTimer);
  state.loadTimer = null;
  el.messages.innerHTML = "";
  const messages = frame.messages || [];
  if (messages.length === 0) addNotice("(空会话，开始对话吧)");
  renderHistory(messages);

  const model = frame.state && frame.state.model;
  state.modelLabel = model ? `${model.provider}/${model.name || model.id}` : null;
  state.thinkingLevel = (frame.state && frame.state.thinkingLevel) ?? null;
  updateChatMeta();
  setStatus(frame.state && frame.state.isStreaming ? "live" : "idle");
  state.stats = frame.stats ?? null;
  renderStats();
  loadModelControls();
  scrollToEnd();
}

function handleEvent(event) {
  switch (event.type) {
    case "agent_start":
      state.streaming = true;
      state.streamStart = performance.now();
      state.streamReportedTokens = 0;
      state.streamEstimatedTokens = 0;
      state.lastSpeed = null;
      startStatsTicker();
      setStatus("live");
      break;
    case "message_start":
      // Build the assistant bubble lazily: a tool-only turn must not create one.
      if (event.message && event.message.role === "assistant") state.live = null;
      break;
    case "message_update":
      applyDelta(event);
      break;
    case "message_end":
      if (event.message && event.message.role === "assistant") finalizeAssistant(event.message);
      break;
    case "tool_execution_start": {
      const entry = addToolEntry(renderToolChip(event.toolName, event.args, false, true), event.toolName);
      if (typeof event.toolCallId === "string") {
        state.toolEntryIndex.set(event.toolCallId, { entry, args: event.args });
      }
      break;
    }
    case "tool_execution_end":
      finishToolEntry(event);
      break;
    case "session_info_changed":
      if (event.name) {
        el.chatTitle.textContent = event.name;
        refreshSessionList();
      }
      break;
    case "thinking_level_changed":
      if (typeof event.level === "string") {
        state.thinkingLevel = event.level;
        if (!el.thinkingSelect.hidden && [...el.thinkingSelect.options].some((o) => o.value === event.level)) {
          el.thinkingSelect.value = event.level;
        }
        updateChatMeta();
      }
      break;
    case "agent_settled":
      closeToolGroup();
      // Keep the final rate on screen until the next run starts.
      state.lastSpeed = currentSpeed();
      state.streaming = false;
      state.live = null;
      stopStatsTicker();
      renderStats();
      setStatus("idle");
      refreshSessionList();
      break;
    default:
      break;
  }
}

/** A live tool result arrives as `{content: [...]}`; keep the blocks intact. */
function toolResultContent(result) {
  if (!result || typeof result !== "object") return result;
  const content = result.content;
  return Array.isArray(content) ? content : summarizeResult(result);
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((block) => (block && block.type === "text" ? block.text : `[${block && block.type}]`))
      .join("\n");
  }
  return result;
}

/** Replace the streamed bubble with the authoritative message once it ends. */
function finalizeAssistant(message) {
  const { prose, hasText } = splitAssistant(message.content);
  if (hasText) {
    const node = ensureLive();
    node.classList.remove("streaming");
    node.innerHTML = `${assistantHead()}${renderContent(prose)}`;
    closeToolGroup();
  } else if (state.live) {
    // Thinking-only turn: fold the streamed thinking into the activity group
    // instead of leaving an otherwise empty bubble behind.
    const thinking = [...state.live.querySelectorAll(".thinking-block")];
    state.live.remove();
    for (const block of thinking) addToolEntry(block.outerHTML, null);
  }
  state.live = null;
  scrollToEnd();
}

/** The bubble for the assistant turn currently streaming; text closes a tool group. */
function ensureLive() {
  if (state.live) return state.live;
  closeToolGroup();
  const node = messageNode("assistant", []);
  node.classList.add("streaming");
  el.messages.appendChild(node);
  state.live = node;
  return node;
}

function applyDelta(event) {
  const delta = event.assistantMessageEvent;
  if (!delta) return;
  if (typeof event.usage?.output === "number" && event.usage.output > 0) {
    state.streamReportedTokens = event.usage.output;
  }
  if (delta.type === "text_delta") {
    state.streamEstimatedTokens += estimateTokens(delta.delta ?? "");
    ensureLive();
    appendText(delta.delta);
  } else if (delta.type === "thinking_delta") {
    state.streamEstimatedTokens += estimateTokens(delta.delta ?? "");
    ensureLive();
    appendThinking(delta.delta);
  } else if (delta.type === "text_end") {
    ensureLive();
    appendText("", delta.content);
  }
  scrollToEnd();
}

/** Cheap CJK-aware token estimate, used only when the provider reports nothing. */
const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk / 1.4 + other / 4;
}

function appendText(chunk, full) {
  const live = ensureLive();
  let textBlock = live.querySelector(".live-text");
  if (!textBlock) {
    textBlock = document.createElement("div");
    textBlock.className = "live-text";
    live.appendChild(textBlock);
    textBlock.dataset.text = "";
  }
  if (full !== undefined) {
    textBlock.dataset.text = full;
    textBlock.innerHTML = renderMarkdown(full);
  } else {
    textBlock.dataset.text += chunk;
    textBlock.textContent = textBlock.dataset.text;
  }
}

function appendThinking(chunk) {
  const live = ensureLive();
  let block = live.querySelector(".thinking-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "thinking-block";
    live.appendChild(block);
    block.dataset.text = "";
  }
  block.dataset.text += chunk;
  block.textContent = block.dataset.text;
}

// ------------------------------------------------------------------ stats

function fmtTokens(value) {
  if (value === null || value === undefined) return "?";
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e5 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

function fmtCost(cost) {
  if (!Number.isFinite(cost)) return "";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(2)}`;
}

/** Output tokens per second. Prefixed with ≈ when it is an estimate. */
function currentSpeed() {
  if (!state.streaming || !state.streamStart) return null;
  const seconds = (performance.now() - state.streamStart) / 1000;
  if (seconds < 1) return null;
  const reported = state.streamReportedTokens;
  const count = reported > 0 ? reported : state.streamEstimatedTokens;
  if (!(count > 0)) return null;
  const rate = count / seconds;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return `${reported > 0 ? "" : "≈"}${rate.toFixed(1)} tok/s`;
}

function renderStats() {
  const stats = state.stats;
  const parts = [];

  const usage = stats && stats.contextUsage;
  if (usage && usage.contextWindow) {
    const percent = usage.percent === null || usage.percent === undefined ? 0 : usage.percent;
    const width = Math.max(0, Math.min(100, percent)).toFixed(1);
    parts.push(
      `<span class="stat" title="当前上下文占用 / 模型上下文窗口">` +
        `<span class="ctx-bar"><i style="width:${width}%"></i></span>` +
        `上下文 ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} · ${Number(percent).toFixed(1)}%</span>`,
    );
  }

  if (stats) {
    parts.push(
      `<span class="stat" title="本次会话累计 token（输入 / 输出）">↑ ${fmtTokens(stats.tokens.input)} ↓ ${fmtTokens(stats.tokens.output)}</span>`,
    );
    if (stats.tokens.cacheRead > 0) {
      parts.push(`<span class="stat" title="命中缓存的输入 token">缓存 ${fmtTokens(stats.tokens.cacheRead)}</span>`);
    }
    parts.push(`<span class="stat" title="本次会话累计花费（美元）">${fmtCost(stats.cost)}</span>`);
    parts.push(
      `<span class="stat" title="助手回复轮数 / 工具调用次数">${stats.assistantMessages} 轮 · ${stats.toolCalls} 工具</span>`,
    );
  }

  const speed = currentSpeed() ?? state.lastSpeed;
  if (speed) {
    parts.push(`<span class="stat speed" title="输出速度（估算值带 ≈）">⚡ ${speed}</span>`);
  } else if (parts.length > 0) {
    // Keep the slot visible so it is obvious where the rate appears.
    parts.push(`<span class="stat speed idle-speed" title="模型生成时这里显示输出速度">⚡ —</span>`);
  }

  el.statsItems.innerHTML = parts.join("");
  el.stats.classList.toggle("empty", parts.length === 0 && el.statsActions.hidden);
}

// ------------------------------------------------- model / thinking picker

function resetModelControls() {
  state.models = [];
  state.thinkingLevels = [];
  state.modelLabel = null;
  state.thinkingLevel = null;
  el.modelSelect.innerHTML = "";
  el.modelSelect.hidden = true;
  el.modelSelect.disabled = false;
  el.thinkingSelect.innerHTML = "";
  el.thinkingSelect.hidden = true;
  el.thinkingSelect.disabled = false;
  el.statsActions.hidden = true;
}

/**
 * The picker needs the child process, so it only exists while a session stream
 * is open; on failure the labels in the header still say what is active.
 */
async function loadModelControls() {
  const sessionPath = state.path;
  if (!sessionPath) return;
  let data;
  try {
    data = await api.models(sessionPath);
  } catch {
    return;
  }
  if (state.path !== sessionPath) return;

  state.models = Array.isArray(data.models) ? data.models : [];
  state.thinkingLevels = Array.isArray(data.thinkingLevels) ? data.thinkingLevels : [];
  state.modelLabel = data.model ? labelForModel(data.model) : null;
  state.thinkingLevel = data.thinkingLevel ?? null;
  renderModelControls(data.model);
  renderThinkingControl(data.thinkingLevel);
  updateChatMeta();
  renderStats();
}

/** `provider/id` → the `provider/name` form shown in the header. */
function labelForModel(key) {
  const match = state.models.find((model) => `${model.provider}/${model.id}` === key);
  if (!match) return key;
  return `${match.provider}/${match.name || match.id}`;
}

function renderModelControls(current) {
  el.modelSelect.innerHTML = state.models
    .map((model, index) => `<option value="${index}">${esc(`${model.provider}/${model.name || model.id}`)}</option>`)
    .join("");
  const index = state.models.findIndex((model) => `${model.provider}/${model.id}` === current);
  if (index >= 0) el.modelSelect.value = String(index);
  el.modelSelect.hidden = state.models.length < 2;
  el.statsActions.hidden = el.modelSelect.hidden && el.thinkingSelect.hidden;
}

function renderThinkingControl(current) {
  const levels = state.thinkingLevels;
  // Raw enum values (off/low/high/max), matching pi's own vocabulary.
  el.thinkingSelect.innerHTML = levels
    .map((level) => `<option value="${esc(level)}">${esc(level)}</option>`)
    .join("");
  if (current && levels.includes(current)) el.thinkingSelect.value = current;
  // A single level means nothing to choose (most often just "off").
  el.thinkingSelect.hidden = levels.length < 2;
  el.statsActions.hidden = el.modelSelect.hidden && el.thinkingSelect.hidden;
}

/** The header line mirrors the two pickers, so a change is visible there too. */
function updateChatMeta() {
  el.chatMeta.textContent = [
    state.cwd ? prettyPath(state.cwd) : null,
    state.modelLabel,
    state.thinkingLevel ? `thinking: ${state.thinkingLevel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function startStatsTicker() {
  stopStatsTicker();
  state.statsTimer = setInterval(renderStats, 500);
}

function stopStatsTicker() {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }
}

// ------------------------------------------------------------------- copy

function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-secure origins (e.g. opened via a LAN address).
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    ok ? resolve() : reject(new Error("copy failed"));
  });
}

/** Visible prose only: skip thinking blocks and tool activity. */
function messageText(node) {
  return [...node.querySelectorAll(".md")]
    .map((element) => element.innerText.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function handleMessagesClick(event) {
  const placeholder = event.target.closest(".image-placeholder");
  if (placeholder) {
    revealToolImage(placeholder);
    return;
  }

  // Markdown images render at column width; open the full-size file on click.
  const mdImage = event.target.closest("img.md-img-local");
  if (mdImage) {
    window.open(mdImage.src, "_blank", "noopener");
    return;
  }

  const button = event.target.closest(".copy-btn");
  if (!button) return;
  const kind = button.dataset.copy;
  let text = "";
  if (kind === "code") {
    text = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
  } else {
    const message = button.closest(".msg");
    text = message ? messageText(message) : "";
  }
  if (!text) return;

  const original = button.textContent;
  try {
    await copyTextToClipboard(text);
    button.textContent = "已复制";
    button.classList.add("copied");
  } catch {
    button.textContent = "复制失败";
    button.classList.add("failed");
  }
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied", "failed");
  }, 1200);
}

/** Swap a tool-image placeholder for the real image, fetching it only now. */
function revealToolImage(placeholder) {
  const src = placeholder.dataset.image;
  if (!src) return;
  const image = document.createElement("img");
  image.src = src;
  image.alt = "工具返回的图片";
  image.loading = "lazy";
  image.decoding = "async";
  image.className = "tool-image";
  placeholder.replaceWith(image);
}

// ---------------------------------------------------------------- composer

function renderAttachments() {
  el.attachments.innerHTML = "";
  state.attachments.forEach((att, index) => {
    const node = document.createElement("div");
    node.className = "attachment";
    node.innerHTML = `<img src="${att.dataUrl}" alt="附件" />`;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.onclick = () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    };
    node.appendChild(remove);
    el.attachments.appendChild(node);
  });
}

function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      state.attachments.push({
        dataUrl,
        mimeType: file.type || "image/png",
        data: dataUrl.slice(comma + 1),
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

async function sendMessage() {
  if (!state.path) return;
  const text = el.input.value.trim();
  const images = state.attachments.map((att) => ({ type: "image", data: att.data, mimeType: att.mimeType }));
  if (!text && images.length === 0) return;

  addMessage({ role: "user", content: text ? renderUserContent(text, images) : images });
  el.input.value = "";
  autoGrow();
  state.attachments = [];
  renderAttachments();

  try {
    await api.prompt(state.path, text, images.length ? images : undefined);
  } catch (error) {
    addNotice(`发送失败：${error.message}`, "error");
    setStatus("idle");
  }
}

function renderUserContent(text, images) {
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) blocks.push(image);
  return blocks;
}

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

async function refreshSessionList() {
  try {
    const data = await api.sessions();
    state.home = data.home;
    state.folders = data.folders;
    state.sessions = data.sessions;
    renderFolders();
    renderSessions();
    syncChatTitle();
  } catch {
    /* ignore */
  }
}

/** Keep the header title in step with a rename or a pending session's first message. */
function syncChatTitle() {
  const current = state.sessions.find((session) => session.path === state.path);
  if (current && !current.pending) el.chatTitle.textContent = current.title;
}

/** Create a session in `cwd`, then select its folder and open it. */
async function createSession(cwd) {
  if (!cwd) return;
  try {
    const created = await api.newSession(cwd);
    await refreshSessionList();
    await selectFolder(created.cwd);
    await openSession({
      path: created.path,
      cwd: created.cwd,
      title: "新会话",
      pending: true,
    });
    el.input.focus();
  } catch (error) {
    window.alert(error.message);
  }
}

/** Ask which folder to create the session in. */
function promptForFolder() {
  const suggestion = state.cwd || state.home || "~";
  const answer = window.prompt("在哪个文件夹新建会话？（输入绝对路径）", suggestion);
  if (answer === null) return;
  const cwd = answer.trim();
  if (cwd) createSession(cwd);
}

/**
 * Rename via `set_session_name`. Needs the session open (the RPC goes through
 * its pi subprocess); opening first keeps the flow one click from the list.
 * pi strips newlines itself, so a single-line prompt is enough.
 */
async function renameSession(session, node) {
  const current = session.name || session.title;
  const answer = window.prompt("重命名会话", current);
  if (answer === null) return;
  const name = answer.trim();
  if (!name || name === current) return;

  if (state.path !== session.path) {
    await openSession(session);
  }
  try {
    await api.rename(session.path, name);
    // `session_info_changed` arrives over the stream and refreshes the list,
    // but only when this session's stream is live; refresh for the rest.
    await refreshSessionList();
  } catch (error) {
    window.alert(`重命名失败：${error.message}`);
  }
}

/**
 * Delete a session (trash when available, else unlink). Deleting the open
 * session also closes its stream so the dead pi subprocess is reaped.
 */
async function deleteSession(session) {
  const label = session.title.length > 40 ? `${session.title.slice(0, 40)}…` : session.title;
  const ok = window.confirm(`删除会话「${label}」？\n${prettyPath(session.cwd)} · 该操作可在废纸篓找回（如装有 trash）。`);
  if (!ok) return;

  try {
    await api.deleteSession(session.path);
    if (state.path === session.path) {
      closeStream();
      state.path = null;
      el.messages.innerHTML = "";
      el.chatTitle.textContent = "选择一个会话";
      el.chatMeta.textContent = "";
    }
    await refreshSessionList();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

/**
 * Delete every session under one folder (files only — the directory itself and
 * its non-session content are untouched; trashed files stay recoverable).
 * Deleting the folder that holds the open session also closes its stream.
 */
async function deleteFolderSessions(folder) {
  const label = prettyPath(folder.cwd);
  const ok = window.confirm(
    `删除「${label}」下的全部 ${folder.sessionCount} 个会话？\n\n` +
      `只删会话文件（进废纸篓可找回），目录本身和里面的其他文件不会动。`,
  );
  if (!ok) return;

  try {
    const result = await api.deleteFolderSessions(folder.cwd);
    const inThisFolder = state.path && state.sessions.some((s) => s.path === state.path && s.cwd === folder.cwd);
    if (inThisFolder) {
      closeStream();
      state.path = null;
      el.messages.innerHTML = "";
      el.chatTitle.textContent = "选择一个会话";
      el.chatMeta.textContent = "";
    }
    if (state.cwd === folder.cwd) state.cwd = null;
    await refreshSessionList();
    window.alert(`已删除 ${result.deleted} 个会话。`);
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

function bind() {
  el.send.onclick = sendMessage;
  el.abort.onclick = async () => {
    if (state.path) await api.abort(state.path);
  };
  el.attach.onclick = () => el.file.click();
  el.file.onchange = () => {
    addFiles(el.file.files);
    el.file.value = "";
  };
  el.refresh.onclick = refreshSessionList;
  el.messages.addEventListener("click", handleMessagesClick);
  el.newSession.onclick = () => (state.cwd ? createSession(state.cwd) : promptForFolder());
  el.newFolder.onclick = promptForFolder;

  el.modelSelect.onchange = async () => {
    const model = state.models[Number(el.modelSelect.value)];
    if (!model || !state.path) return;
    el.modelSelect.disabled = true;
    try {
      await api.setModel(state.path, model.provider, model.id);
      // The new model may support a different set of thinking levels.
      await loadModelControls();
    } catch (error) {
      addNotice(`错误：${error.message}`, "error");
    } finally {
      el.modelSelect.disabled = false;
    }
  };

  el.thinkingSelect.onchange = async () => {
    if (!state.path) return;
    const level = el.thinkingSelect.value;
    el.thinkingSelect.disabled = true;
    try {
      await api.setThinking(state.path, level);
      state.thinkingLevel = level;
      updateChatMeta();
    } catch (error) {
      addNotice(`错误：${error.message}`, "error");
    } finally {
      el.thinkingSelect.disabled = false;
    }
  };

  el.input.addEventListener("input", autoGrow);
  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  el.input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    el.dropHint.classList.remove("hidden");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth -= 1;
    if (dragDepth <= 0) el.dropHint.classList.add("hidden");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    el.dropHint.classList.add("hidden");
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });
}

async function main() {
  bind();
  initSidebar();
  await refreshSessionList();
  if (state.folders.length > 0) {
    await selectFolder(state.folders[0].cwd);
    const first = state.sessions.filter((s) => s.cwd === state.folders[0].cwd)[0];
    if (first) await openSession(first);
  } else {
    el.chatTitle.textContent = "还没有会话";
    el.chatMeta.textContent = state.home ? `点击左上角 ＋ 在 ${prettyPath(state.home)} 等目录新建会话` : "";
    addNotice("还没有任何会话。点左上角 ＋ 选个文件夹开始。");
  }
}

main();

// Exposed so the automated UI checks can assert on internal state.
globalThis.piShellDebug = {
  state,
  currentSpeed,
  estimateTokens,
  fmtTokens,
  fmtCost,
  messageText,
  renderMarkdown,
  localImageSrc,
};
