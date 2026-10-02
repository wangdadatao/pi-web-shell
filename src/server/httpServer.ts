import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createGzip, constants as zlibConstants } from "node:zlib";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { ImageStore, isImageHash, stripInlineImages } from "./imageStore.ts";
import { normalizeSessionKey } from "./paths.ts";
import type { SessionIndex } from "./sessionIndex.ts";
import type { ManagedSession, SessionRegistry } from "./sessionRegistry.ts";
import type {
  FolderSummary,
  ModelOption,
  ModelsResponse,
  PiSessionState,
  SessionStats,
  SessionSummary,
  StreamFrame,
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

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = `${req.method ?? "GET"} ${url.pathname}`;

      if (url.pathname.startsWith("/api/image/")) {
        return serveImage(res, images, url.pathname.slice("/api/image/".length));
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

      if (route === "POST /api/prompt") {
        return handlePrompt(req, res, deps);
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

      if (req.method === "GET") {
        return serveStatic(url.pathname, res);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    }
    void config;
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
  const folders = await index.listFolders(all);
  return { home: config.home, folders, sessions: all };
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
    deps.registry.release(acquired.path);
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

  const results: { path: string; method: string }[] = [];
  const failed: string[] = [];
  for (const session of targets) {
    // Pending sessions have no file: disposing the subprocess is all it takes.
    if (session.pending) {
      if (deps.registry.get(session.path)) await deps.registry.dispose(session.path);
      results.push({ path: session.path, method: "gone" });
      continue;
    }
    const sessionPath = normalizeSessionKey(session.path);
    const sessionsRoot = normalizeSessionKey(deps.config.sessionsDir);
    if (!isInside(sessionsRoot, sessionPath) || !sessionPath.endsWith(".jsonl")) {
      failed.push(session.path);
      continue;
    }
    if (deps.registry.get(sessionPath)) await deps.registry.dispose(sessionPath);
    const method = await trashOrUnlink(sessionPath);
    if (method) results.push({ path: sessionPath, method });
    else failed.push(sessionPath);
  }

  if (failed.length > 0) {
    return sendJson(res, 500, { error: `部分会话删除失败（${failed.length}/${targets.length}）`, deleted: results.length, failed });
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
      registry.release(managed.path);
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
    registry.release(managed.path);
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
    send({ type: "snapshot", state, messages: stripInlineImages(messages, images), stats });
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
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
