import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createGzip, constants as zlibConstants } from "node:zlib";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { isHostAllowed } from "./hostCheck.ts";
import { ImageStore, isImageHash, stripInlineImages } from "./imageStore.ts";
import { loadLocalImage } from "./localImage.ts";
import { collectEnvironment } from "./environment.ts";
import { SettingsValidationError, applySettingsPatch, setMcpEnabled, writeAgentsMd } from "./settingsStore.ts";
import { activeUserEntryIds, reshapeTree } from "./treeView.ts";
import { normalizeCommands } from "./commands.ts";
import { buildUiResponse } from "./extensionUi.ts";
import { UsageIndex } from "./usageStats.ts";
import { normalizeSessionKey } from "./paths.ts";
import type { SessionIndex } from "./sessionIndex.ts";
import type { ManagedSession, SessionRegistry } from "./sessionRegistry.ts";
import type {
  FolderSummary,
  ModelOption,
  ModelsResponse,
  CommandsResponse,
  PiSessionState,
  SessionStats,
  SessionSummary,
  StreamFrame,
  ActivityFrame,
} from "../shared/types.ts";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export interface ServerDeps {
  config: Config;
  index: SessionIndex;
  registry: SessionRegistry;
}

export function createApp(deps: ServerDeps): Server {
  const { config, index, registry } = deps;
  const images = new ImageStore();
  // Machine-wide token totals, cached per session file by mtime + size.
  const usage = new UsageIndex(config.sessionsDir);

  return createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: on a loopback bind, only loopback Host headers
      // may talk to us. Checked before any route does work.
      if (!isHostAllowed(req.headers.host, config.host)) {
        return sendJson(res, 403, { error: "Forbidden Host header" });
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = `${req.method ?? "GET"} ${url.pathname}`;

      if (url.pathname.startsWith("/api/image/")) {
        return serveImage(res, images, url.pathname.slice("/api/image/".length));
      }

      if (route === "GET /api/local-image") {
        return serveLocalImage(req, res, url);
      }

      if (route === "GET /api/sessions") {
        return sendJson(res, 200, await collectSessions(deps));
      }

      if (route === "POST /api/sessions/new") {
        return handleNewSession(req, res, deps);
      }

      if (route === "GET /api/stream") {
        return handleStream(req, res, url, deps, images);
      }

      if (route === "GET /api/events") {
        return handleEvents(req, res, deps);
      }

      if (route === "GET /api/tree") {
        // The branch tree of the open session, reshaped light for the panel.
        const managed = registry.get(url.searchParams.get("path") ?? "");
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        const data = await managed.rpc.send({ type: "get_tree" });
        return sendJson(res, 200, reshapeTree(data));
      }
      if (route === "POST /api/fork") {
        const body = await readJson(req);
        const managed = registry.get(String(body["path"] ?? ""));
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        let entryId = String(body["entryId"] ?? "");
        // The transcript carries no entry ids, so the inline edit/delete buttons
        // send "the Nth user message from the end" and it is resolved here
        // against the active branch. Only paid on click, not on every snapshot.
        // The cost is `get_entries` — the whole session, abandoned branches and
        // pre-compaction history included. Fine for a click; it is the price of
        // `get_messages` not carrying ids and `get_fork_messages` not being
        // branch-filtered.
        if (!entryId && body["fromEnd"] !== undefined) {
          const fromEnd = Number(body["fromEnd"]);
          const entries = await managed.rpc.send<Record<string, unknown>>({ type: "get_entries" });
          const ids = activeUserEntryIds(entries);
          const index = ids.length - 1 - fromEnd;
          if (!Number.isInteger(fromEnd) || fromEnd < 0 || index < 0 || index >= ids.length) {
            return sendJson(res, 400, { error: "no such user message on the active branch" });
          }
          entryId = ids[index] ?? "";
        }
        if (!entryId) return sendJson(res, 400, { error: "entryId required" });
        const data = (await managed.rpc.send({ type: "fork", entryId })) as Record<string, unknown>;
        if (data["cancelled"] === true) {
          return sendJson(res, 200, { ok: true, cancelled: true, text: null, entryId, sessionFile: null });
        }
        // Forking the first message has no parent to rewind to, so pi re-roots
        // into a *new* session file. Tell the client, which must follow it —
        // otherwise the tab keeps streaming a subprocess that is now writing a
        // different file under this one's name. Same drift guard as /api/clone.
        const state = await getState(managed.rpc);
        const sessionFile = typeof state["sessionFile"] === "string" ? state["sessionFile"] : null;
        const switched = Boolean(sessionFile) && normalizeSessionKey(sessionFile!) !== managed.path;
        if (switched) await registry.dispose(managed.path);
        return sendJson(res, 200, {
          ok: true,
          cancelled: false,
          text: data["text"] ?? null,
          entryId,
          sessionFile: switched ? sessionFile : null,
        });
      }
      if (route === "POST /api/clone") {
        const body = await readJson(req);
        const managed = registry.get(String(body["path"] ?? ""));
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        const data = (await managed.rpc.send({ type: "clone" })) as Record<string, unknown>;
        if (data["cancelled"] === true) return sendJson(res, 200, { ok: true, cancelled: true, sessionFile: null });
        // clone does not say where the copy landed; the subprocess knows.
        const state = await getState(managed.rpc);
        const sessionFile = typeof state["sessionFile"] === "string" ? state["sessionFile"] : null;
        // After a clone the subprocess may have switched files; drop it so the
        // next acquire respawns on the session this tab actually shows.
        if (sessionFile && normalizeSessionKey(sessionFile) !== managed.path) {
          await registry.dispose(managed.path);
        }
        return sendJson(res, 200, { ok: true, cancelled: false, sessionFile });
      }
      if (route === "POST /api/prompt") {
        return handlePrompt(req, res, deps);
      }

      if (route === "POST /api/ui-response") {
        return handleUiResponse(req, res, deps);
      }

      if (route === "POST /api/abort") {
        const body = await readJson(req);
        const managed = registry.get(String(body.path ?? ""));
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        await managed.rpc.send({ type: "abort" }, 60_000);
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/rename") {
        return handleRename(req, res, deps);
      }

      if (route === "POST /api/delete") {
        return handleDelete(req, res, deps);
      }

      if (route === "POST /api/delete-folder") {
        return handleDeleteFolder(req, res, deps);
      }

      if (route === "POST /api/model") {
        const body = await readJson(req);
        const managed = registry.get(String(body.path ?? ""));
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        const data = await managed.rpc.send({
          type: "set_model",
          provider: body.provider,
          modelId: body.modelId,
        });
        return sendJson(res, 200, { ok: true, data });
      }

      if (route === "POST /api/thinking") {
        const body = await readJson(req);
        const managed = registry.get(String(body.path ?? ""));
        if (!managed) return sendJson(res, 404, { error: "session not open" });
        const data = await managed.rpc.send({
          type: "set_thinking_level",
          level: body.level,
        });
        return sendJson(res, 200, { ok: true, data });
      }

      if (route === "GET /api/models") {
        return handleModels(res, url, deps);
      }

      if (route === "GET /api/commands") {
        return handleCommands(res, url, deps);
      }

      // Settings page: the two read endpoints below, plus the write endpoints
      // further down (settings.json / AGENTS.md / mcp.json).
      // Titles come from the session index so usage rows read like the sidebar.
      if (route === "GET /api/settings/usage") {
        const titles = new Map((await index.listSessions()).map((s) => [s.path, s.title]));
        return sendJson(res, 200, await usage.report(titles));
      }

      if (route === "GET /api/settings/environment") {
        return sendJson(res, 200, await collectEnvironment(config));
      }
      if (route === "POST /api/settings/agents-md") {
        // Global instructions: a plain file replace with the same backup and
        // subprocess-recycling guarantees as the settings.json patch.
        const body = await readJson(req);
        try {
          const result = await writeAgentsMd(config.agentDir, String(body["content"] ?? ""));
          await deps.registry.disposeAll();
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof SettingsValidationError) return sendJson(res, 400, { error: error.message });
          throw error;
        }
      }
      if (route === "POST /api/settings/mcp") {
        // Toggle one entry's `enabled` flag in mcp.json the way pi writes it
        // itself: `false` keeps the entry disconnected, absent means enabled.
        const body = await readJson(req);
        try {
          const result = await setMcpEnabled(config.agentDir, String(body["name"] ?? ""), body["enabled"] === true);
          await deps.registry.disposeAll();
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof SettingsValidationError) return sendJson(res, 400, { error: error.message });
          throw error;
        }
      }
      if (route === "POST /api/settings/save") {
        // A whitelisted `{key: value|null}` patch — never a document to write
        // verbatim. Validation, backup, and the atomic write live in the store.
        const patch = await readJson(req);
        try {
          const result = await applySettingsPatch(config.agentDir, patch);
          // Deliberately NOT disposing warm subprocesses.
          //
          // settings.json holds *startup* defaults. pi resolves a resumed
          // session's model from that session's own `model_change` entry and
          // only falls back to `defaultProvider`/`defaultModel` when the
          // session never picked one (see pi's core/sdk.js). Recycling every
          // warm child on save would therefore not just cut a running turn
          // short, it would rewrite the effective model of every existing
          // conversation that was still on the default. The change lands where
          // it belongs: on the next subprocess spawned — a new conversation.
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof SettingsValidationError) {
            return sendJson(res, 400, { error: error.message });
          }
          throw error;
        }
      }

      if (req.method === "GET") {
        return serveStatic(url.pathname, res);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
  });
}

async function collectSessions(deps: ServerDeps): Promise<{
  home: string;
  folders: FolderSummary[];
  sessions: SessionSummary[];
}> {
  const { config, index, registry } = deps;
  const sessions = await index.listSessions();
  const knownPaths = new Set(sessions.map((session) => session.path));

  // Sessions that pi has reserved but not written yet (created, no prompt sent).
  // The subprocess holds any rename in memory, so ask it for the current name.
  const pending: SessionSummary[] = [];
  const reserved = registry
    .list()
    .filter((managed) => !knownPaths.has(managed.path) && !existsSync(managed.path));
  await Promise.all(
    reserved.map(async (managed) => {
      let title = "新会话";
      try {
        const state = (await managed.rpc.send({ type: "get_state" }, 5_000)) as Record<string, unknown>;
        const name = state["sessionName"];
        if (typeof name === "string" && name !== "") title = name;
      } catch {
        // Subprocess busy or dying: keep the placeholder.
      }
      pending.push({
        path: managed.path,
        id: managed.path,
        cwd: managed.cwd,
        createdAt: managed.createdAt,
        updatedAt: managed.createdAt,
        mtimeMs: Date.now(),
        sizeBytes: 0,
        title,
        name: title !== "新会话" ? title : undefined,
        version: 3,
        pending: true,
      });
    }),
  );

  const all = [...pending, ...sessions];
  const running = new Set(
    registry
      .list()
      .filter((managed) => managed.streaming)
      .map((managed) => managed.path),
  );
  const withActivity = all.map((session) =>
    running.has(session.path) ? { ...session, running: true } : session,
  );
  const folders = await index.listFolders(withActivity);
  return { home: config.home, folders, sessions: withActivity };
}

async function handleNewSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJson(req);
  const requested = String(body["cwd"] ?? "").trim();
  if (requested === "") {
    return sendJson(res, 400, { error: "cwd is required" });
  }

  let cwd: string;
  try {
    // Resolve symlinks so the reported cwd matches what pi sees
    // (on macOS /tmp is a symlink to /private/tmp).
    cwd = await realpath(resolve(requested));
  } catch {
    return sendJson(res, 400, { error: `目录不存在：${requested}` });
  }

  const info = await stat(cwd);
  if (!info.isDirectory()) {
    return sendJson(res, 400, { error: `不是目录：${cwd}` });
  }

  const { managed, state } = await deps.registry.createSession(cwd);
  return sendJson(res, 200, {
    path: managed.path,
    cwd: managed.cwd,
    createdAt: managed.createdAt,
    state: normalizeState(state),
  });
}

/**
 * Rename via pi's own `set_session_name` RPC: it appends a `session_info` entry
 * (persisted or held in memory until the first flush) and emits
 * `session_info_changed`, which live streams already forward.
 *
 * The client may fire this right after opening a session whose pi subprocess
 * is still starting (the exact-registry miss). Fall back to `acquire` — the
 * same dedup the SSE stream uses — so the rename waits for that startup
 * instead of 404-ing, then hands the reference back.
 */
async function handleRename(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJson(req);
  const rawPath = String(body.path ?? "");
  const name = String(body.name ?? "").trim();
  if (name === "") return sendJson(res, 400, { error: "name is required" });

  const key = normalizeSessionKey(rawPath);
  const managed = deps.registry.get(key);
  if (managed) {
    await managed.rpc.send({ type: "set_session_name", name });
    return sendJson(res, 200, { ok: true, name });
  }

  const summary = await deps.index.get(key);
  if (!summary) return sendJson(res, 404, { error: "session not open" });
  const acquired = await deps.registry.acquire(key, summary.cwd);
  try {
    await acquired.rpc.send({ type: "set_session_name", name });
  } finally {
    deps.registry.release(acquired);
  }
  return sendJson(res, 200, { ok: true, name });
}

/**
 * Delete a session file. pi itself has no delete RPC; its TUI moves the file to
 * the macOS trash via the `trash` CLI and falls back to unlink. We mirror that,
 * so a delete stays recoverable where `trash` is available.
 */
async function handleDelete(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJson(req);
  const sessionPath = normalizeSessionKey(String(body.path ?? ""));
  const sessionsRoot = normalizeSessionKey(deps.config.sessionsDir);

  if (!isInside(sessionsRoot, sessionPath) || !sessionPath.endsWith(".jsonl")) {
    return sendJson(res, 400, { error: "invalid session path" });
  }

  const live = deps.registry.get(sessionPath);
  if (live) await deps.registry.dispose(sessionPath);

  if (!existsSync(sessionPath)) return sendJson(res, 200, { ok: true, method: "gone" });

  const method = await trashOrUnlink(sessionPath);
  if (!method) return sendJson(res, 500, { error: `删除失败：${sessionPath}` });
  return sendJson(res, 200, { ok: true, method });
}

/** `trash <path>` if available (recoverable), else permanent unlink. */
function trashOrUnlink(path: string): Promise<"trash" | "unlink" | null> {
  return new Promise((resolvePromise) => {
    const settleUnlink = () =>
      unlink(path)
        .then(() => resolvePromise("unlink"))
        .catch(() => resolvePromise(null));
    // `--` guards against paths that look like flags (session dirs start with `--`).
    const child = spawn("trash", ["--", path]);
    // ENOENT etc.: no trash CLI installed — fall back to permanent deletion.
    child.on("error", settleUnlink);
    child.on("exit", (code) => {
      if (code === 0 || !existsSync(path)) return resolvePromise("trash");
      settleUnlink();
    });
  });
}

/**
 * Delete every session under one working directory — files only.
 *
 * The folder column is derived from sessions, so removing the files makes the
 * entry disappear on its own. The project directory itself (and everything
 * else in it) is never touched: we only resolve session paths the index
 * already knows, and each must pass the same containment check as /api/delete.
 */
async function handleDeleteFolder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJson(req);
  const cwd = String(body.cwd ?? "").trim();
  if (cwd === "") return sendJson(res, 400, { error: "cwd is required" });

  const all = await collectSessions(deps);
  const targets = all.sessions.filter((session) => session.cwd === cwd);
  if (targets.length === 0) return sendJson(res, 404, { error: "该目录下没有会话" });

  // One folder can hold dozens of sessions (62 on the machine this was written
  // on), and each removal spawns `trash`, so this runs concurrently. The report
  // shape is unchanged: order is the only thing that differs, and nothing
  // downstream depends on it.
  const sessionsRoot = normalizeSessionKey(deps.config.sessionsDir);
  const outcomes = await Promise.all(
    targets.map(async (session): Promise<{ path: string; method: string } | { path: string; failed: true }> => {
      // Pending sessions have no file: disposing the subprocess is all it takes.
      if (session.pending) {
        if (deps.registry.get(session.path)) await deps.registry.dispose(session.path);
        return { path: session.path, method: "gone" };
      }
      const sessionPath = normalizeSessionKey(session.path);
      if (!isInside(sessionsRoot, sessionPath) || !sessionPath.endsWith(".jsonl")) {
        return { path: session.path, failed: true };
      }
      if (deps.registry.get(sessionPath)) await deps.registry.dispose(sessionPath);
      const method = await trashOrUnlink(sessionPath);
      return method ? { path: sessionPath, method } : { path: sessionPath, failed: true };
    }),
  );

  const failed = outcomes.filter((o) => "failed" in o).map((o) => o.path);
  const results = outcomes.filter((o): o is { path: string; method: string } => "method" in o);
  if (failed.length > 0) {
    return sendJson(res, 500, {
      error: `部分会话删除失败（${failed.length}/${targets.length}）`,
      deleted: results.length,
      failed,
    });
  }
  return sendJson(res, 200, { ok: true, deleted: results.length, results });
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
  images: ImageStore,
): Promise<void> {
  const { config, index, registry } = deps;
  const sessionPath = normalizeSessionKey(url.searchParams.get("path") ?? "");
  const sessionsRoot = normalizeSessionKey(config.sessionsDir);

  if (!isInside(sessionsRoot, sessionPath) || !sessionPath.endsWith(".jsonl")) {
    return sendJson(res, 400, { error: "invalid session path" });
  }

  // A freshly created session has no file yet; a live subprocess is enough.
  const live = registry.get(sessionPath);
  const cwd = live?.cwd ?? (await index.get(sessionPath))?.cwd;
  if (!cwd) return sendJson(res, 404, { error: "session not found" });

  // Transcripts are text-heavy (thinking, tool arguments, tool output) and
  // compress ~5x. Frames are flushed individually so streaming stays live.
  const gzip = acceptsGzip(req) ? createGzip() : null;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
  });
  if (gzip) gzip.pipe(res);

  const write = (chunk: string): void => {
    // `finish()` can fire (client hung up) while an async `getState`/`getMessages`
    // is still in flight; the snapshot that follows must not write to the gzip
    // stream after it was ended.
    if (closed) return;
    if (gzip) {
      gzip.write(chunk);
      gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => undefined);
    } else {
      res.write(chunk);
    }
  };
  const end = (): void => {
    if (gzip) gzip.end();
    else res.end();
  };
  const send = (frame: StreamFrame): void => write(`data: ${JSON.stringify(frame)}\n\n`);

  const buffer: StreamFrame[] = [];
  let ready = false;
  let closed = false;
  const flush = (frame: StreamFrame) => {
    if (closed) return;
    if (!ready) {
      buffer.push(frame);
      return;
    }
    send(frame);
  };

  let closedByHandler = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let acquired: ManagedSession | null = null;
  function finish(): void {
    if (closedByHandler) return;
    closedByHandler = true;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (acquired) {
      const managed = acquired;
      acquired = null;
      unsubscribers.forEach((off) => off());
      unsubscribers.length = 0;
      registry.release(managed);
    }
    end();
  }

  // The client can hang up at any moment — including while `registry.acquire`
  // is still spawning pi (a fast refresh during a cold start). Register the
  // close hook BEFORE awaiting, and re-check afterwards, so a disconnect in
  // that window can never leak the subprocess reference we are about to take.
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
    finish();
  });

  const unsubscribers: Array<() => void> = [];
  let managed: ManagedSession;
  try {
    managed = await registry.acquire(sessionPath, cwd);
  } catch (error) {
    flushError(res, error, send);
    return;
  }
  if (clientGone) {
    // The client hung up while we were spawning: hand the ref straight back
    // (finish() could not release it — `acquired` was still null).
    registry.release(managed);
    return;
  }

  acquired = managed;
  unsubscribers.push(
    managed.rpc.onEvent((event) => {
      flush({ type: "event", event });
      if (event.type === "agent_settled") {
        void getSessionStats(managed.rpc)
          .then((stats) => flush({ type: "stats", stats }))
          .catch(() => undefined);
      }
    }),
  );
  unsubscribers.push(
    managed.rpc.onExit(() => {
      flush({ type: "error", error: "pi process exited" });
      finish();
    }),
  );

  heartbeat = setInterval(() => write(": ping\n\n"), SSE_HEARTBEAT_MS);

  try {
    const state = await getState(managed.rpc);
    const messages = await getMessages(managed.rpc);
    const stats = await getSessionStats(managed.rpc).catch(() => null);
    ready = true;
    // Images are the bulk of a session: send hashes, not base64. See imageStore.ts.
    send({ type: "snapshot", state, messages: stripInlineImages(messages, images), stats, ui: managed.ui });
    for (const frame of buffer) send(frame);
    buffer.length = 0;
  } catch (error) {
    flushError(res, error, send);
    finish();
  }
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /(^|,)\s*gzip\s*(,|$)/.test(req.headers["accept-encoding"] ?? "");
}

/**
 * Global SSE: session run-state changes, independent of any one transcript.
 *
 * `/api/stream` only exists while a session is open in a tab, so it cannot tell
 * you that a *different* session — one you switched away from — is still
 * working. This endpoint subscribes to the registry instead and pushes one
 * tiny `activity` frame whenever any managed session starts or finishes a run.
 */
async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const { registry } = deps;
  const gzip = acceptsGzip(req) ? createGzip() : null;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
  });
  if (gzip) gzip.pipe(res);

  const write = (chunk: string): void => {
    if (gzip) {
      gzip.write(chunk);
      gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => undefined);
    } else {
      res.write(chunk);
    }
  };
  const send = (frame: ActivityFrame): void => write(`data: ${JSON.stringify(frame)}\n\n`);

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    off();
    if (gzip) gzip.end();
    else res.end();
  };
  res.on("close", finish);

  // Replay current state on connect: a change that lands between the client's
  // `/api/sessions` fetch and this subscription would otherwise be lost.
  for (const managed of registry.list()) {
    if (managed.streaming) send({ type: "activity", path: managed.path, running: true, reason: "started" });
  }

  const off = registry.onActivity((path, running, reason) => {
    if (!closed) send({ type: "activity", path, running, reason });
  });
  const heartbeat = setInterval(() => write(": ping\n\n"), SSE_HEARTBEAT_MS);
}

async function handlePrompt(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJson(req);
  const sessionPath = String(body.path ?? "");
  const message = String(body.message ?? "");
  const images = Array.isArray(body.images) ? body.images : undefined;
  if (!message.trim() && !images?.length) {
    return sendJson(res, 400, { error: "empty prompt" });
  }

  const managed = deps.registry.get(sessionPath);
  if (!managed) return sendJson(res, 404, { error: "session not open" });

  const state = await getState(managed.rpc);
  const command: Record<string, unknown> = { type: "prompt", message };
  if (images?.length) command["images"] = images;
  if (state.isStreaming) command["streamingBehavior"] = "followUp";

  const data = await managed.rpc.send(command);
  return sendJson(res, 200, { ok: true, data });
}

/**
 * Answer one blocking extension dialog.
 *
 * The id comes from a request the browser received on this session's stream;
 * an id that no longer matches a pending dialog is ignored by pi, so a late
 * answer is harmless.
 */
async function handleUiResponse(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const body = await readJson(req);
  const managed = deps.registry.get(String(body["path"] ?? ""));
  if (!managed) return sendJson(res, 404, { error: "session not open" });

  const result = buildUiResponse(body);
  if (!result.ok) return sendJson(res, 400, { error: result.error });
  managed.rpc.respond(result.record);
  return sendJson(res, 200, { ok: true });
}

/** Content-addressed image bytes, cached forever by the browser. */
function serveImage(res: ServerResponse, images: ImageStore, hash: string): void {
  if (!isImageHash(hash)) return sendJson(res, 400, { error: "invalid image hash" });
  const image = images.get(hash);
  if (!image) return sendJson(res, 404, { error: "image not in cache" });

  res.writeHead(200, {
    "Content-Type": image.mimeType,
    "Content-Length": String(image.buffer.length),
    // The hash is the content, so this can never go stale.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(image.buffer);
}

/**
 * Stream a local image referenced from assistant Markdown (`![alt](/abs/x.png)`).
 *
 * Validation and magic-byte sniffing live in localImage.ts; only actual image
 * bytes can come out of this endpoint, so it never becomes a file read API.
 */
async function serveLocalImage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const result = await loadLocalImage(url.searchParams.get("path") ?? "");
  if (!result.ok) return sendJson(res, result.status, { error: result.error });

  if (req.headers["if-none-match"] === result.etag) {
    res.writeHead(304, { ETag: result.etag });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": result.mimeType,
    "Content-Length": String(result.buffer.length),
    ETag: result.etag,
    // ETag revalidation is cheap; max-age is capped so a file rewritten in
    // place (same path, new bytes) is not stuck stale for a year.
    "Cache-Control": "private, max-age=3600",
  });
  res.end(result.buffer);
}

async function getState(rpc: { send: <T>(c: Record<string, unknown>) => Promise<T> }): Promise<PiSessionState> {
  return normalizeState(await rpc.send<Record<string, unknown>>({ type: "get_state" }));
}

/**
 * Models and thinking levels live in the pi child process, so this only
 * answers while a session stream is open. The client calls it right after the
 * snapshot, when the process is guaranteed to be alive.
 */
async function handleModels(res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const managed = deps.registry.get(resolve(url.searchParams.get("path") ?? ""));
  if (!managed) return sendJson(res, 404, { error: "session not open" });

  const rpc = managed.rpc;
  const [state, models, levels] = await Promise.all([
    getState(rpc),
    rpc.send<{ models?: Array<{ provider?: string; id?: string; name?: string }> }>({
      type: "get_available_models",
    }),
    rpc.send<{ levels?: string[] }>({ type: "get_available_thinking_levels" }),
  ]);

  // The full Model objects carry pricing/limits the picker does not need.
  const list: ModelOption[] = (models.models ?? []).map((model) => ({
    provider: model.provider ?? "",
    id: model.id ?? "",
    name: model.name,
  }));

  const payload: ModelsResponse = {
    models: list,
    model: state.model ? `${state.model.provider}/${state.model.id}` : null,
    thinkingLevels: levels.levels ?? [],
    thinkingLevel: state.thinkingLevel,
  };
  return sendJson(res, 200, payload);
}

/**
 * Slash commands for an open session, for the composer's command menu.
 *
 * Needs the session's pi subprocess, so it only answers while a stream is open
 * (the client calls it right after the snapshot).
 */
async function handleCommands(res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const managed = deps.registry.get(resolve(url.searchParams.get("path") ?? ""));
  if (!managed) return sendJson(res, 404, { error: "session not open" });

  const data = await managed.rpc.send<{ commands?: unknown }>({ type: "get_commands" });
  const payload: CommandsResponse = { commands: normalizeCommands(data?.commands) };
  return sendJson(res, 200, payload);
}

function normalizeState(raw: Record<string, unknown>): PiSessionState {
  const model = raw["model"] as { provider?: string; id?: string; name?: string } | undefined;
  return {
    sessionId: (raw["sessionId"] as string) ?? null,
    sessionName: (raw["sessionName"] as string) ?? null,
    sessionFile: (raw["sessionFile"] as string) ?? null,
    model: model ? { provider: model.provider ?? "", id: model.id ?? "", name: model.name } : null,
    thinkingLevel: (raw["thinkingLevel"] as string) ?? null,
    isStreaming: Boolean(raw["isStreaming"]),
    messageCount: Number(raw["messageCount"] ?? 0),
  };
}

async function getMessages(rpc: { send: <T>(c: Record<string, unknown>) => Promise<T> }): Promise<unknown[]> {
  const raw = await rpc.send<{ messages?: unknown[] }>({ type: "get_messages" });
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return messages.filter((m) => (m as { role?: string }).role !== "system");
}

/** Token / cost / context accounting. Null when pi cannot report it. */
async function getSessionStats(rpc: {
  send: <T>(c: Record<string, unknown>) => Promise<T>;
}): Promise<SessionStats | null> {
  const raw = await rpc.send<Record<string, unknown>>({ type: "get_session_stats" });
  const tokens = (raw["tokens"] ?? {}) as Record<string, unknown>;
  const context = raw["contextUsage"] as Record<string, unknown> | undefined;
  return {
    tokens: {
      input: Number(tokens["input"] ?? 0),
      output: Number(tokens["output"] ?? 0),
      cacheRead: Number(tokens["cacheRead"] ?? 0),
      cacheWrite: Number(tokens["cacheWrite"] ?? 0),
      total: Number(tokens["total"] ?? 0),
    },
    cost: Number(raw["cost"] ?? 0),
    contextUsage: context
      ? {
          tokens: context["tokens"] === null ? null : Number(context["tokens"] ?? 0),
          contextWindow: Number(context["contextWindow"] ?? 0),
          percent: context["percent"] === null ? null : Number(context["percent"] ?? 0),
        }
      : null,
    userMessages: Number(raw["userMessages"] ?? 0),
    assistantMessages: Number(raw["assistantMessages"] ?? 0),
    toolCalls: Number(raw["toolCalls"] ?? 0),
  };
}

function flushError(
  res: ServerResponse,
  error: unknown,
  send?: (frame: StreamFrame) => void,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) sendJson(res, 500, { error: message });
  else if (send) send({ type: "error", error: message });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  // No, not even the session list: the whole point of this app is that a
  // running server and a browser tab never disagree about the current state.
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, must-revalidate",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // App routes deep-linked or refreshed resolve to the shell. Only the known
  // route gets the fallback — everything else keeps 404ing, so a mistyped
  // asset path stays visible instead of silently loading the app.
  const clean = pathname.replace(/\/+$/, "") || "/";
  const relative = clean === "/" || clean === "/settings" ? "index.html" : clean.replace(/^\/+/, "");
  const target = resolve(WEB_DIR, relative);
  if (!isInside(WEB_DIR, target)) return sendJson(res, 403, { error: "forbidden" });

  try {
    const file = await readFile(target);
    const type = MIME[extname(target)] ?? "application/octet-stream";
    // This is a local app that gets edited while running: never let the browser
    // reuse a stale bundle, or a fix can appear to do nothing after a reload.
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store, must-revalidate" });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  return target === normalizedRoot || target.startsWith(normalizedRoot + sep);
}
