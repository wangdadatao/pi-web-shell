/**
 * Wire types shared between the server and the browser client.
 *
 * The browser client is plain JavaScript, so these types exist for the server
 * (and for humans reading the protocol). Keep this file free of runtime code.
 */

/** One persisted pi session, summarized for the sidebar. */
export interface SessionSummary {
  /** Absolute path to the session `.jsonl` file. */
  path: string;
  /** Session id from the file header. */
  id: string;
  /** Working directory the session belongs to (authoritative: read from the file). */
  cwd: string;
  /** ISO timestamp from the file header. */
  createdAt: string;
  /** File mtime, ISO string. Used for sorting and "last activity". */
  updatedAt: string;
  mtimeMs: number;
  sizeBytes: number;
  /** User-assigned name from `/name`, if any. */
  name?: string;
  /** Display title: name, else the first user message, else a placeholder. */
  title: string;
  /** Session file format version. */
  version: number;
  /**
   * True while this session's pi subprocess is mid-run (`agent_start` until
   * `agent_settled`). Only sessions owned by this server can report this;
   * a pi process started elsewhere (e.g. a terminal) is invisible here.
   */
  running?: boolean;
  /**
   * True for a session that exists only in memory: pi has reserved a session
   * file path but has not written it yet (the file appears with the first
   * prompt). Surfaced so a just-created session can be listed before it lands
   * on disk.
   */
  pending?: boolean;
}

/** A working directory that has at least one session. */
export interface FolderSummary {
  cwd: string;
  sessionCount: number;
  lastActivity: string;
  lastActivityMs: number;
}

export interface SessionsResponse {
  /** User home directory, so the client can render paths as ~/foo. */
  home: string;
  folders: FolderSummary[];
  sessions: SessionSummary[];
}

/**
 * Fire-and-forget extension UI state for one session (`setStatus`, `setWidget`,
 * `setTitle`).
 *
 * pi emits these once, often before any browser is attached, so the server
 * caches the latest value per key and replays it in the stream snapshot — a
 * refresh or a session switch must not lose a widget the extension pinned.
 */
export interface ExtensionUiState {
  /** Footer status entries, in the order the extension set them. */
  status: Array<{ key: string; text: string }>;
  /** Widgets the extension pinned above or below the editor. */
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  /** Window title override, or null for the shell's own title. */
  title: string | null;
}

/**
 * One `extension_ui_request` from pi.
 *
 * Dialog methods (`select`, `confirm`, `input`, `editor`) block the extension
 * until the browser answers through `POST /api/ui-response`; every other method
 * is fire-and-forget. Method-specific fields sit alongside the shared ones.
 */
export interface ExtensionUiRequest extends Record<string, unknown> {
  type: "extension_ui_request";
  id: string;
  method: string;
}

/** `POST /api/ui-response` — the browser's answer to one dialog request. */
export interface ExtensionUiResponseBody {
  /** Session whose pi subprocess emitted the request. */
  path: string;
  /** `id` from the request. */
  id: string;
  /** `select` / `input` / `editor` answer. */
  value?: string;
  /** `confirm` answer. */
  confirmed?: boolean;
  /** Any dialog: dismiss it. */
  cancelled?: boolean;
}

/** Snapshot sent as the first SSE frame when a stream opens. */
export interface StreamSnapshot {
  type: "snapshot";
  state: PiSessionState;
  messages: unknown[];
  stats: SessionStats | null;
  /** Fire-and-forget extension state, so a late attach does not miss it. */
  ui: ExtensionUiState;
}

/** Token / cost / context-window accounting from `get_session_stats`. */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

/** Pushed after a run settles so the stats bar stays current. */
export interface StreamStats {
  type: "stats";
  stats: SessionStats | null;
}

/** A raw pi session event, forwarded verbatim. */
export interface StreamEvent {
  type: "event";
  event: { type: string } & Record<string, unknown>;
}

export interface StreamError {
  type: "error";
  error: string;
}

export type StreamFrame = StreamSnapshot | StreamEvent | StreamError | StreamStats;

/**
 * One frame on the global `/api/events` stream: a session's run state changed.
 *
 * This is the push half of the sidebar's activity indicator. It carries no
 * transcript, so it is cheap to broadcast to every open tab and independent of
 * which session (if any) a tab is currently viewing.
 */
export interface ActivityFrame {
  type: "activity";
  /** Absolute session file path. */
  path: string;
  running: boolean;
}

/** Subset of the `get_state` response we expose to the client. */
export interface PiSessionState {
  sessionId: string | null;
  sessionName: string | null;
  sessionFile: string | null;
  model: { provider: string; id: string; name?: string } | null;
  thinkingLevel: string | null;
  isStreaming: boolean;
  messageCount: number;
}

/** One entry in the model picker. */
export interface ModelOption {
  provider: string;
  /** Provider-scoped model id, unique within `provider`. */
  id: string;
  name?: string;
}

/** `GET /api/models` — the model/thinking choices for an open session. */
export interface ModelsResponse {
  models: ModelOption[];
  /** Current model as `provider/id`, for preselecting the dropdown. */
  model: string | null;
  /** Thinking levels the current model supports (["off"] when it has none). */
  thinkingLevels: string[];
  thinkingLevel: string | null;
}

/** One slash command the current session exposes (`get_commands`). */
export interface CommandInfo {
  /** Name without the leading slash; skill commands are prefixed `skill:`. */
  name: string;
  description: string;
  /**
   * `extension` | `prompt` | `skill`. Kept as a string rather than a union so a
   * source pi adds later is shown verbatim instead of being dropped.
   */
  source: string;
}

/**
 * `GET /api/commands` — what the composer's command menu can offer.
 *
 * Deliberately only commands that run through the `prompt` RPC. Built-in TUI
 * commands are absent because pi does not execute them from `prompt`; listing
 * them would promise something that cannot work.
 */
export interface CommandsResponse {
  commands: CommandInfo[];
}

/* ---------- settings page: token accounting ---------- */

/** Token and cost totals summed over assistant messages. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output` the provider billed as reasoning tokens. */
  reasoning: number;
  /** Provider-reported `totalTokens` (input + output, cache included). */
  total: number;
  /** US dollars, as reported per message by pi. */
  cost: number;
  /** Assistant messages that carried a usage record. */
  calls: number;
}

/** One row of a usage breakdown (a day, a model, a project, or a session). */
export interface UsageRow extends UsageTotals {
  /** Stable identity: `2026-10-03`, `provider/model`, a cwd, or a session path. */
  key: string;
  /** Human-readable label chosen by the server (dates, titles, paths). */
  label: string;
}

/** One model's slice of the report: the same breakdowns, restricted. */
export interface UsageSlice {
  totals: UsageTotals;
  /** Newest day first. */
  byDay: UsageRow[];
  /** Highest cost first. */
  byProject: UsageRow[];
  /** Highest cost first, capped at the top `SESSION_ROWS`. */
  bySession: UsageRow[];
}

/** `GET /api/settings/usage` — cross-session token/cost totals. */
export interface UsageReport {
  /** Always `all`: there is no date-range filter yet. */
  scope: "all";
  /** How much work the report cost, so a slow first scan is explicable. */
  scanned: { files: number; messages: number; ms: number };
  totals: UsageTotals;
  /** Newest day first. */
  byDay: UsageRow[];
  /** Highest cost first. */
  byModel: UsageRow[];
  byProject: UsageRow[];
  /** Highest cost first, capped at the top `SESSION_ROWS`. */
  bySession: UsageRow[];
  /**
   * The same breakdowns per model, keyed by `provider/model`.
   *
   * Carried in the report so the UI's model filter is instant instead of a
   * second round trip: the numbers come from the same scan, and there are only
   * as many slices as there are models.
   */
  models: Record<string, UsageSlice>;
}

/* ---------- settings page: environment (read-only) ---------- */

/** One installed skill, discovered from the agent directory. */
export interface SkillInfo {
  name: string;
  description: string;
  /** `SKILL.md` (or the single `.md` file) that defines it. */
  path: string;
  /** Where it came from: the agent directory, or the project's `.pi/`. */
  scope: "user" | "project";
}

/** One configured MCP server, as read from `mcp.json` (no connection is made). */
export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  /** HTTP url, or the command line for a stdio server. */
  target: string;
  enabled: boolean;
  description: string;
  /** `mcp.json` that defines it. */
  source: string;
}

/** A config file the settings page reports on, with its current state. */
export interface ConfigFileInfo {
  label: string;
  path: string;
  exists: boolean;
  /** ISO string, or null when the file does not exist. */
  mtime: string | null;
  sizeBytes: number | null;
}

/** Resource lists from `settings.json`, shown verbatim. */
export interface ResourcePaths {
  packages: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
  enableSkillCommands: boolean;
}

/** Startup preferences pi reads from `settings.json` (read-only for now). */
export interface AgentDefaults {
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  theme: string | null;
  hideThinkingBlock: boolean;
}

/** `GET /api/settings/environment` — what pi will load, as it is right now. */
export interface SettingsEnvironment {
  /** pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  agentDir: string;
  files: ConfigFileInfo[];
  defaults: AgentDefaults;
  resourcePaths: ResourcePaths;
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
  /** How this web shell itself is configured (env vars, not pi's files). */
  server: {
    host: string;
    port: number;
    sessionsDir: string;
    piBin: string;
    idleTimeoutMs: number;
  };
  /**
   * Footnotes for the page, as codes rather than prose: the server has no
   * business knowing what language the browser is in. The client renders them
   * from `settings.note.<id>`, and unknown ids are skipped.
   */
  noteIds: string[];
}
