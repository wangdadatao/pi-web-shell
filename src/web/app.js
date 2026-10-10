/* global EventSource, fetch, document, window, FileReader, requestAnimationFrame */

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import { LOCALES, getLocale, setLocale, t } from "./i18n.js";
import { continuesList, findStableEnd } from "./liveMarkdown.js";

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
    if (!res.ok) throw new Error(t("api.sessionsFailed", { status: res.status }));
    return res.json();
  },
  async prompt(path, message, images) {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, message, images }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.promptFailed", { status: res.status }));
    return data;
  },
  async abort(path) {
    const res = await fetch("/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json().catch(() => ({}));
    // Ignoring this made a failed stop look like a successful one: the button
    // stayed greyed out while the run kept going.
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  /**
   * Answer one blocking extension dialog. Best-effort by design: the request
   * may already be gone (a timeout on pi's side, or a replaced subprocess), and
   * a dead session shows up on the stream rather than here.
   */
  async uiResponse(path, payload) {
    const res = await fetch("/api/ui-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  async models(path) {
    const res = await fetch(`/api/models?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(t("api.modelsFailed", { status: res.status }));
    return res.json();
  },
  async commands(path) {
    const res = await fetch(`/api/commands?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(t("api.commandsFailed", { status: res.status }));
    return res.json();
  },
  async setModel(path, provider, modelId) {
    const res = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, provider, modelId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.setModelFailed", { status: res.status }));
    return data;
  },
  async setThinking(path, level) {
    const res = await fetch("/api/thinking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, level }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.setThinkingFailed", { status: res.status }));
    return data;
  },
  /** Settings page: cross-session token totals (read-only). */
  async settingsUsage() {
    const res = await fetch("/api/settings/usage");
    // A 404 here almost always means the server process is older than this
    // page — the frontend is served from disk, so a reload shows new UI first.
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    if (!res.ok) throw new Error(t("api.usageFailed", { status: res.status }));
    return res.json();
  },
  /** Settings page: what pi will load (read-only). */
  async settingsEnvironment() {
    const res = await fetch("/api/settings/environment");
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    if (!res.ok) throw new Error(t("api.environmentFailed", { status: res.status }));
    return res.json();
  },
  /** Whitelisted patch against pi's settings.json; see settingsStore.ts. */
  async saveSettings(patch) {
    const res = await fetch("/api/settings/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.saveSettingsFailed", { status: res.status }));
    return data;
  },
  /** Replace the agent dir's AGENTS.md (global instructions). */
  async saveAgentsMd(content) {
    const res = await fetch("/api/settings/agents-md", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.agentsMdFailed", { status: res.status }));
    return data;
  },
  /** Toggle one MCP server's enabled flag in mcp.json. */
  async setMcpEnabled(name, enabled) {
    const res = await fetch("/api/settings/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    });
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.mcpFailed", { status: res.status }));
    return data;
  },
  /** Branch tree of the open session (light reshape of pi's get_tree). */
  async tree(path) {
    const res = await fetch(`/api/tree?path=${encodeURIComponent(path)}`);
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    if (!res.ok) throw new Error(t("api.treeFailed", { status: res.status }));
    return res.json();
  },
  /**
   * Fork a new branch from a past user message.
   *
   * `target` is `{ entryId }` (the tree panel knows the id) or `{ fromEnd }`
   * (the transcript counts user messages back from the last one, because the
   * model-facing messages carry no entry ids).
   */
  async fork(path, target) {
    const res = await fetch("/api/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...target }),
    });
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.forkFailed", { status: res.status }));
    return data;
  },
  /** Duplicate the active branch into a new session. */
  async clone(path) {
    const res = await fetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (res.status === 404) throw new Error(t("api.serverOutdated"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.cloneFailed", { status: res.status }));
    return data;
  },
  async newSession(cwd) {
    const res = await fetch("/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.newSessionFailed", { status: res.status }));
    return data;
  },
  async rename(path, name) {
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.renameFailed", { status: res.status }));
    return data;
  },
  async deleteSession(path) {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.deleteFailed", { status: res.status }));
    return data;
  },
  async deleteFolderSessions(cwd) {
    const res = await fetch("/api/delete-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("api.deleteFailed", { status: res.status }));
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
  treeBtn: document.getElementById("tree-btn"),
  treePanel: document.getElementById("tree-panel"),
  treeBody: document.getElementById("tree-body"),
  treeClose: document.getElementById("tree-close"),
  treeClone: document.getElementById("tree-clone"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
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
  app: document.getElementById("app"),
  settings: document.getElementById("settings"),
  settingsBack: document.getElementById("settings-back"),
  settingsMenu: document.getElementById("settings-menu"),
  settingsBody: document.getElementById("settings-body"),
  heatTip: document.getElementById("heat-tip"),
  extStatus: document.getElementById("ext-status"),
  extWidgetAbove: document.getElementById("ext-widget-above"),
  extWidgetBelow: document.getElementById("ext-widget-below"),
  toasts: document.getElementById("ui-toasts"),
  dialog: document.getElementById("ui-dialog"),
  dialogTitle: document.getElementById("ui-dialog-title"),
  dialogBody: document.getElementById("ui-dialog-body"),
  dialogActions: document.getElementById("ui-dialog-actions"),
  commandMenu: document.getElementById("command-menu"),
  commandList: document.getElementById("command-list"),
};

const state = {
  home: null,
  folders: [],
  sessions: [],
  cwd: null,
  path: null,
  stream: null,
  /** Consecutive reconnect attempts for the current session stream. */
  streamRetries: 0,
  /** True once the stream is finished for good; stops the reconnect timer. */
  streamEnded: false,
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
  /** "chat" or "settings" — which top-level view owns the window. */
  view: "chat",
  /** Theme preference: "system" | "dark" | "light" (see initPreferences). */
  theme: "system",
  settingsSection: "usage",
  /** Model filter on the token tab: "" means every model. */
  usageModel: "",
  /** Lazily fetched, read-only payloads for the settings page. */
  settingsData: { usage: null, environment: null },
  /** Last settings.json save result; re-renders must not lose the message. */
  settingsSaveStatus: null,
  /** Same for the AGENTS.md editor. */
  agentsMdStatus: null,
  /** Branch tree payload + which collapsed branches are expanded. */
  tree: null,
  treeExpanded: new Set(),
  /** Payload being fetched right now, so we never ask twice. */
  pendingKey: null,
  /** Payload that failed, so we do not retry in a loop. */
  failedKey: null,
  settingsError: null,
  // The speed readout is scoped to one assistant message: the clock starts at its
  // first delta and both counters are reset on every message_start.
  streamStart: 0,
  streamReportedTokens: 0,
  streamEstimatedTokens: 0,
  statsTimer: null,
  lastSpeed: null,
  loadTimer: null,
  /** Title from index.html, restored when an extension clears its own. */
  defaultTitle: "pi-web-shell",
  /**
   * Sessions that finished a run while unopened. Drives the `(n)` title badge;
   * opening the session or seeing it start again clears its entry.
   */
  unreadDone: new Set(),
  /** Paths whose finish the user asked for (clicked stop): not news to them. */
  abortedPaths: new Set(),
  /** Pending `waitForIdle` resolvers, fired on the next `agent_settled`. */
  settleWaiters: new Set(),
  /** Wall-clock ms the current turn's user message was sent; 0 when idle. */
  turnStartMs: 0,
  /** Input/output tokens so far this turn (all rounds), for the footer. */
  turnInput: 0,
  turnOutput: 0,
  /** Bubble + usage of the latest assistant text reply, for the footer stats. */
  lastReply: null,
  /**
   * Extension UI state (`setStatus` / `setWidget` / `setTitle`). Keyed maps, not
   * a single value: several extensions can own distinct keys, and a session
   * switch resets the whole set.
   */
  extension: {
    status: new Map(),
    widgets: { aboveEditor: new Map(), belowEditor: new Map() },
    title: null,
  },
  /** Dialog currently on screen: `{ path, request }`, or null. */
  dialog: null,
  /** Dialogs waiting behind the open one, in arrival order. */
  dialogQueue: [],
  /** Auto-close timer for a dialog that came with a `timeout`. */
  dialogTimer: null,
  /** Slash commands for the open session, and the menu's current filter. */
  commands: [],
  commandMatches: [],
  commandIndex: 0,
  commandQuery: null,
};

// ---------------------------------------------------------------- rendering

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Markdown → sanitized HTML fragment (no wrapper), for incremental assembly. */
function renderMarkdownHtml(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(String(text)));
}

/** Render model/user prose as sanitized Markdown. */
function renderMarkdown(text) {
  if (!text) return "";
  return `<div class="md">${renderMarkdownHtml(text)}</div>`;
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
      if (language === "mermaid") return renderMermaidBlock(code);
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
        `<button class="copy-btn" type="button" data-copy="code" aria-label="${t("common.copyCode")}">${t("common.copy")}</button></div>` +
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

/**
 * A ```mermaid fence becomes a placeholder, not a diagram.
 *
 * Markdown is sanitized as a string before it reaches the DOM, but mermaid is
 * async and needs a live element, so the fence body is kept next to the canvas
 * and `renderMermaidDiagrams()` fills the canvas in later. The source has to
 * live in the DOM as text: DOMPurify drops any attribute whose value contains
 * a comment terminator, which rules out the obvious `data-mermaid="..."` trick
 * because `-->` is the one thing every diagram has. Keeping it in the DOM also
 * gives the copy button something to read for rendered and failed blocks alike.
 */
function renderMermaidBlock(source) {
  return (
    `<div class="mermaid-block">` +
    `<div class="code-head"><span class="code-lang">mermaid</span>` +
    `<button class="copy-btn" type="button" data-copy="diagram" aria-label="${t("common.copyDiagram")}">${t("common.copy")}</button></div>` +
    `<div class="mermaid-body"><span class="mermaid-pending">${t("mermaid.rendering")}</span></div>` +
    `<pre class="mermaid-source" hidden><code>${esc(source)}</code></pre>` +
    `</div>`
  );
}

// ----------------------------------------------------------------- mermaid

/** `mermaid` is a classic script loaded on demand; absent means it failed. */
function mermaidApi() {
  const api = globalThis.mermaid;
  return api && typeof api.render === "function" ? api : null;
}

let mermaidReady = false;
let mermaidSerial = 0;
/** Mermaid keeps global state, so renders are serialized through one chain. */
let mermaidQueue = Promise.resolve();
/** The 3.4 MB bundle is fetched the first time a diagram shows up, not on load. */
let mermaidLoading = null;

function loadMermaid() {
  if (mermaidApi()) return Promise.resolve(mermaidApi());
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "/vendor/mermaid.min.js";
      script.addEventListener("load", () => resolve(mermaidApi()));
      script.addEventListener("error", () => resolve(null));
      document.head.appendChild(script);
    });
  }
  return mermaidLoading;
}

function initMermaid() {
  const api = mermaidApi();
  if (!api) return null;
  if (!mermaidReady) {
    api.initialize({
      startOnLoad: false,
      // Labels are escaped and `click` handlers disabled — diagram source is
      // model output, so it gets the same distrust as everything else.
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "inherit",
    });
    mermaidReady = true;
  }
  return api;
}

/** Queue a render for every not-yet-processed diagram under `root`. */
function scheduleMermaid(root) {
  const targets = root.querySelectorAll ? [...root.querySelectorAll(".mermaid-body")] : [];
  if (root.matches?.(".mermaid-body")) targets.unshift(root);
  if (targets.length === 0) return;
  mermaidQueue = mermaidQueue
    .then(() => renderMermaidDiagrams(targets))
    .catch(() => {});
}

function mermaidSource(canvas) {
  return canvas.closest(".mermaid-block")?.querySelector(".mermaid-source code")?.textContent ?? "";
}

async function renderMermaidDiagrams(targets) {
  if (!initMermaid()) await loadMermaid();
  const api = initMermaid();
  for (const node of targets) {
    // A streamed `text_end` can replace the bubble while we wait our turn.
    if (node.dataset.mermaidState || !node.isConnected) continue;
    const source = mermaidSource(node);
    node.dataset.mermaidState = "rendering";
    if (!api) {
      failMermaid(node, t("mermaid.notLoaded"));
      continue;
    }
    const id = `pi-mermaid-${(mermaidSerial += 1)}`;
    try {
      const { svg } = await api.render(id, source);
      node.innerHTML = svg;
      node.dataset.mermaidState = "done";
    } catch (error) {
      // Mermaid parks its own error graphic in the body; ours replaces it.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      failMermaid(node, error instanceof Error ? error.message : String(error));
    }
  }
}

/** A failed diagram shows why, next to the source it could not parse. */
function failMermaid(node, message) {
  node.dataset.mermaidState = "failed";
  const note = document.createElement("div");
  note.className = "mermaid-error";
  const first = String(message).split("\n")[0].slice(0, 200);
  note.textContent = t("mermaid.failed", { message: first });
  node.replaceChildren(note);
  const source = node.closest(".mermaid-block")?.querySelector(".mermaid-source");
  if (source) source.hidden = false;
}

/**
 * Mermaid cannot run inside the marked renderer (it is async and needs a live
 * node), so the message list is watched instead. Every path that renders
 * Markdown — history load, streamed `text_end`, finalize — lands here, and the
 * per-node state flag keeps repeated renders of the same block idempotent.
 */
function observeMermaid() {
  new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType === 1) scheduleMermaid(added);
      }
    }
  }).observe(el.messages, { childList: true, subtree: true });
}

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
  return `<details class="thinking-block"${open ? " open" : ""}><summary>${t("msg.thinking")}</summary><div class="thinking-body">${esc(text)}</div></details>`;
}

function renderImage(block) {
  const src = imageSrc(block);
  if (!src) return "";
  // width/height let the browser reserve space, so scrolling does not jump
  // while images stream in.
  const size =
    block.width && block.height ? ` width="${Number(block.width)}" height="${Number(block.height)}"` : "";
  return `<img src="${esc(src)}" alt="${t("msg.image")}" loading="lazy" decoding="async"${size} />`;
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
    `title="${t("msg.clickToLoad")}">${esc(label)}${esc(bytes)}</button>`
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
  const label = isError
    ? t("msg.toolFailed", { name: esc(name) })
    : t("msg.toolTool", { name: esc(name) });
  return `<details class="tool-chip${isError ? " error" : ""}"${open ? " open" : ""}><summary class="tool-name">${label}</summary>${body}</details>`;
}

/**
 * Bottom action row for one message. Icon-only, and CSS floats it just below
 * the bubble with `position: absolute`, so it never adds height to the bubble
 * (an `opacity: 0` row *inside* the bubble made every message taller).
 *
 * No index is baked in: "which user message" is only knowable at click time,
 * because a message sent after this one rendered would make a stored index
 * point at the wrong entry. The click handler counts the user bubbles itself.
 */
function userActions(timestamp) {
  const time = timestamp ? `<span class="msg-meta msg-time">${esc(fmtClock(timestamp))}</span>` : "";
  return (
    `<div class="msg-actions">${time}` +
    `<button class="msg-act" type="button" data-msg-action="edit" title="${esc(t("msg.editResend"))}" aria-label="${esc(t("msg.editResend"))}">✎</button>` +
    `<button class="msg-act danger" type="button" data-msg-action="delete" title="${esc(t("msg.deleteResend"))}" aria-label="${esc(t("msg.deleteResend"))}">🗑</button>` +
    `<button class="msg-act" type="button" data-copy="message" title="${esc(t("common.copyMessage"))}" aria-label="${esc(t("common.copyMessage"))}">📋</button>` +
    `</div>`
  );
}

/** Copy moved out of the bubble head; the per-reply stats trail it. */
function assistantActions(meta) {
  return (
    `<div class="msg-actions">` +
    `<button class="msg-act" type="button" data-copy="message" title="${esc(t("common.copyMessage"))}" aria-label="${esc(t("common.copyMessage"))}">📋</button>` +
    (meta ? metaHtml(meta) : "") +
    `</div>`
  );
}

/** "用时 12.3s · 输入 11.7k / 输出 40.8k · 2026-10-09 17:32:21", minus unknowns. */
function metaHtml(meta) {
  const parts = [];
  if (Number.isFinite(meta.durationMs)) parts.push(`${t("msg.replyDuration")} ${fmtDuration(meta.durationMs)}`);
  if (Number.isFinite(meta.input) && Number.isFinite(meta.output)) {
    parts.push(t("msg.replyTokens", { input: fmtTokens(meta.input), output: fmtTokens(meta.output) }));
  }
  if (meta.endMs) parts.push(fmtClock(meta.endMs));
  const visible = parts.filter(Boolean);
  if (visible.length === 0) return "";
  return `<span class="msg-meta" title="${esc(t("msg.replyMetaTitle"))}">${visible.map(esc).join(" · ")}</span>`;
}

function messageNode(role, content, opts = {}) {
  const node = document.createElement("div");
  node.className = `msg ${role}${opts.isLast ? " is-last" : ""}`;
  if (role === "user") {
    node.innerHTML =
      `<div class="role-tag">${t("msg.you")}</div>${renderContent(content)}${userActions(opts.timestamp)}`;
  } else if (role === "assistant") {
    node.innerHTML = `${assistantHead()}${renderContent(content)}${assistantActions(opts.meta ?? null)}`;
  } else {
    node.innerHTML = renderContent(content);
  }
  return node;
}

function assistantHead() {
  return `<div class="msg-head"><span class="role-tag">pi</span></div>`;
}

function addMessage(msg) {
  const role = msg && msg.role ? msg.role : "notice";
  if (role === "system") return;
  closeToolGroup();
  // The reply that was "last" is not any more: drop its always-on footer so it
  // cannot float over the message we are about to add (it stays on hover).
  for (const node of el.messages.querySelectorAll(".msg.assistant.is-last")) node.classList.remove("is-last");
  // A just-sent message is the newest, so it is 0 back from the end; earlier
  // bubbles keep their own count from the render pass.
  el.messages.appendChild(
    messageNode(role, msg.content, role === "user" ? { timestamp: msg.timestamp ?? Date.now() } : {}),
  );
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
  if (group.hasThinking) head.push(t("group.thinking"));
  if (group.names.length > 0) head.push(t("group.toolCalls", { count: group.names.length }));

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
  return `<details class="tool-result"><summary>${t("msg.toolResult", { name })}${msg.isError ? t("msg.errorSuffix") : ""}</summary>${renderToolResultContent(msg.content)}</details>`;
}

/** Fresh (non-cached) input and generated output of one assistant message. */
function usageTokens(message) {
  const usage = message && message.usage ? message.usage : null;
  return {
    input: usage && typeof usage.input === "number" ? usage.input : 0,
    output: usage && typeof usage.output === "number" ? usage.output : 0,
  };
}

/**
 * Per-reply footer stats.
 *
 * `input` / `output` are the **whole turn's** totals, summed over every
 * assistant message between the user prompt and the end — a tool-heavy turn is
 * dozens of model calls, so the final message alone under-reports badly (a real
 * turn: last message 575, whole turn 40,839). Duration and end time come from
 * wall-clock timestamps.
 */
function replyMeta(startMs, message, input, output) {
  const endMs = message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return {
    durationMs: startMs && endMs && endMs >= startMs ? endMs - startMs : NaN,
    input: Number.isFinite(input) ? input : NaN,
    output: Number.isFinite(output) ? output : NaN,
    endMs,
  };
}

/** Render a stored transcript, grouping consecutive tool activity. */
function renderHistory(messages) {
  state.toolGroup = null;
  state.toolEntryIndex = new Map();
  state.lastReply = null;
  // Only the final text reply keeps its stats visible; older ones reveal them
  // on hover. The last message has nothing below it, so it cannot overlap.
  let lastTextIndex = -1;
  messages.forEach((m, i) => {
    if (m && m.role === "assistant" && splitAssistant(m.content).hasText) lastTextIndex = i;
  });
  let turnStartMs = 0;
  let turnInput = 0;
  let turnOutput = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    const role = msg && msg.role ? msg.role : "notice";
    if (role === "system") continue;

    if (role === "user") {
      closeToolGroup();
      turnStartMs = typeof msg.timestamp === "number" ? msg.timestamp : 0;
      turnInput = 0;
      turnOutput = 0;
      el.messages.appendChild(messageNode("user", msg.content, { timestamp: msg.timestamp }));
      continue;
    }

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
      // Every round of the turn counts, not just the one that produced text.
      const round = usageTokens(msg);
      turnInput += round.input;
      turnOutput += round.output;
      const { prose, tools, hasText } = splitAssistant(msg.content);
      if (hasText) {
        closeToolGroup();
        el.messages.appendChild(
          messageNode("assistant", prose, {
            meta: replyMeta(turnStartMs, msg, turnInput, turnOutput),
            isLast: index === lastTextIndex,
          }),
        );
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

// ---------------------------------------------------------------- branch tree

/**
 * The branch tree of the open session, as a light overlay panel.
 *
 * Read-mostly: the tree comes from pi's get_tree (reshaped server-side), and
 * the two write actions map straight onto RPC commands — fork from any past
 * user message, clone the active branch into a new session. Both refresh the
 * transcript by re-attaching the SSE stream, which re-reads the snapshot.
 */
async function openTreePanel() {
  if (!state.path) return;
  el.treePanel.hidden = false;
  el.treeBody.innerHTML = `<div class="settings-empty">${esc(t("tree.loading"))}</div>`;
  state.treeExpanded = new Set();
  try {
    state.tree = await api.tree(state.path);
    renderTree();
  } catch (error) {
    el.treeBody.innerHTML = `<div class="settings-empty">${esc(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  }
}

function closeTreePanel() {
  el.treePanel.hidden = true;
  state.tree = null;
}

/**
 * Lay the forest out as one flat spine of turns plus collapsed branch chips.
 *
 * The spine is the active root-to-leaf chain (the first root when nothing is
 * active); every side child folds into a "⑂ branch" chip, expandable on
 * click. Inside an expanded branch the same layout recurses, with the first
 * child standing in for the missing active path. One turn = one user message
 * plus the replies that followed it, so a linear session renders as a flat
 * list instead of a staircase.
 */
function renderTree() {
  const view = state.tree;
  if (!view) return;
  if (!view.nodes || view.nodes.length === 0) {
    el.treeBody.innerHTML = `<div class="settings-empty">${esc(t("tree.empty"))}</div>`;
    return;
  }
  el.treeBody.innerHTML = "";
  renderTreeNodes(view.nodes, el.treeBody, false);
}

function renderTreeNodes(nodes, container, followFirst) {
  const spineRoot = nodes.find((node) => node.active) ?? nodes[0];
  for (const root of nodes) {
    if (root !== spineRoot) container.appendChild(branchDom(root));
  }

  // The linear spine: follow active children (first children inside a branch).
  const chain = [];
  for (let node = spineRoot; node; ) {
    chain.push(node);
    const kids = node.children || [];
    node = kids.find((kid) => kid.active) ?? (followFirst ? kids[0] : undefined);
  }

  // Group the spine into turns; side children hang off the turn that owns
  // their fork point, so each chip sits right below the conversation turn
  // where the split happened.
  const turns = [];
  let turn = null;
  for (let index = 0; index < chain.length; index += 1) {
    const node = chain[index];
    if (node.kind === "user" || !turn) {
      turn = { user: node.kind === "user" ? node : null, replies: [], labels: [], branches: [] };
      turns.push(turn);
    }
    if (node.kind !== "user") turn.replies.push(node);
    if (node.label) turn.labels.push(node.label);
    for (const kid of node.children || []) {
      if (kid !== chain[index + 1]) turn.branches.push(kid);
    }
  }

  for (const item of turns) {
    container.appendChild(turnDom(item));
    for (const branch of item.branches) container.appendChild(branchDom(branch));
  }
}

function turnDom(turn) {
  const row = document.createElement("div");
  const onActivePath = turn.user ? turn.user.active : turn.replies[0]?.active === true;
  row.className = `tree-turn${onActivePath ? " active" : ""}`;
  if (turn.user) row.dataset.entryId = turn.user.id;

  const main = document.createElement("div");
  main.className = "tree-row";
  const who = turn.user ? t("msg.you") : "·";
  main.innerHTML = `<span class="tree-who">${esc(who)}</span><span class="tree-preview">${esc(
    turn.user ? turn.user.preview : "…",
  )}</span>`;
  for (const label of turn.labels.slice(0, 2)) {
    const chip = document.createElement("span");
    chip.className = "tree-label";
    chip.textContent = label;
    main.appendChild(chip);
  }
  if (turn.user) {
    const forkButton = document.createElement("button");
    forkButton.className = "tree-fork";
    forkButton.type = "button";
    forkButton.textContent = t("tree.fork");
    forkButton.onclick = () => forkFrom(turn.user.id, forkButton);
    main.appendChild(forkButton);
  }
  row.appendChild(main);

  if (turn.replies.length > 0) {
    const sub = document.createElement("div");
    sub.className = "tree-sub";
    sub.textContent = turn.replies.map((reply) => reply.preview).join(" / ");
    row.appendChild(sub);
  }
  return row;
}

function branchDom(root) {
  const wrap = document.createElement("div");
  wrap.className = "tree-branch-wrap";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "tree-branch-chip";
  chip.dataset.branchId = root.id;
  const label = document.createElement("span");
  label.className = "tree-branch-mark";
  label.textContent = "⑂";
  chip.appendChild(label);
  chip.appendChild(document.createTextNode(t("tree.branch", { count: countTreeEntries(root) })));
  const preview = document.createElement("span");
  preview.className = "tree-preview";
  preview.textContent = root.preview;
  chip.appendChild(preview);
  chip.onclick = () => {
    if (state.treeExpanded.has(root.id)) state.treeExpanded.delete(root.id);
    else state.treeExpanded.add(root.id);
    renderTree();
  };
  wrap.appendChild(chip);
  if (state.treeExpanded.has(root.id)) {
    const inner = document.createElement("div");
    inner.className = "tree-branch-children";
    renderTreeNodes([root], inner, true);
    wrap.appendChild(inner);
  }
  return wrap;
}

function countTreeEntries(node) {
  let total = 1;
  for (const kid of node.children || []) total += countTreeEntries(kid);
  return total;
}

/**
 * Edit / delete a user message and resend: pi's own "go back to before this
 * message" move (the `/tree` select-then-submit flow), driven from the bubble
 * instead of the branch panel. It is a fork, not an in-place delete: the
 * abandoned text stays in the session file as a side branch, it just stops
 * being part of the context the model sees.
 */
async function forkFromTranscript(fromEnd, edit, hasImages) {
  if (!state.path) return;
  const path = state.path;
  try {
    // Forking mid-run would tear the agent down under an in-flight turn; stop
    // first and let it settle so the branch point is stable.
    if (state.streaming) {
      await api.abort(path);
      await waitForIdle();
    }
    const result = await api.fork(path, { fromEnd });
    if (result.cancelled) {
      addNotice(t("tree.forkCancelled"));
      return;
    }
    // The active branch moved; the snapshot (and transcript) must follow.
    await followFork(result);
    if (edit) {
      el.input.value = typeof result.text === "string" ? result.text : "";
      autoGrow();
      addNotice(hasImages ? t("msg.editedNoImages") : t("msg.edited"));
    } else {
      addNotice(t("msg.deleted"));
    }
    el.input.focus();
  } catch (error) {
    addNotice(t("common.error", { message: error.message }), "error");
  }
}

/**
 * Point the tab at the branch the fork actually left us on.
 *
 * Usually that is the same session file (the leaf just moved). But forking the
 * very first message has no parent to rewind to, so pi re-roots into a **new**
 * session file; ignoring that would leave the tab writing the old file under
 * the old name.
 */
async function followFork(result) {
  if (!result || !result.sessionFile) {
    refreshActiveSession();
    return;
  }
  await refreshSessionList();
  let next = state.sessions.find((s) => s.path === result.sessionFile);
  if (!next) {
    // The fork just wrote the file; the index can lag a beat behind. Build a
    // summary with every field the sidebar reads (title/pending/running/
    // updatedAt) and insert it, so the row renders instead of flickering.
    next = {
      path: result.sessionFile,
      cwd: state.cwd,
      title: t("chat.newSessionTitle"),
      updatedAt: new Date().toISOString(),
      pending: false,
      running: false,
    };
    state.sessions.push(next);
    renderSessions();
  }
  openSession(next);
}

/** Resolve every pending `waitForIdle` (settle, timeout, or session switch). */
function resolveSettleWaiters() {
  for (const waiter of state.settleWaiters) waiter();
  state.settleWaiters.clear();
}

function waitForIdle(timeoutMs = 5000) {
  if (!state.streaming) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      state.settleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    state.settleWaiters.add(done);
  });
}

async function forkFrom(entryId, button) {
  if (!state.path) return;
  button.disabled = true;
  try {
    const result = await api.fork(state.path, { entryId });
    closeTreePanel();
    if (result.cancelled) {
      addNotice(t("tree.forkCancelled"));
      return;
    }
    addNotice(t("tree.forked"));
    // The active branch changed under us; re-attach the stream so the
    // snapshot (and the transcript) reflect the forked branch.
    await followFork(result);
  } catch (error) {
    button.disabled = false;
    addNotice(t("common.error", { message: error.message }), "error");
  }
}

async function cloneActiveSession() {
  if (!state.path) return;
  el.treeClone.disabled = true;
  try {
    const result = await api.clone(state.path);
    closeTreePanel();
    if (result.cancelled) {
      addNotice(t("tree.cloneCancelled"));
      return;
    }
    addNotice(t("tree.cloned"));
    await refreshSessionList();
    refreshActiveSession();
  } catch (error) {
    addNotice(t("common.error", { message: error.message }), "error");
  } finally {
    el.treeClone.disabled = false;
  }
}

/** Re-attach the SSE stream of the session already selected: new snapshot. */
function refreshActiveSession() {
  if (!state.path) return;
  closeStream();
  openSessionStream({ path: state.path });
}

// ---------------------------------------------------------------- lightbox

/** Full-size view for any image in the transcript (tool images stay capped
 * inline; the click opens the real pixels without leaving the app). */
function openLightbox(src) {
  el.lightboxImg.src = src;
  el.lightbox.hidden = false;
}

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lightboxImg.src = "";
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

/** Local wall clock, "YYYY-MM-DD HH:mm:ss", from Unix ms or an ISO string. */
function fmtClock(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number(value);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** "12.3s" under a minute, "2m05s" beyond. Unmeasurable stays empty. */
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round the total before splitting it: rounding the remainder alone turns
  // 119.6s into "1m60s".
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("time.days", { count: days });
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------- sidebar

const SIDEBAR_KEY = "piShellSidebar";
const SIDEBAR_LAST_KEY = "piShellSidebarLast";

/** full → no-folders → fullscreen → full … */
const SIDEBAR_STATES = ["full", "no-folders", "fullscreen"];

const SIDEBAR_NEXT_ACTION = {
  full: "sidebar.collapseFolders",
  "no-folders": "sidebar.collapseAll",
  fullscreen: "sidebar.expand",
};

let sidebarState = "full";
/** Most recent non-fullscreen state; ⌘B returns to it from fullscreen. */
let sidebarLastExpanded = "full";

/**
 * The toggle always sits at the top-left of the leftmost visible pane, so it
 * collapses and expands in the same place — inside the pane it controls.
 */
function placeSidebarToggle() {
  const host =
    sidebarState === "full"
      ? document.querySelector("#folders .pane-head")
      : sidebarState === "no-folders"
        ? document.querySelector("#sessions .pane-head")
        : document.getElementById("chat-head");
  host.prepend(el.sidebarToggle);
}

function applySidebar(state) {
  sidebarState = state;
  document.getElementById("app").dataset.sidebar = state;
  el.sidebarToggle.textContent = state === "fullscreen" ? "»" : "‹";
  el.sidebarToggle.title = t(SIDEBAR_NEXT_ACTION[state]);
  placeSidebarToggle();
}

function setSidebar(next) {
  if (!SIDEBAR_STATES.includes(next) || next === sidebarState) return;
  applySidebar(next);
  if (next !== "fullscreen") sidebarLastExpanded = next;
  try {
    localStorage.setItem(SIDEBAR_KEY, next);
    if (next !== "fullscreen") localStorage.setItem(SIDEBAR_LAST_KEY, next);
  } catch {
    // Private mode etc. — the toggle still works, just not remembered.
  }
}

function initSidebar() {
  let stored = null;
  let last = null;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY);
    last = localStorage.getItem(SIDEBAR_LAST_KEY);
  } catch {
    // ignore
  }
  // Legacy two-state value: "1" expanded, "0" collapsed.
  if (stored === "1" || stored === "0") stored = stored === "0" ? "fullscreen" : "full";
  sidebarLastExpanded = last === "no-folders" ? last : "full";
  applySidebar(SIDEBAR_STATES.includes(stored) ? stored : "full");

  el.sidebarToggle.onclick = () => {
    const index = SIDEBAR_STATES.indexOf(sidebarState);
    setSidebar(SIDEBAR_STATES[(index + 1) % SIDEBAR_STATES.length]);
  };
  // Cmd/Ctrl+B jumps straight to fullscreen and back — it never enters the
  // intermediate stage, so the shortcut can't surprise you.
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      // In the settings view there is no sidebar on screen to collapse.
      if (state.view === "settings") return;
      event.preventDefault();
      setSidebar(sidebarState === "fullscreen" ? sidebarLastExpanded : "fullscreen");
    }
  });
}

function renderFolders() {
  el.folderList.innerHTML = "";
  if (state.folders.length === 0) {
    el.folderList.innerHTML = `<div class="empty">${t("sidebar.noSessions")}</div>`;
    return;
  }
  for (const folder of state.folders) {
    const runningCount = state.sessions.filter((s) => s.cwd === folder.cwd && s.running).length;
    // A folder is the only place an unread finish is visible when the session
    // lives in another folder than the one being viewed.
    const doneCount = state.sessions.filter(
      (s) => s.cwd === folder.cwd && !s.running && state.unreadDone.has(s.path),
    ).length;
    const node = document.createElement("div");
    node.className = `item folder${folder.cwd === state.cwd ? " active" : ""}${runningCount ? " running" : ""}${doneCount ? " unread" : ""}`;
    const dot = runningCount
      ? `<span class="run-dot" title="${t("sidebar.folderRunning", { count: runningCount })}"></span>`
      : doneCount
        ? `<span class="done-dot" title="${t("sidebar.folderFinished", { count: doneCount })}"></span>`
        : "";
    const active =
      (runningCount
        ? `<span class="running-text">${t("sidebar.folderRunningSuffix", { count: runningCount })}</span>`
        : "") +
      (doneCount
        ? `<span class="done-text">${t("sidebar.folderFinishedSuffix", { count: doneCount })}</span>`
        : "");
    node.innerHTML = `<div class="name" title="${esc(folder.cwd)}">${dot}${esc(shortPath(folder.cwd))}</div>
      <div class="sub">${t("sidebar.folderSub", { count: folder.sessionCount, time: relativeTime(folder.lastActivity) })}${active}</div>
      <div class="item-actions">
        <button class="icon-btn folder-act" data-act="delete" title="${t("sidebar.deleteFolder")}">🗑</button>
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
  el.sessionsTitle.textContent = state.cwd ? shortPath(state.cwd) : t("sidebar.sessions");
  el.sessionList.innerHTML = "";
  if (!state.cwd) {
    el.sessionList.innerHTML = `<div class="empty">${t("sidebar.pickFolder")}</div>`;
    return;
  }
  if (list.length === 0) {
    el.sessionList.innerHTML = `<div class="empty">${t("sidebar.noSessionsInFolder")}</div>`;
    return;
  }
  for (const session of list) {
    // Running supersedes a stale unread mark: a new run clears it above.
    const unread = !session.running && state.unreadDone.has(session.path);
    const node = document.createElement("div");
    node.className = `item session${session.path === state.path ? " active" : ""}${session.pending ? " pending" : ""}${session.running ? " running" : ""}${unread ? " unread" : ""}`;
    const badge = session.pending ? `<span class="badge">${t("session.badgeNew")}</span>` : "";
    const dot = session.running
      ? `<span class="run-dot" title="${t("session.running")}"></span>`
      : unread
        ? `<span class="done-dot" title="${t("session.finished")}"></span>`
        : "";
    const sub = session.pending
      ? t("session.pending")
      : session.running
        ? `<span class="running-text">${t("session.runningNow")}</span> · ${relativeTime(session.updatedAt)}`
        : unread
          ? `<span class="done-text">${t("session.finished")}</span> · ${relativeTime(session.updatedAt)}`
          : relativeTime(session.updatedAt);
    node.innerHTML = `<div class="name" title="${esc(session.title)}">${dot}${esc(session.title)}${badge}</div>
      <div class="sub">${sub}</div>
      <div class="item-actions">
        <button class="icon-btn session-act" data-act="rename" title="${t("session.rename")}">✎</button>
        <button class="icon-btn session-act" data-act="delete" title="${t("session.delete")}">🗑</button>
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
  // Also stops the reconnect timer: it checks this flag before re-attaching.
  state.streamEnded = true;
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearTimeout(state.loadTimer);
  state.loadTimer = null;
  stopStatsTicker();
  state.streaming = false;
  // A wait that outlives its session would hang the click that started it.
  resolveSettleWaiters();
  state.turnStartMs = 0;
  state.turnInput = 0;
  state.turnOutput = 0;
  state.lastReply = null;
  state.live = null;
  state.toolGroup = null;
  state.toolEntryIndex = new Map();
  state.stats = null;
  resetSpeed();
  state.lastSpeed = null;
  resetModelControls();
  renderStats();
  setStatus("idle");
  // Extension state and dialogs belong to the session we just left: clear the
  // state and answer any open dialog as cancelled, or that pi subprocess would
  // block forever waiting for a host that moved on.
  resetExtensionUi();
  state.commands = [];
  hideCommandMenu();
}

function setStatus(kind) {
  el.status.className = `status ${kind}`;
  el.abort.disabled = kind !== "live";
}

/** How many times a dropped stream is re-attached before giving up. */
const STREAM_MAX_RETRIES = 3;

async function openSession(session) {
  closeStream();
  // The tree belongs to the session being opened; a panel left over from the
  // previous one would show another session's branches.
  closeTreePanel();
  closeLightbox();
  state.path = session.path;
  state.cwd = session.cwd;
  // Opening the session is the acknowledgement: drop its finished badge.
  state.unreadDone.delete(session.path);
  state.abortedPaths.delete(session.path);
  applyDocumentTitle();
  el.messages.innerHTML = "";
  el.chatTitle.textContent = session.title;
  el.chatMeta.textContent = session.cwd;
  el.treeBtn.disabled = false;
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

  openSessionStream(session);
}

/**
 * Attach (or re-attach) the SSE stream of the session that is already selected.
 *
 * `EventSource` retries by itself, forever, and every reconnect makes the server
 * acquire the session again — which spawns a pi subprocess. So the retries are
 * taken over here: a few with backoff, enough to ride out a service restart,
 * then stop and say so instead of looping invisibly in the background.
 */
function openSessionStream(session) {
  const stream = new EventSource(`/api/stream?path=${encodeURIComponent(session.path)}`);
  state.stream = stream;
  state.streamEnded = false;

  stream.onopen = () => {
    state.streamRetries = 0;
  };

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
      // pi exited, or the server could not keep the stream up. Tell the user,
      // then treat it like any other drop: one reconnect may well succeed (a
      // service restart looks exactly like this), and if it does not we stop.
      addNotice(t("common.error", { message: frame.error }), "error");
      setStatus("idle");
      retryOrGiveUp(session, stream);
    }
  };

  stream.onerror = () => retryOrGiveUp(session, stream);
}

/**
 * The stream is over: reconnect a few times, then stop for good.
 *
 * Never retry forever. `EventSource` does that by default, and each reconnect
 * makes the server acquire the session again — spawning a pi subprocess nobody
 * is watching. Three attempts with backoff ride out a service restart (which
 * closes streams this way) while keeping a dead session from looping.
 *
 * `state.stream` is deliberately left pointing at the failed stream until the
 * retry replaces it: that is how a late retry notices that the user has since
 * switched sessions (`closeStream()` clears both the pointer and the flag).
 */
function retryOrGiveUp(session, stream) {
  if (state.stream !== stream || state.streamEnded) return;
  if (state.streamRetries >= STREAM_MAX_RETRIES) {
    endStream(stream);
    addNotice(t("msg.disconnected"), "error");
    setStatus("idle");
    return;
  }
  state.streamRetries += 1;
  stream.close();
  setTimeout(
    () => {
      if (state.path === session.path && state.stream === stream && !state.streamEnded) {
        openSessionStream(session);
      }
    },
    500 * 2 ** (state.streamRetries - 1),
  );
}

/** Stop retrying for good. `closeStream`/`openSession` own the flag. */
function endStream(stream) {
  state.streamEnded = true;
  stream.close();
  if (state.stream === stream) state.stream = null;
}


function handleSnapshot(frame) {
  clearTimeout(state.loadTimer);
  state.loadTimer = null;
  el.messages.innerHTML = "";
  const messages = frame.messages || [];
  if (messages.length === 0) addNotice(t("msg.emptySession"));
  renderHistory(messages);

  const model = frame.state && frame.state.model;
  state.modelLabel = model ? `${model.provider}/${model.name || model.id}` : null;
  state.thinkingLevel = (frame.state && frame.state.thinkingLevel) ?? null;
  updateChatMeta();
  setStatus(frame.state && frame.state.isStreaming ? "live" : "idle");
  state.stats = frame.stats ?? null;
  renderStats();
  // Fire-and-forget extension state is replayed here because a widget set at
  // `session_start` may have fired long before this stream attached.
  applyExtensionUiSnapshot(frame.ui);
  // Commands come from the session's pi subprocess, so they can only be fetched
  // now that the stream (and therefore the child) exists.
  void loadCommands();
  loadModelControls();
  scrollToEnd();
}

function handleEvent(event) {
  switch (event.type) {
    case "agent_start":
      state.streaming = true;
      // A new turn: forget the previous turn's final bubble so its stats are not
      // re-applied if this one ends without ever producing text.
      state.lastReply = null;
      state.turnInput = 0;
      state.turnOutput = 0;
      // Wait for the first delta before starting the clock: request latency is not
      // decode time, so it must not dilute the rate.
      resetSpeed();
      state.lastSpeed = null;
      startStatsTicker();
      setStatus("live");
      break;
    case "message_start":
      // Build the assistant bubble lazily: a tool-only turn must not create one.
      if (event.message && event.message.role === "assistant") {
        state.live = null;
        resetSpeed();
      }
      break;
    case "message_update":
      applyDelta(event);
      break;
    case "message_end":
      if (event.message && event.message.role === "assistant") {
        // Every round contributes to the turn's totals, not just the last.
        const round = usageTokens(event.message);
        state.turnInput += round.input;
        state.turnOutput += round.output;
        // The final message carries authoritative usage even when no stream event
        // did, so prefer it before freezing the rate for this message.
        const out = event.message.usage?.output;
        if (typeof out === "number" && out > 0) state.streamReportedTokens = out;
        state.lastSpeed = currentSpeed() ?? state.lastSpeed;
        resetSpeed();
        finalizeAssistant(event.message);
      }
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
    case "extension_ui_request":
      handleExtensionUiRequest(event);
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
      // Keep the last rate on screen until the next run starts. A message cut short
      // by an abort still has a live clock, so it wins; otherwise message_end has
      // already frozen the right value and tool time stays out of the ratio.
      state.lastSpeed = currentSpeed() ?? state.lastSpeed;
      state.streaming = false;
      state.live = null;
      stopStatsTicker();
      renderStats();
      setStatus("idle");
      // The turn is over: put the stats footer on its final text reply (and only
      // that one stays expanded; the next send drops `is-last`).
      if (state.lastReply && state.lastReply.node.isConnected) {
        const { node, message } = state.lastReply;
        const actions = node.querySelector(".msg-actions");
        if (actions) {
          actions.outerHTML = assistantActions(
            replyMeta(state.turnStartMs, message, state.turnInput, state.turnOutput),
          );
        }
        node.classList.add("is-last");
      }
      state.lastReply = null;
      state.turnStartMs = 0;
      state.turnInput = 0;
      state.turnOutput = 0;
      // Anyone waiting to fork (edit/delete) can go ahead now.
      resolveSettleWaiters();
      refreshSessionList();
      break;
    default:
      break;
  }
}

// ------------------------------------------------------ extension UI (RPC)
//
// pi's `extension_ui_request` subprotocol, so extensions that talk to a host
// work here too: dialogs (`select` / `confirm` / `input` / `editor`) are
// answered through POST /api/ui-response, and the fire-and-forget methods are
// mirrored (notify → toast, setStatus → chip, setWidget → block, setTitle →
// document.title, set_editor_text → composer).
//
// The full vocabulary is documented in pi's docs/rpc-extension-ui.md. Methods a
// terminal needs but a browser cannot provide (`custom`, `onTerminalInput`,
// themes) are not part of RPC mode; extensions are expected to fall back to
// dialogs there, so nothing is lost by not faking them.

/** Strip SGR colour codes: extensions colour widget/status text for a terminal. */
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text) {
  return typeof text === "string" ? text.replace(ANSI_PATTERN, "") : "";
}

function handleExtensionUiRequest(event) {
  switch (event.method) {
    case "notify":
      showToast(event.message, event.notifyType);
      break;
    case "setStatus":
      setExtensionStatus(event.statusKey, event.statusText);
      break;
    case "setWidget":
      setExtensionWidget(event.widgetKey, event.widgetLines, event.widgetPlacement);
      break;
    case "setTitle":
      setExtensionTitle(event.title);
      break;
    case "set_editor_text":
      applyEditorText(event.text);
      break;
    case "select":
    case "confirm":
    case "input":
    case "editor":
      enqueueDialog(event);
      break;
    default:
      break;
  }
}

/** Rebuild the whole extension surface from a snapshot (session attach/switch). */
function applyExtensionUiSnapshot(ui) {
  state.extension.status = new Map();
  state.extension.widgets = { aboveEditor: new Map(), belowEditor: new Map() };
  state.extension.title = null;

  if (ui) {
    for (const entry of ui.status || []) {
      if (entry && typeof entry.key === "string") state.extension.status.set(entry.key, String(entry.text ?? ""));
    }
    for (const widget of ui.widgets || []) {
      if (!widget || typeof widget.key !== "string") continue;
      const bucket = widget.placement === "belowEditor" ? state.extension.widgets.belowEditor : state.extension.widgets.aboveEditor;
      bucket.set(widget.key, (widget.lines || []).map(String));
    }
    if (ui.title) state.extension.title = String(ui.title);
  }
  renderExtensionUi();
}

function setExtensionStatus(key, text) {
  if (typeof key !== "string" || !key) return;
  const value = typeof text === "string" && text !== "" ? stripAnsi(text) : null;
  if (value === null) state.extension.status.delete(key);
  else state.extension.status.set(key, value);
  renderExtensionUi();
}

function setExtensionWidget(key, lines, placement) {
  if (typeof key !== "string" || !key) return;
  const bucket = placement === "belowEditor" ? state.extension.widgets.belowEditor : state.extension.widgets.aboveEditor;
  if (Array.isArray(lines)) bucket.set(key, lines.map((line) => stripAnsi(String(line))));
  else bucket.delete(key);
  renderExtensionUi();
}

function setExtensionTitle(title) {
  state.extension.title = typeof title === "string" && title !== "" ? title : null;
  renderExtensionUi();
}

function applyEditorText(text) {
  el.input.value = typeof text === "string" ? text : "";
  autoGrow();
  if (el.input.value) el.input.focus();
}

function renderExtensionUi() {
  el.extStatus.innerHTML = "";
  for (const text of state.extension.status.values()) {
    const chip = document.createElement("span");
    chip.className = "ext-status-chip";
    chip.textContent = text;
    el.extStatus.appendChild(chip);
  }
  el.extStatus.hidden = state.extension.status.size === 0;

  renderWidgetBucket(el.extWidgetAbove, state.extension.widgets.aboveEditor);
  renderWidgetBucket(el.extWidgetBelow, state.extension.widgets.belowEditor);

  applyDocumentTitle();
}

function renderWidgetBucket(node, widgets) {
  node.innerHTML = "";
  for (const lines of widgets.values()) {
    const block = document.createElement("div");
    block.className = "ext-widget-block";
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "ext-widget-line";
      row.textContent = line;
      block.appendChild(row);
    }
    node.appendChild(block);
  }
  node.hidden = widgets.size === 0;
}

const TOAST_TYPES = new Set(["info", "warning", "error"]);

function showToast(message, type, onClick) {
  const text = stripAnsi(message).trim();
  if (!text) return;
  const kind = TOAST_TYPES.has(type) ? type : "info";
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = text;
  node.title = onClick ? t("ui.openSession") : t("ui.dismiss");
  // `toast-global` marks a notice that is not tied to the open session, so a
  // session switch must not sweep it away (unlike an extension's notifications).
  if (onClick) node.classList.add("toast-action", "toast-global");
  node.onclick = () => {
    if (onClick) onClick();
    node.remove();
  };
  el.toasts.appendChild(node);
  // Errors linger: they usually explain why a command did nothing.
  setTimeout(() => node.remove(), kind === "error" ? 10_000 : 6_000);
}

/**
 * Queue a blocking dialog. pi blocks the extension until it is answered, and
 * dialogs usually carry no timeout, so one must be on screen before pi can be
 * unblocked — hence a queue rather than dropping a second request.
 */
function enqueueDialog(request) {
  state.dialogQueue.push({ path: state.path, request });
  if (!state.dialog) showNextDialog();
}

function showNextDialog() {
  if (state.dialogTimer) {
    clearTimeout(state.dialogTimer);
    state.dialogTimer = null;
  }
  const item = state.dialogQueue.shift() ?? null;
  state.dialog = item;
  if (!item) return closeDialog();
  renderDialog(item);
}

function answerDialog(item, payload) {
  sendUiResponse(item.path, item.request.id, payload);
  showNextDialog();
}

async function sendUiResponse(path, id, payload) {
  if (!path) return;
  try {
    await api.uiResponse(path, { id, ...payload });
  } catch (error) {
    // The dialog is already gone (pi timed it out, or the subprocess was
    // replaced). The stream is where a dead session becomes visible.
    console.debug("ui-response failed", error);
  }
}

function closeDialog() {
  el.dialog.classList.add("hidden");
  el.dialogTitle.textContent = "";
  el.dialogBody.innerHTML = "";
  el.dialogActions.innerHTML = "";
}

function renderDialog(item) {
  const { request } = item;
  el.dialogTitle.textContent = dialogTitleFor(request);
  el.dialogBody.innerHTML = "";
  el.dialogActions.innerHTML = "";

  if (request.method === "select") {
    const list = document.createElement("div");
    list.className = "ui-dialog-list";
    list.id = "ui-dialog-options";
    for (const option of Array.isArray(request.options) ? request.options : []) {
      const value = String(option);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-dialog-option";
      button.textContent = stripAnsi(value);
      button.onclick = () => answerDialog(item, { value });
      list.appendChild(button);
    }
    el.dialogBody.appendChild(list);
    el.dialogActions.appendChild(cancelButton(item));
  } else if (request.method === "confirm") {
    const message = document.createElement("div");
    message.className = "ui-dialog-message";
    message.textContent = stripAnsi(String(request.message ?? ""));
    el.dialogBody.appendChild(message);
    el.dialogActions.appendChild(primaryButton(t("ui.confirm"), () => answerDialog(item, { confirmed: true })));
    el.dialogActions.appendChild(cancelButton(item, t("ui.deny"), { confirmed: false }));
  } else if (request.method === "input") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ui-dialog-input";
    if (request.placeholder) input.placeholder = stripAnsi(String(request.placeholder));
    input.onkeydown = (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        answerDialog(item, { value: input.value });
      }
    };
    el.dialogBody.appendChild(input);
    el.dialogActions.appendChild(primaryButton(t("ui.ok"), () => answerDialog(item, { value: input.value })));
    el.dialogActions.appendChild(cancelButton(item));
  } else if (request.method === "editor") {
    const area = document.createElement("textarea");
    area.className = "ui-dialog-editor";
    area.value = typeof request.prefill === "string" ? request.prefill : "";
    area.onkeydown = (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        answerDialog(item, { value: area.value });
      }
    };
    el.dialogBody.appendChild(area);
    el.dialogActions.appendChild(primaryButton(t("ui.ok"), () => answerDialog(item, { value: area.value })));
    el.dialogActions.appendChild(cancelButton(item));
  }

  el.dialog.classList.remove("hidden");
  // Focus only works once the dialog is visible (a hidden subtree cannot take it).
  el.dialogBody.querySelector(".ui-dialog-input, .ui-dialog-editor")?.focus();

  // A dialog may carry a deadline; pi auto-resolves it and the client is told
  // not to track the timeout. Close the modal when it passes anyway, so a dead
  // question does not sit on screen forever. No response is sent: pi moved on.
  const timeout = Number(request.timeout);
  if (Number.isFinite(timeout) && timeout > 0) {
    state.dialogTimer = setTimeout(() => {
      if (state.dialog === item) showNextDialog();
    }, timeout);
  }
}

function dialogTitleFor(request) {
  const title = stripAnsi(String(request.title ?? ""));
  if (title) return title;
  if (request.method === "confirm") return t("ui.confirmTitle");
  if (request.method === "input") return t("ui.inputTitle");
  if (request.method === "editor") return t("ui.editorTitle");
  return t("ui.selectTitle");
}

function primaryButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-dialog-primary";
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function cancelButton(item, label = t("ui.cancel"), payload = { cancelled: true }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-dialog-cancel";
  button.textContent = label;
  button.onclick = () => answerDialog(item, payload);
  return button;
}

/**
 * Drop every extension artefact of the session being left, and cancel any
 * dialog it is blocked on. Called from `closeStream()`, which is the single
 * choke point for attaching a different session.
 */
function resetExtensionUi() {
  const pending = state.dialog ? [state.dialog, ...state.dialogQueue] : [...state.dialogQueue];
  for (const item of pending) sendUiResponse(item.path, item.request.id, { cancelled: true });
  state.dialog = null;
  state.dialogQueue = [];
  if (state.dialogTimer) {
    clearTimeout(state.dialogTimer);
    state.dialogTimer = null;
  }
  closeDialog();

  state.extension.status = new Map();
  state.extension.widgets = { aboveEditor: new Map(), belowEditor: new Map() };
  state.extension.title = null;
  // Extension notifications belong to the session being left; background
  // completion notices do not, so they stay put with their title badge.
  for (const toast of el.toasts.querySelectorAll(".toast:not(.toast-global)")) toast.remove();
  renderExtensionUi();
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
    node.innerHTML = `${assistantHead()}${renderContent(prose)}${assistantActions(null)}`;
    closeToolGroup();
    // Remembered until `agent_settled`: that is when the turn (and its clock)
    // is really over, and when the footer stats can be filled in.
    state.lastReply = { node, message };
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
  // Every delta is generated output — text, thinking, or tool arguments — so each
  // one starts the clock and feeds the estimate. `*_end` repeats the full content
  // and is skipped to avoid counting it twice.
  if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
    if (!state.streamStart) state.streamStart = performance.now();
    state.streamEstimatedTokens += estimateTokens(delta.delta ?? "");
  }
  if (delta.type === "text_delta") {
    ensureLive();
    appendText(delta.delta);
  } else if (delta.type === "thinking_delta") {
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

/** Text blocks with a render queued for the next animation frame. */
const livePending = new Set();
let liveFrame = 0;

/** Coalesce many deltas into at most one live render per frame. */
function scheduleLiveText(textBlock) {
  livePending.add(textBlock);
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const blocks = [...livePending];
    livePending.clear();
    for (const block of blocks) renderLiveText(block);
    scrollToEnd();
  });
}

/**
 * Render an in-progress text block so formatting appears while the model is
 * still writing.
 *
 * Only regions that can no longer change are committed: their HTML is inserted
 * once (so Prism and Mermaid run once), and a still-growing tail is re-rendered
 * on top. The tail is Markdown too — a half-typed paragraph should look like a
 * paragraph — except inside an open fence, where the raw source is shown until
 * the fence closes rather than letting an unfinished code block swallow the
 * reply.
 */
function renderLiveText(textBlock) {
  if (!textBlock.isConnected) return;
  const text = textBlock.dataset.text;
  if (!textBlock.dataset.ready) {
    textBlock.innerHTML = '<div class="md live-md"><div class="live-tail"></div></div>';
    textBlock.dataset.ready = "1";
    textBlock.dataset.stableLen = "0";
  }
  const md = textBlock.querySelector(".live-md");
  const tailEl = textBlock.querySelector(".live-tail");
  if (!md || !tailEl) return;

  let committed = Number(textBlock.dataset.stableLen || 0);
  if (committed > text.length) {
    // The text shrank (a rewind): drop what was committed and rebuild.
    md.replaceChildren(tailEl);
    committed = 0;
  }
  const { end, inFence } = findStableEnd(text, committed);
  if (end > committed) {
    commitStable(md, tailEl, text.slice(committed, end));
    committed = end;
  }
  textBlock.dataset.stableLen = String(committed);

  const tail = text.slice(committed);
  tailEl.classList.toggle("plain", inFence);
  tailEl.innerHTML = inFence ? esc(tail) : renderMarkdownHtml(tail);
}

/**
 * Append one committed region, extending the previous chunk when the two are
 * the same loose list so ordered numbering and indentation survive the split.
 */
function commitStable(md, tailEl, chunk) {
  const previous = tailEl.previousElementSibling;
  if (previous && previous.dataset.text !== undefined && continuesList(previous.dataset.text, chunk)) {
    const merged = previous.dataset.text + chunk;
    previous.dataset.text = merged;
    previous.innerHTML = renderMarkdownHtml(merged);
    return;
  }
  const node = document.createElement("div");
  node.className = "live-chunk";
  node.dataset.text = chunk;
  node.innerHTML = renderMarkdownHtml(chunk);
  md.insertBefore(node, tailEl);
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
    // `text_end` carries the block's final text: render it whole and drop the
    // incremental scaffolding, so the result is exactly `renderMarkdown`.
    textBlock.dataset.text = full;
    textBlock.innerHTML = renderMarkdown(full);
    delete textBlock.dataset.ready;
    delete textBlock.dataset.stableLen;
    livePending.delete(textBlock);
    return;
  }
  textBlock.dataset.text += chunk;
  scheduleLiveText(textBlock);
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
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  // Lifetime totals on a busy machine reach billions; "2824.9M" reads badly.
  return `${(n / 1e9).toFixed(2)}G`;
}

function fmtCost(cost) {
  if (!Number.isFinite(cost)) return "";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Decode throughput of the message on screen: its output tokens over the time
 * since its first delta. Scoping the ratio to a single message keeps both sides
 * aligned — thinking counts on both (tokens and time), while request latency and
 * tool execution stay out entirely. Prefixed with ≈ when the count is estimated.
 */
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

/** Drop the in-flight measurement; called once per assistant message. */
function resetSpeed() {
  state.streamStart = 0;
  state.streamReportedTokens = 0;
  state.streamEstimatedTokens = 0;
}

function renderStats() {
  const stats = state.stats;
  const parts = [];

  const usage = stats && stats.contextUsage;
  if (usage && usage.contextWindow) {
    const percent = usage.percent === null || usage.percent === undefined ? 0 : usage.percent;
    const width = Math.max(0, Math.min(100, percent)).toFixed(1);
    parts.push(
      `<span class="stat" title="${t("stats.contextTitle")}">` +
        `<span class="ctx-bar"><i style="width:${width}%"></i></span>` +
        `${t("stats.context", { used: fmtTokens(usage.tokens), window: fmtTokens(usage.contextWindow), percent: Number(percent).toFixed(1) })}</span>`,
    );
  }

  if (stats) {
    parts.push(
      `<span class="stat" title="${t("stats.tokensTitle")}">${t("stats.tokens", { input: fmtTokens(stats.tokens.input), output: fmtTokens(stats.tokens.output) })}</span>`,
    );
    if (stats.tokens.cacheRead > 0) {
      parts.push(`<span class="stat" title="${t("stats.cacheTitle")}">${t("stats.cache", { read: fmtTokens(stats.tokens.cacheRead) })}</span>`);
    }
    parts.push(`<span class="stat" title="${t("stats.costTitle")}">${fmtCost(stats.cost)}</span>`);
    parts.push(
      `<span class="stat" title="${t("stats.turnsTitle")}">${t("stats.turns", { turns: stats.assistantMessages, tools: stats.toolCalls })}</span>`,
    );
  }

  const speed = currentSpeed() ?? state.lastSpeed;
  if (speed) {
    parts.push(`<span class="stat speed" title="${t("stats.speedTitle")}">${t("stats.speed", { speed })}</span>`);
  } else if (parts.length > 0) {
    // Keep the slot visible so it is obvious where the rate appears.
    parts.push(`<span class="stat speed idle-speed" title="${t("stats.speedIdleTitle")}">${t("stats.speedIdle")}</span>`);
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
  const action = event.target.closest("[data-msg-action]");
  if (action) {
    const bubble = action.closest(".msg");
    // Count back from the newest *now*, not at render time: a message sent
    // after this bubble rendered would make a stored index point at the wrong
    // entry (the server resolves the index against the live active branch).
    const bubbles = [...el.messages.querySelectorAll(".msg.user")];
    const index = bubble ? bubbles.indexOf(bubble) : -1;
    if (index < 0) return;
    // `fork` returns text only; images cannot ride along.
    const hasImages = Boolean(bubble.querySelector("img"));
    await forkFromTranscript(bubbles.length - 1 - index, action.dataset.msgAction === "edit", hasImages);
    return;
  }

  const placeholder = event.target.closest(".image-placeholder");
  if (placeholder) {
    revealToolImage(placeholder);
    return;
  }

  // Markdown and tool images render capped in the transcript; the click opens
  // the full-size pixels in-app instead of a new browser tab.
  const img = event.target.closest("#messages img");
  if (img) {
    openLightbox(img.src);
    return;
  }

  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const kind = button.dataset.copy;
  let text = "";
  if (kind === "code") {
    text = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
  } else if (kind === "diagram") {
    text = button.closest(".mermaid-block")?.querySelector(".mermaid-source code")?.textContent ?? "";
  } else {
    const message = button.closest(".msg");
    text = message ? messageText(message) : "";
  }
  if (!text) return;

  // Icon-only buttons must keep their shape; swapping in "copied" text would
  // bounce the row. They flash ✓/✗ instead and restore the glyph.
  const iconOnly = button.classList.contains("msg-act");
  const original = button.textContent;
  const originalTitle = button.title;
  try {
    await copyTextToClipboard(text);
    button.textContent = iconOnly ? "✓" : t("common.copied");
    button.title = t("common.copied");
    button.classList.add("copied");
  } catch {
    button.textContent = iconOnly ? "✗" : t("common.copyFailed");
    button.title = t("common.copyFailed");
    button.classList.add("failed");
  }
  setTimeout(() => {
    button.textContent = original;
    button.title = originalTitle;
    button.classList.remove("copied", "failed");
  }, 1200);
}

/** Swap a tool-image placeholder for the real image, fetching it only now. */
function revealToolImage(placeholder) {
  const src = placeholder.dataset.image;
  if (!src) return;
  const image = document.createElement("img");
  image.src = src;
  image.alt = t("msg.toolImage");
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
    node.innerHTML = `<img src="${att.dataUrl}" alt="${t("msg.attachment")}" />`;
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
      const attachment = {
        dataUrl,
        mimeType: file.type || "image/png",
        data: dataUrl.slice(comma + 1),
      };
      state.attachments.push(attachment);
      // Intrinsic size lets the sent bubble reserve space (renderImage emits
      // width/height), so the scroll done at send time stays at the true bottom
      // instead of coming up short once the image decodes.
      measureImage(dataUrl).then((size) => {
        if (!size) return;
        Object.assign(attachment, size);
        renderAttachments();
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function measureImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function sendMessage() {
  if (!state.path) return;
  const text = el.input.value.trim();
  const images = state.attachments.map((att) => ({
    type: "image",
    data: att.data,
    mimeType: att.mimeType,
    width: att.width,
    height: att.height,
  }));
  if (!text && images.length === 0) return;

  state.turnStartMs = Date.now();
  addMessage({ role: "user", content: text ? renderUserContent(text, images) : images, timestamp: state.turnStartMs });
  // The bubble is appended below the current viewport; without this the user's
  // own words stay out of sight until the first assistant delta scrolls again.
  scrollToEnd();
  el.input.value = "";
  autoGrow();
  hideCommandMenu();
  state.attachments = [];
  renderAttachments();

  try {
    await api.prompt(state.path, text, images.length ? images : undefined);
  } catch (error) {
    addNotice(t("chat.sendFailed", { message: error.message }), "error");
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

// --------------------------------------------------------- slash commands
//
// Type `/` and the composer offers the commands pi can run for this session
// (`get_commands`): extension commands, prompt templates, and skill commands.
// Built-in TUI commands are not in that list, because pi does not execute them
// from a `prompt` — offering them would promise something that cannot work.

/** The `/token` being typed, or null when the input is not a bare command. */
function commandQuery() {
  const match = /^\/(\S*)$/.exec(el.input.value);
  return match ? match[1] : null;
}

/**
 * Fetch the session's commands once per attach.
 *
 * Best-effort on purpose: no menu is a missing convenience, not an error worth
 * interrupting the chat for.
 */
async function loadCommands() {
  const path = state.path;
  if (!path) return;
  try {
    const data = await api.commands(path);
    if (state.path !== path) return; // the user switched sessions mid-flight
    state.commands = Array.isArray(data.commands) ? data.commands : [];
  } catch {
    state.commands = [];
  }
}

function isExactCommand(value) {
  return state.commands.some((command) => `/${command.name}` === value);
}

function updateCommandMenu() {
  const query = commandQuery();
  if (query === null || state.commands.length === 0) return hideCommandMenu();

  // Reset the highlight when the query changes, keep it while arrowing around.
  if (query !== state.commandQuery) {
    state.commandQuery = query;
    state.commandIndex = 0;
  }

  const needle = query.toLowerCase();
  state.commandMatches = state.commands
    .filter((command) => command.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    });

  if (state.commandMatches.length === 0) return hideCommandMenu();
  state.commandIndex = Math.min(state.commandIndex, state.commandMatches.length - 1);
  renderCommandMenu();
}

/** Only sources the shell knows get a translated badge; the rest show raw. */
const COMMAND_SOURCE_KEYS = {
  extension: "command.source.extension",
  prompt: "command.source.prompt",
  skill: "command.source.skill",
};

function renderCommandMenu() {
  el.commandList.innerHTML = "";
  state.commandMatches.forEach((command, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `command-item${index === state.commandIndex ? " selected" : ""}`;
    item.dataset.index = String(index);

    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = `/${command.name}`;

    const source = document.createElement("span");
    source.className = `command-source command-source-${command.source}`;
    source.textContent = t(COMMAND_SOURCE_KEYS[command.source] ?? "command.source.other");

    const description = document.createElement("span");
    description.className = "command-desc";
    description.textContent = command.description || "";

    item.append(name, source, description);
    el.commandList.appendChild(item);
  });

  el.commandMenu.hidden = false;
  el.commandList.querySelector(".command-item.selected")?.scrollIntoView({ block: "nearest" });
}

function hideCommandMenu() {
  el.commandMenu.hidden = true;
  state.commandMatches = [];
  state.commandIndex = 0;
  state.commandQuery = null;
}

/** Insert the highlighted command and leave the caret ready for arguments. */
function completeCommand(index = state.commandIndex) {
  const command = state.commandMatches[index];
  if (!command) return;
  el.input.value = `/${command.name} `;
  autoGrow();
  hideCommandMenu();
  el.input.focus();
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

/**
 * One global SSE for run-state of *every* managed session.
 *
 * The per-session `/api/stream` only exists while that session is open in a
 * tab, so it cannot report that a session you switched away from is still
 * working. This stream carries only the running flag; the browser reconnects
 * on its own if it drops.
 */
function openActivityStream() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.type === "activity") handleActivityFrame(frame);
  };
}

/**
 * Apply one `/api/events` frame.
 *
 * Kept separate from `openActivityStream` so the UI test can push frames
 * through the real `type/path/running/reason` contract instead of calling
 * `applyActivity` directly — that shortcut once hid a dropped `reason` here.
 */
function handleActivityFrame(frame) {
  applyActivity(frame.path, frame.running, frame.reason);
}

function applyActivity(path, running, reason) {
  const session = state.sessions.find((s) => s.path === path);
  if (!session || Boolean(session.running) === running) return;
  session.running = running;
  if (running) {
    // A new run supersedes a stale "finished" badge for this session.
    state.unreadDone.delete(path);
    applyDocumentTitle();
  } else {
    const wasAborted = state.abortedPaths.delete(path);
    // `retired` is the idle reaper, not a finish; and a session the user is
    // looking at updates live, so there is nothing to notify about.
    if (!wasAborted && path !== state.path && (reason === "settled" || reason === "exited")) {
      state.unreadDone.add(path);
      applyDocumentTitle();
      const failed = reason === "exited";
      showToast(
        t(failed ? "chat.backgroundFailed" : "chat.backgroundDone", { title: session.title }),
        failed ? "error" : "info",
        () => {
          // Jumping to a session from the settings page must also leave it,
          // or the transcript opens out of sight behind the settings view.
          if (state.view === "settings") closeSettings();
          openSession(session);
        },
      );
    }
  }
  renderFolders();
  renderSessions();
}

/** Remember that a finish for this path is expected, so it is not announced. */
function markAborted(path) {
  if (!path) return;
  state.abortedPaths.add(path);
  // Safety net: if the abort never settles (failed request, already-idle
  // session), the marker must not suppress the next genuine completion.
  setTimeout(() => state.abortedPaths.delete(path), 60_000);
}

/**
 * Single writer of `document.title`, combining an extension's `setTitle` with
 * the unread-finished count. Two independent sources, so they cannot each own
 * the property.
 */
function applyDocumentTitle() {
  const base = state.extension.title
    ? `${state.extension.title} \u00b7 ${state.defaultTitle}`
    : state.defaultTitle;
  // Count against the live session list, not the raw set: a session deleted (or
  // rotated away) elsewhere would otherwise leave the badge stuck one too high.
  const count = state.sessions.filter((s) => state.unreadDone.has(s.path)).length;
  document.title = count > 0 ? `(${count}) ${base}` : base;
}

/* ------------------------------------------------------------------ *
 * Preferences: theme and language
 *
 * Both belong to this shell, not to pi: pi's `theme` setting is about the
 * terminal UI and has nothing to do with these colours, and pi has no locale
 * setting at all. Writing either one into pi's settings.json would silently
 * change a different program, so they live in localStorage.
 * ------------------------------------------------------------------ */

const THEME_KEY = "piShellTheme";
const LOCALE_KEY = "piShellLocale";
const THEMES = ["system", "dark", "light"];

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / storage disabled
  }
}

function storeValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a nicety; failing to persist must not break the page.
  }
}

/**
 * Resolve the preference against the OS and put it on <html>.
 *
 * The stylesheet only knows `[data-theme="light"]`; "system" is resolved here
 * so CSS never has to ask a media query. index.html repeats this resolution
 * inline, before the first paint, to avoid a dark flash on a light reload.
 */
function applyTheme() {
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.dataset.theme =
    state.theme === "system" ? (prefersLight ? "light" : "dark") : state.theme;
}

function setTheme(preference) {
  state.theme = THEMES.includes(preference) ? preference : "system";
  storeValue(THEME_KEY, state.theme);
  applyTheme();
  if (state.view === "settings") renderSettings();
}

/**
 * Switch language and reload.
 *
 * The transcript is rendered once per message with its labels baked in, so
 * re-translating it in place would mean keeping a second, source-of-truth copy
 * of every message. On localhost the reload is instant, the stream reconnects
 * by itself, and the whole page — including what was already rendered — comes
 * back consistent.
 */
function setLanguage(id) {
  setLocale(id);
  storeValue(LOCALE_KEY, getLocale());
  location.reload();
}

function initPreferences() {
  const storedTheme = readStored(THEME_KEY);
  state.theme = THEMES.includes(storedTheme) ? storedTheme : "system";
  applyTheme();
  // While "system" is selected, keep following the OS.
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  setLocale(readStored(LOCALE_KEY) ?? "zh-CN");
}

/* ------------------------------------------------------------------ *
 * Settings view
 *
 * Two of the five sections are real and read-only (token totals, and the
 * environment pi will load). The rest render what is known today plus what is
 * still planned — placeholder panels, never fake controls.
 * ------------------------------------------------------------------ */

const SETTINGS_SECTIONS = ["usage", "resources", "models", "appearance", "agent"];
/** The settings view owns a URL of its own, so Back/Forward and reload work. */
const SETTINGS_ROUTE = "/settings";

function openSettings(section = state.settingsSection) {
  if (state.view !== "settings") {
    applyView("settings");
    // A real history entry, so the browser's back button returns to the chat
    // instead of leaving the app — before this there was nothing app-side to
    // go back to, and one Back press exited the whole shell.
    history.pushState({ piShellView: "settings", pushed: true }, "", SETTINGS_ROUTE);
  }
  selectSettingsSection(section);
}

function closeSettings() {
  if (state.view !== "settings") return;
  // Undo our pushed entry via history.back() so back/forward stay in sync. A
  // deep-loaded /settings (refresh) has no app entry underneath — going back
  // there would leave the app, so replace the entry in place instead.
  if (history.state?.piShellView === "settings" && history.state?.pushed) history.back();
  else {
    applyView("chat");
    history.replaceState({ piShellView: "chat", pushed: false }, "", "/");
  }
}

/** Swap the top-level view; history bookkeeping belongs to the call sites. */
function applyView(view) {
  state.view = view;
  el.app.dataset.view = view;
  // A hover card left over from the heatmap must not float over the chat.
  if (view === "chat") hideHeatTip();
}

function selectSettingsSection(section) {
  state.settingsSection = SETTINGS_SECTIONS.includes(section) ? section : "usage";
  for (const node of el.settingsMenu.querySelectorAll(".settings-menu")) {
    node.classList.toggle("active", node.dataset.section === state.settingsSection);
  }
  renderSettings();
  void ensureSettingsData();
}

/** Which payload the current section needs. */
function settingsDataKey(section = state.settingsSection) {
  return section === "usage" ? "usage" : "environment";
}

/**
 * Fetch the payload the current section needs, once.
 *
 * Re-entrant on purpose: after a fetch finishes we look again, because the user
 * may have switched to a section that needs the *other* payload while the first
 * request was in flight. Every path (loaded, in flight, failed) returns early,
 * so the recursion terminates.
 */
async function ensureSettingsData() {
  const key = settingsDataKey();
  if (state.settingsData[key] || state.pendingKey === key || state.failedKey === key) return;

  state.pendingKey = key;
  state.settingsError = null;
  state.failedKey = null;
  if (state.view === "settings") renderSettings();
  try {
    state.settingsData[key] =
      key === "usage" ? await api.settingsUsage() : await api.settingsEnvironment();
  } catch (error) {
    state.settingsError = error.message;
    state.failedKey = key;
  } finally {
    state.pendingKey = null;
  }
  if (state.view === "settings") renderSettings();
  void ensureSettingsData();
}

function renderSettings() {
  if (state.settingsError) {
    el.settingsBody.innerHTML = `<div class="settings-error">${esc(
      t("settings.loadFailed", { message: state.settingsError }),
    )}</div>`;
    return;
  }

  const env = state.settingsData.environment;
  const renderers = {
    usage: () => renderUsageSection(state.settingsData.usage),
    resources: () => renderResourcesSection(env),
    models: () => renderModelsSection(env),
    appearance: () => renderAppearanceSection(),
    agent: () => renderAgentSection(env),
  };
  el.settingsBody.innerHTML = `<div class="settings-page">${renderers[state.settingsSection]()}</div>`;
  // Controls live inside the rendered HTML, so they are bound here.
  const saveButton = document.getElementById("settings-save");
  if (saveButton) saveButton.onclick = saveEditableSettings;
  const agentsMdSave = document.getElementById("agents-md-save");
  if (agentsMdSave) agentsMdSave.onclick = saveAgentsMdAction;
  for (const toggle of el.settingsBody.querySelectorAll("[data-mcp-name]")) {
    toggle.onclick = () => toggleMcpServer(toggle.dataset.mcpName, toggle.dataset.mcpNext === "true", toggle);
  }
  // A finished save survives the re-renders that follow it (optimistic update,
  // background refresh) because the message lives in state.
  if (state.settingsSaveStatus) {
    const status = document.getElementById("settings-save-status");
    if (status) {
      status.className = state.settingsSaveStatus.cls;
      status.textContent = state.settingsSaveStatus.text;
    }
  }
  const modelSelect = document.getElementById("usage-model");
  if (modelSelect) {
    modelSelect.onchange = () => {
      state.usageModel = modelSelect.value;
      renderSettings();
    };
  }
  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.onchange = () => setTheme(themeSelect.value);
  }
  const localeSelect = document.getElementById("locale-select");
  if (localeSelect) {
    localeSelect.onchange = () => setLanguage(localeSelect.value);
  }
}

function renderUsageSection(report) {
  // The slow-loading text is only honest for the first, uncached scan.
  if (!report) return `<div class="settings-empty">${esc(t("settings.loadingSlow"))}</div>`;

  // `models` only exists on a server new enough to carry the slices; when an
  // older process is still running, say so instead of letting the filter look
  // broken (the frontend is served from disk, so the page can outrun the server).
  const slices = report.models ?? null;
  const selected = slices && state.usageModel && slices[state.usageModel] ? state.usageModel : "";
  state.usageModel = selected;
  // The per-model slices carry the same four breakdowns as the report, so the
  // filter is a switch of data source rather than a different code path.
  const slice = selected && slices ? slices[selected] : report;
  const totals = slice.totals;

  const modelPicker = slices
    ? `<select id="usage-model" class="settings-select">
        <option value="">${esc(t("usage.allModels", { count: report.byModel.length }))}</option>
        ${report.byModel
          .map(
            (row) =>
              `<option value="${esc(row.key)}"${row.key === selected ? " selected" : ""}>` +
              `${esc(row.key)} · ${esc(fmtCost(row.cost))} · ${esc(fmtTokens(row.total))}</option>`,
          )
          .join("")}
      </select>`
    : `<select id="usage-model" class="settings-select" disabled>
        <option>${esc(t("usage.filterNeedsRestart"))}</option>
      </select>`;

  const header = `
    <h2>${esc(t("usage.title"))}</h2>
    <p class="settings-lead">${esc(
      t("usage.lead", { files: report.scanned.files, messages: report.scanned.messages }),
    )}</p>
    <div class="settings-toolbar">
      <label for="usage-model">${esc(t("usage.model"))}</label>
      ${modelPicker}
      <span class="settings-toolbar-note">${
        selected ? esc(t("usage.onlyModel", { model: selected })) : esc(t("usage.heatNote"))
      }</span>
    </div>`;

  if (totals.calls === 0) {
    return `${header}<div class="settings-empty">${esc(t("usage.empty"))}</div>`;
  }

  const cards = `
    <div class="settings-cards">
      ${card(t("usage.card.cost"), fmtCost(totals.cost), t("usage.card.costSub", { count: fmtNum(totals.calls) }))}
      ${card(t("usage.card.total"), fmtTokens(totals.total), t("usage.card.totalSub", { input: fmtTokens(totals.input) }))}
      ${card(t("usage.card.output"), fmtTokens(totals.output), t("usage.card.outputSub", { reasoning: fmtTokens(totals.reasoning) }))}
      ${card(t("usage.card.cacheRead"), fmtTokens(totals.cacheRead), t("usage.card.cacheReadSub", { cacheWrite: fmtTokens(totals.cacheWrite) }))}
    </div>`;

  const modelColumns = [t("col.calls"), t("col.input"), t("col.output"), t("col.total"), t("col.cost")];
  const dayColumns = [
    t("col.calls"),
    t("col.input"),
    t("col.output"),
    t("col.cacheRead"),
    t("col.cacheWrite"),
    t("col.total"),
    t("col.cost"),
  ];

  // With a filter on, the all-models table would not respond to it — say so by
  // leaving it out rather than showing numbers that contradict the cards.
  const byModelSection = selected
    ? ""
    : section(t("usage.byModel"), table(
        [t("col.model"), ...modelColumns],
        report.byModel.map((row) => [
          esc(row.label),
          fmtNum(row.calls),
          fmtTokens(row.input),
          fmtTokens(row.output),
          fmtTokens(row.total),
          fmtCost(row.cost),
        ]),
      ));

  return `${header}${cards}
    ${section(t("usage.heatmap"), renderHeatmap(slice.byDay, report.byDay))}
    ${section(t("usage.byDay"), table(
      [t("col.date"), ...dayColumns],
      slice.byDay.map((row) => [
        esc(row.label),
        fmtNum(row.calls),
        fmtTokens(row.input),
        fmtTokens(row.output),
        fmtTokens(row.cacheRead),
        fmtTokens(row.cacheWrite),
        fmtTokens(row.total),
        fmtCost(row.cost),
      ]),
    ))}
    ${byModelSection}
    ${section(t("usage.byProject"), table(
      [t("col.project"), ...modelColumns],
      slice.byProject.map((row) => [
        esc(prettyPath(row.label)),
        fmtNum(row.calls),
        fmtTokens(row.input),
        fmtTokens(row.output),
        fmtTokens(row.total),
        fmtCost(row.cost),
      ]),
    ))}
    ${section(t("usage.bySession"), table(
      [t("col.session"), ...modelColumns],
      slice.bySession.map((row) => [
        esc(row.label),
        fmtNum(row.calls),
        fmtTokens(row.input),
        fmtTokens(row.output),
        fmtTokens(row.total),
        fmtCost(row.cost),
      ]),
    ))}`;
}

/**
 * GitHub-style calendar: one cell per day, columns are weeks, shade is that
 * day's token total.
 *
 * Differences from GitHub, on purpose: the range runs from the first day with
 * usage to today (no year of empty history), and the four shades are quantiles
 * of the non-zero days, so a single huge day cannot flatten everything else
 * into the lightest shade.
 */
function renderHeatmap(byDay, axisDays = byDay) {
  const totalsByDay = new Map(
    byDay.filter((row) => row.key !== "unknown").map((row) => [row.key, row]),
  );
  // The axis always comes from the whole report, not from the current model
  // slice, so switching models re-shades the same grid instead of rescaling it.
  const days = axisDays.filter((row) => row.key !== "unknown").map((row) => row.key).sort();
  if (days.length === 0) return `<div class="settings-empty">${esc(t("usage.heat.none"))}</div>`;

  const thresholds = heatThresholds([...totalsByDay.values()].map((row) => row.total));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dayKey(today);

  // Monday-start weeks: JS counts from Sunday, so shift by one.
  const start = dayFromKey(days[0]);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  const columns = [];
  const cursor = new Date(start);
  // A month label goes on the first week that starts inside that month.
  let lastMonth = -1;
  while (cursor <= today) {
    const cells = [];
    const month = cursor.getMonth();
    const label = month === lastMonth ? "" : monthLabel(cursor);
    lastMonth = month;
    for (let row = 0; row < 7; row += 1) {
      const key = dayKey(cursor);
      const past = cursor <= today;
      const entry = totalsByDay.get(key);
      if (!past) {
        // Days that have not happened yet: no colour, no tooltip.
        cells.push(`<div class="heat-cell future"></div>`);
      } else if (!entry) {
        cells.push(
          `<div class="heat-cell level-0" data-day="${esc(key)}" data-total="0" data-calls="0"></div>`,
        );
      } else {
        cells.push(
          `<div class="heat-cell level-${heatLevel(entry.total, thresholds)}${key === todayKey ? " today" : ""}" ` +
            `data-day="${esc(key)}" data-total="${entry.total}" data-input="${entry.input}" ` +
            `data-output="${entry.output}" data-cache-read="${entry.cacheRead}" ` +
            `data-cache-write="${entry.cacheWrite}" data-reasoning="${entry.reasoning}" ` +
            `data-cost="${entry.cost}" data-calls="${entry.calls}"></div>`,
        );
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(
      `<div class="heat-col"><div class="heat-month">${label ? esc(label) : ""}</div>${cells.join("")}</div>`,
    );
  }

  return `<div class="heatmap-scroll">
    <div class="heatmap">
      <div class="heat-weekdays">
        <div class="heat-month"></div>
        <div>${esc(t("usage.weekday.mon"))}</div><div></div><div>${esc(t("usage.weekday.wed"))}</div><div></div><div>${esc(t("usage.weekday.fri"))}</div><div></div><div></div>
      </div>
      <div class="heat-cols">${columns.join("")}</div>
    </div>
    <div class="heatmap-legend">${esc(t("usage.heat.less"))} <span class="heat-cell level-0"></span><span class="heat-cell level-1"></span><span class="heat-cell level-2"></span><span class="heat-cell level-3"></span><span class="heat-cell level-4"></span> ${esc(t("usage.heat.more"))}</div>
  </div>`;
}

/**
 * Hover card for a heatmap cell: the day's totals, without the ~1s delay and
 * OS styling of a native `title`. The tooltip is a single fixed-position
 * element reused for every cell (and hidden when the grid scrolls, since its
 * coordinates are viewport-based).
 */
function showHeatTip(cell) {
  const { day, total, input, output, cacheRead, cacheWrite, reasoning, cost, calls } = cell.dataset;
  const tip = el.heatTip;
  const rows = Number(calls ?? 0) > 0
    ? [
        `<div class="heat-tip-head">${esc(formatDayLabel(day))}</div>`,
        `<div class="heat-tip-strong">${esc(fmtTokens(total))} token</div>`,
        `<div class="heat-tip-dim">${esc(
          t("usage.heat.tipInput", { input: fmtTokens(input), output: fmtTokens(output) }),
        )}${
          Number(reasoning) > 0 ? esc(t("usage.heat.tipThinking", { reasoning: fmtTokens(reasoning) })) : ""
        }</div>`,
        `<div class="heat-tip-dim">${esc(
          t("usage.heat.tipCache", { cacheRead: fmtTokens(cacheRead), cacheWrite: fmtTokens(cacheWrite) }),
        )}</div>`,
        `<div class="heat-tip-strong">${esc(
          t("usage.heat.tipCalls", { cost: fmtCost(Number(cost ?? 0)), calls: fmtNum(calls) }),
        )}</div>`,
      ].join("")
    : [
        `<div class="heat-tip-head">${esc(formatDayLabel(day))}</div>`,
        `<div class="heat-tip-dim">${esc(t("usage.heat.noRecord"))}</div>`,
      ].join("");

  tip.innerHTML = rows;
  tip.hidden = false;

  // Above the cell, clamped to the viewport; below it when there is no room.
  const cellBox = cell.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  let top = cellBox.top - box.height - 8;
  if (top < 8) top = cellBox.bottom + 8;
  let left = cellBox.left + cellBox.width / 2 - box.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function hideHeatTip() {
  el.heatTip.hidden = true;
}

/** `2026-10-03` → `2026-10-03 Sat` / `2026-10-03 周六`. */
function formatDayLabel(key) {
  const date = dayFromKey(key);
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(date);
  return t("usage.date.weekday", { date: key, weekday });
}

/** Column label above a heatmap week: "10月" / "Oct", in the active locale. */
function monthLabel(date) {
  return new Intl.DateTimeFormat(getLocale(), { month: "short" }).format(date);
}
function heatThresholds(values) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0, 0];
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

function heatLevel(value, thresholds) {
  if (!(value > 0)) return 0;
  let level = 1;
  for (const threshold of thresholds) if (value > threshold) level += 1;
  return Math.min(level, 4);
}

/** `YYYY-MM-DD` (local) → `Date` at local midnight. */
function dayFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function renderResourcesSection(env) {
  if (!env) return `<div class="settings-empty">${esc(t("settings.loading"))}</div>`;

  const skills = env.skills.length
    ? `<ul class="settings-list">${env.skills
        .map(
          (skill) => `<li>
            <div class="item-title">${esc(skill.name)}<span class="settings-tag">${esc(skill.scope)}</span></div>
            ${skill.description ? `<div class="item-meta">${esc(skill.description)}</div>` : ""}
            <div class="item-meta"><code>${esc(prettyPath(skill.path))}</code></div>
          </li>`,
        )
        .join("")}</ul>`
    : `<div class="settings-empty">${esc(
        t("resources.noSkills", { dir: prettyPath(env.agentDir) }),
      )}</div>`;

  const servers = env.mcpServers.length
    ? `<ul class="settings-list">${env.mcpServers
        .map(
          (server) => `<li>
            <div class="item-title">${esc(server.name)}
              <span class="settings-tag">${esc(server.transport)}</span>
              <span class="settings-tag ${server.enabled ? "on" : "off"}">${esc(
                server.enabled ? t("resources.enabled") : t("resources.disabled"),
              )}</span>
              <button class="settings-toggle" type="button" data-mcp-name="${esc(server.name)}" data-mcp-next="${
                server.enabled ? "false" : "true"
              }">${esc(server.enabled ? t("resources.disable") : t("resources.enable"))}</button>
            </div>
            <div class="item-meta"><code>${esc(server.target)}</code></div>
            ${server.description ? `<div class="item-meta">${esc(server.description)}</div>` : ""}
          </li>`,
        )
        .join("")}</ul>
      <div id="mcp-status" class="settings-save-status" aria-live="polite"></div>`
    : `<div class="settings-empty">${esc(
        t("resources.noMcp", { dir: prettyPath(env.agentDir) }),
      )}</div>`;

  const resourceRows = [
    [t("resources.packages"), env.resourcePaths.packages],
    ["extensions", env.resourcePaths.extensions],
    ["skills", env.resourcePaths.skills],
    ["prompts", env.resourcePaths.prompts],
    ["themes", env.resourcePaths.themes],
  ];
  const resources = resourceRows
    .filter(([, list]) => list.length > 0)
    .map(
      ([label, list]) =>
        `<li><div class="item-title">${esc(label)}</div><div class="item-meta">${list
          .map((item) => `<code>${esc(item)}</code>`)
          .join("、")}</div></li>`,
    )
    .join("");

  return `
    <h2>${esc(t("resources.title"))}</h2>
    <p class="settings-lead">${esc(t("resources.lead", { dir: prettyPath(env.agentDir) }))}</p>
    ${section(t("resources.skills", { count: env.skills.length }), skills)}
    ${section(t("resources.mcp", { count: env.mcpServers.length }), servers)}
    ${section(
      t("resources.paths"),
      resources
        ? `<ul class="settings-list">${resources}</ul>`
        : `<div class="settings-empty">${esc(
            t("resources.noPaths", {
              state: env.resourcePaths.enableSkillCommands
                ? t("resources.pathsEnabled")
                : t("resources.pathsDisabled"),
            }),
          )}</div>`,
    )}
    ${notes(env)}`;
}

function renderModelsSection(env) {
  if (!env) return `<div class="settings-empty">${esc(t("settings.loading"))}</div>`;
  return `
    <h2>${esc(t("models.title"))}</h2>
    <p class="settings-lead">${esc(t("models.lead"))}</p>
    ${section(
      t("models.current"),
      keyValueTable([
        [t("models.defaultProvider"), env.defaults.provider ?? t("models.unsetProvider")],
        [t("models.defaultModel"), env.defaults.model ?? t("models.unset")],
        [t("models.defaultThinking"), env.defaults.thinkingLevel ?? t("models.unsetThinking")],
        [t("models.theme"), env.defaults.theme ?? "system"],
        [t("models.hideThinking"), env.defaults.hideThinkingBlock ? t("models.yes") : t("models.no")],
        ["models.json", fileLine(env, "models.json")],
        ["auth.json", fileLine(env, "auth.json")],
      ]),
    )}
    ${section(
      t("models.switchTitle"),
      `<p class="settings-lead" style="margin:0">${esc(t("models.switchLead"))}</p>`,
    )}
    ${section(t("settings.editTitle"), settingsForm(env, MODEL_SETTING_KEYS))}
    ${planned([t("models.plan.2"), t("models.plan.3")])}`;
}

/**
 * Language and theme. Unlike every other section these two are real controls:
 * they are the shell's own preferences, so they need nothing from pi and can be
 * applied immediately.
 */
function renderAppearanceSection() {
  const themes = [
    ["system", t("appearance.themeSystem")],
    ["dark", t("appearance.themeDark")],
    ["light", t("appearance.themeLight")],
  ];
  const themePicker = `<select id="theme-select" class="settings-select">${themes
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === state.theme ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("")}</select>`;
  const localePicker = `<select id="locale-select" class="settings-select">${LOCALES.map(
    (entry) =>
      `<option value="${esc(entry.id)}"${entry.id === getLocale() ? " selected" : ""}>${esc(
        entry.label,
      )}</option>`,
  ).join("")}</select>`;

  return `
    <h2>${esc(t("appearance.title"))}</h2>
    <p class="settings-lead">${esc(t("appearance.lead"))}</p>
    ${section(
      t("appearance.theme"),
      `<div class="settings-toolbar" style="margin:0">${themePicker}</div>`,
    )}
    ${section(
      t("appearance.language"),
      `<div class="settings-toolbar" style="margin:0 0 8px">${localePicker}</div>` +
        `<p class="settings-lead" style="margin:0">${esc(t("appearance.languageNote"))}</p>`,
    )}
    ${section(
      t("appearance.storage"),
      `<p class="settings-lead" style="margin:0">${esc(t("appearance.themeNote"))}</p>` +
        `<p class="settings-lead" style="margin:6px 0 0">${esc(t("appearance.note"))}</p>`,
    )}
    ${planned([t("appearance.plan.2")])}`;
}

function renderAgentSection(env) {
  if (!env) return `<div class="settings-empty">${esc(t("settings.loading"))}</div>`;
  return `
    <h2>${esc(t("agent.title"))}</h2>
    <p class="settings-lead">${esc(t("agent.lead"))}</p>
    ${section(
      t("agent.piDefaults"),
      keyValueTable([
        [t("agent.defaultModel"), `${env.defaults.provider ?? "?"} / ${env.defaults.model ?? "?"}`],
        [t("models.defaultThinking"), env.defaults.thinkingLevel ?? t("models.unset")],
        [t("models.hideThinking"), env.defaults.hideThinkingBlock ? t("models.yes") : t("models.no")],
        [
          t("agent.skillCommands"),
          env.resourcePaths.enableSkillCommands
            ? t("agent.skillCommandsOn")
            : t("agent.skillCommandsOff"),
        ],
      ]),
    )}
    ${section(
      t("agent.configFiles"),
      table(
        [t("agent.colFile"), t("agent.colStatus"), t("agent.colSize"), t("agent.colMtime")],
        env.files.map((file) => [
          `<code>${esc(prettyPath(file.path))}</code>`,
          file.exists ? t("agent.exists") : t("agent.missing"),
          file.sizeBytes === null ? "-" : fmtBytes(file.sizeBytes),
          file.mtime ? relativeTime(file.mtime) : "-",
        ]),
      ),
    )}
    ${section(t("agentsMd.title"), agentsMdEditor(env))}
    ${section(t("agent.service"),
      keyValueTable([
        [t("agent.host"), `${env.server.host}:${env.server.port}`],
        [t("agent.sessionsDir"), prettyPath(env.server.sessionsDir)],
        [t("agent.piBin"), env.server.piBin],
        [t("agent.idle"), t("agent.minutes", { count: Math.round(env.server.idleTimeoutMs / 60000) })],
        [t("agent.agentDir"), prettyPath(env.agentDir)],
      ]),
    )}
    ${section(t("settings.editTitle"), settingsForm(env, AGENT_SETTING_KEYS))}
    ${planned([t("agent.plan.3")])}`;
}

/* ---------- editable settings.json (whitelisted keys, server-validated) ---------- */

/** Editor for the agent dir's AGENTS.md — plain text, backed up server-side. */
function agentsMdEditor(env) {
  if (!env) return `<div class="settings-empty">${esc(t("settings.loading"))}</div>`;
  const listed = env.files.find((file) => file.label === "AGENTS.md");
  // Exists but content is null: too large to edit safely from a textarea.
  if (env.agentsMd === null && listed?.exists) {
    return `<div class="settings-empty">${esc(t("agentsMd.tooLarge"))}</div>`;
  }
  const status = state.agentsMdStatus;
  const statusCls = status ? ` ${status.cls}` : "";
  return `
    <p class="settings-lead" style="margin:0 0 8px">${esc(t("agentsMd.lead"))}</p>
    <textarea id="agents-md" class="settings-textarea" rows="12" spellcheck="false" placeholder="${esc(t("agentsMd.placeholder"))}">${esc(env.agentsMd ?? "")}</textarea>
    <div class="settings-toolbar" style="margin:8px 0 0">
      <button id="agents-md-save" class="settings-save" type="button">${esc(t("agentsMd.save"))}</button>
      <span id="agents-md-status" class="settings-save-status${statusCls}" aria-live="polite">${esc(status?.text ?? "")}</span>
    </div>`;
}

async function saveAgentsMdAction() {
  const button = document.getElementById("agents-md-save");
  const area = document.getElementById("agents-md");
  if (!button || !area) return;
  button.disabled = true;
  state.agentsMdStatus = { cls: "saving", text: t("agentsMd.saving") };
  renderSettings();
  try {
    const result = await api.saveAgentsMd(area.value);
    if (state.settingsData.environment) state.settingsData.environment.agentsMd = area.value;
    state.agentsMdStatus = {
      cls: "ok",
      text: t("agentsMd.saved", {
        backup: result.backup ? result.backup.split("/").pop() : "",
        size: fmtBytes(result.bytes ?? 0),
      }),
    };
  } catch (error) {
    state.agentsMdStatus = { cls: "error", text: error instanceof Error ? error.message : String(error) };
  } finally {
    renderSettings();
    const fresh = document.getElementById("agents-md-save");
    if (fresh) fresh.disabled = false;
  }
}

/** Toggle one MCP server; the whole environment is refetched so tags and
 * lists stay consistent (and the recycled subprocesses reconnect cleanly). */
async function toggleMcpServer(name, enabled, button) {
  if (!name || !button) return;
  button.disabled = true;
  try {
    await api.setMcpEnabled(name, enabled);
    state.settingsData.environment = await api.settingsEnvironment();
    if (state.view === "settings") renderSettings();
  } catch (error) {
    button.disabled = false;
    const status = document.getElementById("mcp-status");
    if (status) {
      status.className = "settings-save-status error";
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}

const MODEL_SETTING_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
const AGENT_SETTING_KEYS = [
  "defaultTools",
  "hideThinkingBlock",
  "showCacheMissNotices",
  "enableSkillCommands",
  "markdown.mermaid",
  "compaction.enabled",
  "compaction.reserveTokens",
  "compaction.keepRecentTokens",
  "images.autoResize",
  "images.blockImages",
  "retry.enabled",
  "retry.maxRetries",
  "retry.baseDelayMs",
  "retry.maxAgentDelayMs",
];

/** Label rows + one save button for a slice of the whitelist. */
function settingsForm(env, keys) {
  const editable = env?.editable;
  if (!editable) return `<div class="settings-empty">${esc(t("settings.loading"))}</div>`;
  const rows = keys
    .filter((key) => editable.keys[key])
    .map((key) => settingRow(key, editable.keys[key], editable.values[key] ?? null))
    .join("");
  return `
    <p class="settings-lead" style="margin:0 0 8px">${esc(t("settings.editLead"))}</p>
    <table class="settings-table kv">${rows}</table>
    <div class="settings-toolbar" style="margin:8px 0 0">
      <button id="settings-save" class="settings-save" type="button">${esc(t("settings.save"))}</button>
      <span id="settings-save-status" class="settings-save-status" aria-live="polite"></span>
    </div>`;
}

/** One control per key. "Unset" is always an option: it removes the key so pi
 * falls back to its built-in default (shown as the placeholder). */
function settingRow(key, spec, value) {
  const unset = value === null || value === undefined;
  const attrs = `data-setting-key="${esc(key)}" data-setting-type="${spec.type}"`;
  let control;
  if (spec.type === "boolean") {
    control = `<select ${attrs} class="settings-select">
      <option value=""${unset ? " selected" : ""}>${esc(t("settings.unset"))} · ${spec.builtin === true ? t("settings.on") : t("settings.off")}</option>
      <option value="true"${value === true ? " selected" : ""}>${esc(t("settings.on"))}</option>
      <option value="false"${value === false ? " selected" : ""}>${esc(t("settings.off"))}</option>
    </select>`;
  } else if (spec.type === "enum") {
    control = `<select ${attrs} class="settings-select">
      <option value=""${unset ? " selected" : ""}>${esc(t("settings.unset"))} · ${esc(String(spec.builtin ?? ""))}</option>
      ${(spec.values ?? []).map((v) => `<option value="${esc(v)}"${value === v ? " selected" : ""}>${esc(v)}</option>`).join("")}
    </select>`;
  } else if (spec.type === "number") {
    control = `<input ${attrs} class="settings-input" type="number" inputmode="numeric" min="${spec.min ?? 0}"${spec.max !== undefined ? ` max="${spec.max}"` : ""} value="${unset ? "" : Number(value)}" placeholder="${Number(spec.builtin ?? 0)}" />`;
  } else if (spec.type === "string[]") {
    control = `<input ${attrs} class="settings-input" value="${unset ? "" : esc((value || []).join(", "))}" placeholder="${esc(String(spec.builtin ?? ""))}" />`;
  } else {
    control = `<input ${attrs} class="settings-input" value="${unset ? "" : esc(String(value))}" placeholder="${esc(t("settings.autoHint"))}" />`;
  }
  return `<tr><td class="row-label">${esc(t(`settings.key.${key}`))}</td><td>${control}</td></tr>`;
}

/** Read the rendered controls back into a flat patch; null = remove key. */
function collectEditablePatch() {
  const patch = {};
  for (const control of document.querySelectorAll("[data-setting-key]")) {
    const key = control.dataset.settingKey;
    if (control.tagName === "SELECT") {
      const raw = control.value;
      patch[key] = raw === "" ? null : raw === "true" ? true : raw === "false" ? false : raw;
    } else if (control.dataset.settingType === "number") {
      patch[key] = control.value === "" ? null : Number(control.value);
    } else {
      const raw = control.value.trim();
      if (raw === "") patch[key] = null;
      else if (control.dataset.settingType === "string[]") patch[key] = raw.split(/[,，\s]+/).filter(Boolean);
      else patch[key] = raw;
    }
  }
  return patch;
}

async function saveEditableSettings() {
  const button = document.getElementById("settings-save");
  const status = document.getElementById("settings-save-status");
  if (!button || !status) return;
  button.disabled = true;
  status.className = "settings-save-status";
  status.textContent = t("settings.saving");
  // Kept in state: the background re-render below (and any other rerender)
  // rebuilds the DOM, and the message must survive it.
  state.settingsSaveStatus = null;
  try {
    const result = await api.saveSettings(collectEditablePatch());
    const env = state.settingsData.environment;
    if (env) {
      env.editable.values = result.values;
      env.defaults.provider = result.values["defaultProvider"] ?? null;
      env.defaults.model = result.values["defaultModel"] ?? null;
      env.defaults.thinkingLevel = result.values["defaultThinkingLevel"] ?? null;
      env.defaults.hideThinkingBlock = result.values["hideThinkingBlock"] === true;
    }
    state.settingsSaveStatus = {
      cls: "settings-save-status ok",
      text: t("settings.saved", { backup: result.backup ? result.backup.split("/").pop() : "" }),
    };
    renderSettings();
    // File sizes/mtimes in the read-only tables are stale now; refresh quietly.
    void (async () => {
      try {
        state.settingsData.environment = await api.settingsEnvironment();
        if (state.view === "settings" && state.settingsSection !== "usage") renderSettings();
      } catch {
        /* keep the optimistic copy */
      }
    })();
  } catch (error) {
    state.settingsSaveStatus = {
      cls: "settings-save-status error",
      text: error instanceof Error ? error.message : String(error),
    };
    renderSettings();
  } finally {
    button.disabled = false;
  }
}

/* ---------- small render helpers for the settings page ---------- */

function section(title, body) {
  return `<h3>${esc(title)}</h3>${body}`;
}

function card(label, value, sub) {
  return `<div class="settings-card">
    <div class="card-label">${esc(label)}</div>
    <div class="card-value">${esc(value)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

/** `rows` are already-escaped HTML cells; the first column is the label. */
function table(headers, rows) {
  if (rows.length === 0) return `<div class="settings-empty">${esc(t("settings.noData"))}</div>`;
  const head = headers.map((text) => `<th>${esc(text)}</th>`).join("");
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map((cell, index) => `<td class="${index === 0 ? "row-label" : ""}">${cell}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="settings-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function keyValueTable(pairs) {
  return `<table class="settings-table kv"><tbody>${pairs
    .map(([key, value]) => `<tr><td class="row-label">${esc(key)}</td><td>${value}</td></tr>`)
    .join("")}</tbody></table>`;
}

/** "What is planned here", rendered as a dashed box rather than a dead form. */
function planned(items) {
  return `<h3>${esc(t("settings.planned"))}</h3>
    <div class="settings-todo">
      <div class="muted">${esc(t("settings.plannedNote"))}</div>
      <ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
    </div>`;
}

/** Footnote box. `noteIds` are dictionary keys, so unknown ones are dropped. */
function notes(env) {
  const lines = (env.noteIds ?? [])
    .map((id) => t(`settings.note.${id}`))
    .filter((line) => !line.startsWith("settings.note."));
  if (lines.length === 0) return "";
  return `<div class="settings-todo" style="margin-top:18px"><ul>${lines
    .map((line) => `<li>${esc(line)}</li>`)
    .join("")}</ul></div>`;
}

function fileLine(env, label) {
  const file = env.files.find((entry) => entry.label === label);
  if (!file || !file.exists) return t("agent.missing");
  return t("agent.fileLine", {
    size: fmtBytes(file.sizeBytes ?? 0),
    time: relativeTime(file.mtime ?? ""),
  });
}

function fmtNum(value) {
  return Number(value).toLocaleString("en-US");
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
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
      title: t("prompt.newSessionTitle"),
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
  const answer = window.prompt(t("prompt.newFolder"), suggestion);
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
  const answer = window.prompt(t("prompt.rename"), current);
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
    window.alert(t("alert.renameFailed", { message: error.message }));
  }
}

/**
 * Delete a session (trash when available, else unlink). Deleting the open
 * session also closes its stream so the dead pi subprocess is reaped.
 */
async function deleteSession(session) {
  const label = session.title.length > 40 ? `${session.title.slice(0, 40)}…` : session.title;
  const ok = window.confirm(t("confirm.deleteSession", { label, path: prettyPath(session.cwd) }));
  if (!ok) return;

  try {
    await api.deleteSession(session.path);
    if (state.path === session.path) {
      closeStream();
      state.path = null;
      el.messages.innerHTML = "";
      el.chatTitle.textContent = t("chat.selectSession");
      el.chatMeta.textContent = "";
    }
    await refreshSessionList();
  } catch (error) {
    window.alert(t("alert.deleteFailed", { message: error.message }));
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
    t("confirm.deleteFolder", { label, count: folder.sessionCount }),
  );
  if (!ok) return;

  try {
    const result = await api.deleteFolderSessions(folder.cwd);
    const inThisFolder = state.path && state.sessions.some((s) => s.path === state.path && s.cwd === folder.cwd);
    if (inThisFolder) {
      closeStream();
      state.path = null;
      el.messages.innerHTML = "";
      el.chatTitle.textContent = t("chat.selectSession");
      el.chatMeta.textContent = "";
    }
    if (state.cwd === folder.cwd) state.cwd = null;
    await refreshSessionList();
    window.alert(t("alert.deletedFolder", { count: result.deleted }));
  } catch (error) {
    window.alert(t("alert.deleteFailed", { message: error.message }));
  }
}

function bind() {
  el.send.onclick = sendMessage;
  el.abort.onclick = async () => {
    if (!state.path) return;
    markAborted(state.path);
    try {
      await api.abort(state.path);
    } catch (error) {
      addNotice(t("chat.abortFailed", { message: error.message }), "error");
    }
  };
  el.attach.onclick = () => el.file.click();
  el.file.onchange = () => {
    addFiles(el.file.files);
    el.file.value = "";
  };
  el.refresh.onclick = refreshSessionList;
  el.settings.onclick = () => openSettings();
  el.treeBtn.onclick = openTreePanel;
  el.treeClose.onclick = closeTreePanel;
  el.treeClone.onclick = cloneActiveSession;
  // Click on the backdrop closes; the card stops the event from reaching it.
  el.treePanel.addEventListener("click", (event) => {
    if (event.target === el.treePanel) closeTreePanel();
  });
  el.lightbox.addEventListener("click", closeLightbox);
  el.settingsBack.onclick = closeSettings;
  el.settingsMenu.addEventListener("click", (event) => {
    const item = event.target.closest(".settings-menu");
    if (item?.dataset.section) selectSettingsSection(item.dataset.section);
  });

  // Heatmap hover card. Delegated, because the grid is re-rendered on every
  // filter change; `relatedTarget` keeps moving between cells from flickering.
  el.settingsBody.addEventListener("pointerover", (event) => {
    const cell = event.target.closest?.(".heat-cell[data-day]");
    if (cell) showHeatTip(cell);
  });
  el.settingsBody.addEventListener("pointerout", (event) => {
    if (!event.target.closest?.(".heat-cell")) return;
    // Still inside another cell? Let the following pointerover take over.
    if (event.relatedTarget?.closest?.(".heat-cell")) return;
    hideHeatTip();
  });
  // The tip is positioned in viewport coordinates, so scrolling invalidates it.
  el.settingsBody.addEventListener("scroll", hideHeatTip);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // A blocking dialog owns Escape: the extension is waiting on it, and it is
    // the only thing the user can act on until it is dismissed.
    if (state.dialog) {
      event.preventDefault();
      answerDialog(state.dialog, { cancelled: true });
      return;
    }
    // Overlays sit above the settings view in the Escape pecking order.
    if (!el.treePanel.hidden || !el.lightbox.hidden) {
      event.preventDefault();
      closeTreePanel();
      closeLightbox();
      return;
    }
    if (state.view === "settings") {
      event.preventDefault();
      closeSettings();
    }
  });
  // Browser Back/Forward must move between the app's own views, never off the
  // page. The pushed entries carry their view; anything else is the chat.
  window.addEventListener("popstate", () => {
    applyView(history.state?.piShellView === "settings" ? "settings" : "chat");
  });
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
      addNotice(t("common.error", { message: error.message }), "error");
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
      addNotice(t("common.error", { message: error.message }), "error");
    } finally {
      el.thinkingSelect.disabled = false;
    }
  };

  el.input.addEventListener("input", () => {
    autoGrow();
    updateCommandMenu();
  });
  el.input.addEventListener("keydown", (event) => {
    const menuOpen = !el.commandMenu.hidden;

    if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const count = state.commandMatches.length;
      state.commandIndex = (state.commandIndex + delta + count) % count;
      renderCommandMenu();
      return;
    }
    if (menuOpen && event.key === "Tab") {
      event.preventDefault();
      completeCommand();
      return;
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      hideCommandMenu();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // Accept the highlighted command unless the input already spells one out
      // exactly — `/probe` + Enter should run it, not complete it to `/probe `.
      if (menuOpen && !isExactCommand(el.input.value)) {
        completeCommand();
        return;
      }
      sendMessage();
    }
  });
  el.commandList.addEventListener("click", (event) => {
    const item = event.target.closest(".command-item");
    if (item) completeCommand(Number(item.dataset.index));
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
  state.defaultTitle = document.title;
  // /settings survives a refresh or a deep link: restore the view and take
  // ownership of the current history entry (marked not-pushed, so closing
  // settings replaces it in place instead of exiting via back()).
  const initialView = location.pathname === SETTINGS_ROUTE ? "settings" : "chat";
  history.replaceState(
    { piShellView: initialView, pushed: false },
    "",
    initialView === "settings" ? SETTINGS_ROUTE : "/",
  );
  applyView(initialView);
  if (initialView === "settings") selectSettingsSection();
  initPreferences();
  bind();
  initSidebar();
  observeMermaid();
  openActivityStream();
  await refreshSessionList();
  if (state.folders.length > 0) {
    await selectFolder(state.folders[0].cwd);
    const first = state.sessions.filter((s) => s.cwd === state.folders[0].cwd)[0];
    if (first) await openSession(first);
  } else {
    el.chatTitle.textContent = t("chat.noSessions");
    el.chatMeta.textContent = state.home ? t("chat.noSessionsHint", { home: prettyPath(state.home) }) : "";
    addNotice(t("chat.noSessionsNotice"));
  }
}

main();

// Exposed so the automated UI checks can assert on internal state.
globalThis.piShellDebug = {
  state,
  handleEvent,
  openSettings,
  closeSettings,
  selectSettingsSection,
  openTreePanel,
  closeTreePanel,
  renderTree,
  openLightbox,
  closeLightbox,
  applyActivity,
  handleActivityFrame,
  handleSnapshot,
  markAborted,
  setTheme,
  setLanguage,
  applyTheme,
  currentSpeed,
  estimateTokens,
  fmtDuration,
  fmtClock,
  fmtTokens,
  fmtCost,
  messageText,
  renderMarkdown,
  localImageSrc,
};
