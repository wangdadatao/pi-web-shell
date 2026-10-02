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
  private readonly exitListeners = new Set<ExitListener>();
  private stopped = false;

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

      // stderr is diagnostics only; never protocol data.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const text = chunk.trim();
        if (text) process.stderr.write(`[pi:${shortId(this.options.sessionPath)}] ${text}\n`);
      });

      child.on("exit", (code, signal) => {
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
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Close stdin and wait for an orderly exit, escalating to SIGKILL. */
  async stop(graceMs = 5000): Promise<void> {
    if (!this.child || this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.child = null;

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

    for (const listener of this.eventListeners) {
      try {
        listener(record as PiEvent);
      } catch (error) {
        process.stderr.write(`[pi-shell] event listener error: ${String(error)}\n`);
      }
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
