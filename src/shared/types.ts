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

/** Snapshot sent as the first SSE frame when a stream opens. */
export interface StreamSnapshot {
  type: "snapshot";
  state: PiSessionState;
  messages: unknown[];
  stats: SessionStats | null;
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
