import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PiRpcOptions {
  /** pi executable, e.g. "pi". */
  bin: string;
  /** Session file to load, or null to start a fresh (persistent) session. */
  sessionPath: string | null;
  /** Working directory for the child process (the project folder). */
  cwd: string;
  /**
   * Value for pi's `--session-dir`, or null/undefined to omit the flag.
   *
   * Omit it in the normal case: pi then resolves its own session directory and
   * groups sessions per project (`<dir>/--<encoded-cwd>--/<file>.jsonl`), which
   * keeps them visible to `pi --resume`. Only pass it when the server indexes a
   * directory pi would not pick on its own (`PI_SHELL_SESSIONS_DIR`).
   */
  sessionDirArg?: string | null;
  /** Extra CLI args appended before `--mode rpc`. */
  extraArgs?: string[];
}

export interface PiResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export type PiEvent = { type: string } & Record<string, unknown>;

type EventListener = (event: PiEvent) => void;
type ExitListener = (info: { code: number | null; signal: NodeJS.Signals | null }) => void;

interface Pending {
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Startup events held for the first listener; a burst this large is already odd. */
const MAX_STARTUP_EVENTS = 512;

/** Deliver one event without letting a broken listener take down the process. */
function emit(listener: EventListener, event: PiEvent): void {
  try {
    listener(event);
  } catch (error) {
    process.stderr.write(`[pi-shell] event listener error: ${String(error)}\n`);
  }
}

/**
 * Context every web-shell child carries, via `--append-system-prompt`.
 *
 * CLI sessions never see this: the flag is passed only by our spawn, so the
 * rule stays scoped to the web UI and versioned next to the feature it
 * documents (/api/local-image). Keep it short and behavioral.
 */
const WEB_CONTEXT_PROMPT = [
  "你正运行在 pi-web-shell（本地 Web 界面）中。",
  "想让用户直接看到本地图片文件时，在回复正文里用 ![描述](/绝对/路径.png) 内联展示（~/ 与 file:// 路径亦可），图片会直接渲染，用户可点击查看原图。",
  "仅内联面向用户的成品图片；中间产物给出文件路径即可。",
].join("\n");

/**
 * A single `pi --mode rpc` child process.
 *
 * Speaks the documented RPC protocol: one JSON object per line on stdin and
 * stdout. We split on LF only (never a generic readline, which also splits on
 * U+2028/U+2029 and would corrupt JSON strings).
 */
export class PiRpcSession {
  private readonly options: PiRpcOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<EventListener>();
  /**
   * Events emitted before the first listener attached.
   *
   * pi fires startup hooks (`session_start` → an extension's `setWidget` /
   * `setStatus`) while we are still running `start()` / `get_state`, and a
   * dropped event is state the browser can never recover. The first consumer to
   * subscribe (the registry) gets this burst replayed; later subscribers see the
   * world through a snapshot instead, so this is handed out once.
   */
  private pendingEvents: PiEvent[] = [];
  private bufferStartupEvents = true;
  private readonly exitListeners = new Set<ExitListener>();
  private stopped = false;
  /** Set before exit listeners run, so `stop()` knows there is nothing to wait for. */
  private exited = false;

  constructor(options: PiRpcOptions) {
    this.options = options;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    const args = [...(this.options.extraArgs ?? []), "--mode", "rpc"];
    if (this.options.sessionDirArg) args.push("--session-dir", this.options.sessionDirArg);
    if (this.options.sessionPath) args.push("--session", this.options.sessionPath);
    args.push("--append-system-prompt", WEB_CONTEXT_PROMPT);

    const child = spawn(this.options.bin, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    return new Promise<void>((resolve, reject) => {
      const onSpawnError = (error: Error) => reject(error);
      child.once("error", onSpawnError);
      child.once("spawn", () => {
        child.off("error", onSpawnError);
        resolve();
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consume(chunk));

      // A child that dies between our `write()` and its pid being reaped gives
      // us EPIPE here. Without a listener that is an uncaught exception and
      // takes the whole server down — every open session with it. The request
      // is not lost either way: the `exit` handler below rejects whatever is
      // still pending, so this only needs to keep the noise out of the crash log.
      child.stdin.on("error", (error: Error) => {
        process.stderr.write(
          `[pi:${shortId(this.options.sessionPath)}] stdin error: ${error.message}\n`,
        );
      });

      // stderr is diagnostics only; never protocol data.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const text = chunk.trim();
        if (text) process.stderr.write(`[pi:${shortId(this.options.sessionPath)}] ${text}\n`);
      });

      child.on("exit", (code, signal) => {
        this.exited = true;
        this.failPending(new Error(`pi process exited (code=${code ?? "null"})`));
        for (const listener of this.exitListeners) listener({ code, signal });
      });
    });
  }

  /** Send a command and resolve with its response `data`. */
  async send<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.child) throw new Error("PiRpcSession.start() must be called first");
    const id = String(this.nextId++);
    const payload = { ...command, id };

    const response = await new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });

    if (!response.success) {
      throw new Error(response.error ?? `pi command failed: ${String(command.type)}`);
    }
    return response.data as T;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    if (this.bufferStartupEvents) {
      this.bufferStartupEvents = false;
      const buffered = this.pendingEvents;
      this.pendingEvents = [];
      for (const event of buffered) emit(listener, event);
    }
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Write one raw record to pi's stdin (e.g. an `extension_ui_response`).
   *
   * Deliberately fire-and-forget: a dialog the browser answers may already have
   * been resolved by an extension-side timeout, and an unknown id is not worth
   * reporting back. Write failures surface through the stdin error handler.
   */
  respond(record: Record<string, unknown>): void {
    this.write(record);
  }

  /** Close stdin and wait for an orderly exit, escalating to SIGKILL. */
  async stop(graceMs = 5000): Promise<void> {
    if (!this.child || this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.child = null;
    // Already gone: waiting for a second `exit` would burn the whole grace
    // period on a dead pid, which matters because the registry now disposes a
    // crashed child immediately.
    if (this.exited) return;

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, graceMs);
      child.once("exit", done);
      child.stdin.end();
    });
  }

  private write(record: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(`[pi-shell] unparseable RPC line: ${line.slice(0, 200)}\n`);
      return;
    }

    if (record["type"] === "response") {
      const id = typeof record["id"] === "string" ? record["id"] : undefined;
      if (id) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.resolve(record as unknown as PiResponse);
          return;
        }
      }
      return;
    }

    if (this.eventListeners.size === 0) {
      if (this.bufferStartupEvents) {
        // Bounded: a session nothing ever subscribes to must not grow forever.
        if (this.pendingEvents.length >= MAX_STARTUP_EVENTS) this.pendingEvents.shift();
        this.pendingEvents.push(record as PiEvent);
      }
      return;
    }

    for (const listener of this.eventListeners) {
      emit(listener, record as PiEvent);
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function shortId(sessionPath: string | null): string {
  if (!sessionPath) return "new";
  const base = sessionPath.slice(sessionPath.lastIndexOf("/") + 1);
  return base.slice(0, 8);
}
