import type { Config } from "./config.ts";
import { PiRpcSession } from "./piSession.ts";
import { normalizeSessionKey } from "./paths.ts";

export interface ManagedSession {
  path: string;
  cwd: string;
  createdAt: string;
  rpc: PiRpcSession;
  /** Number of open SSE streams / active consumers. */
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Keeps one live pi RPC subprocess per opened session.
 *
 * A session file must have a single writer, so every consumer of a given
 * session shares the same child process. When the last consumer goes away the
 * process is kept warm for `idleTimeoutMs` and then disposed.
 */
export class SessionRegistry {
  private readonly config: Config;
  private readonly live = new Map<string, ManagedSession>();
  private readonly starting = new Map<string, Promise<ManagedSession>>();

  constructor(config: Config) {
    this.config = config;
  }

  async acquire(sessionPath: string, cwd: string): Promise<ManagedSession> {
    const key = normalizeSessionKey(sessionPath);
    const existing = this.live.get(key);
    if (existing) {
      existing.refs += 1;
      this.clearIdle(existing);
      return existing;
    }

    const inFlight = this.starting.get(key);
    if (inFlight) {
      const managed = await inFlight;
      managed.refs += 1;
      this.clearIdle(managed);
      return managed;
    }

    const startPromise = this.spawnSession(key, cwd);
    this.starting.set(key, startPromise);
    try {
      const managed = await startPromise;
      managed.refs += 1;
      return managed;
    } finally {
      this.starting.delete(key);
    }
  }

  get(sessionPath: string): ManagedSession | undefined {
    return this.live.get(normalizeSessionKey(sessionPath));
  }

  /** Every live subprocess, including ones whose session file is not yet written. */
  list(): ManagedSession[] {
    return [...this.live.values()];
  }

  /**
   * Start a brand new session in `cwd`.
   *
   * pi reserves a session file path but only writes it on the first prompt, so
   * the returned `path` may not exist on disk yet. The process is registered
   * under that path so the client can open a stream for it immediately.
   */
  async createSession(cwd: string): Promise<{ managed: ManagedSession; state: Record<string, unknown> }> {
    const rpc = new PiRpcSession({
      bin: this.config.piBin,
      sessionPath: null,
      cwd,
      sessionDirArg: this.config.sessionDirArg,
    });
    await rpc.start();

    let state: Record<string, unknown>;
    try {
      state = await rpc.send<Record<string, unknown>>({ type: "get_state" });
    } catch (error) {
      await rpc.stop().catch(() => undefined);
      throw error;
    }

    const reported = state["sessionFile"];
    if (typeof reported !== "string" || reported === "") {
      await rpc.stop().catch(() => undefined);
      throw new Error("pi did not report a session file for the new session");
    }
    const sessionFile = normalizeSessionKey(reported);

    const existing = this.live.get(sessionFile);
    if (existing) {
      await rpc.stop().catch(() => undefined);
      return { managed: existing, state };
    }

    const managed: ManagedSession = {
      path: sessionFile,
      cwd,
      createdAt: new Date().toISOString(),
      rpc,
      refs: 0,
      idleTimer: null,
    };
    this.live.set(sessionFile, managed);
    // If no consumer ever attaches (the client failed to open a stream), reap it.
    managed.idleTimer = setTimeout(() => {
      void this.dispose(sessionFile);
    }, this.config.idleTimeoutMs);
    managed.idleTimer.unref?.();
    return { managed, state };
  }

  release(sessionPath: string): void {
    const managed = this.live.get(normalizeSessionKey(sessionPath));
    if (!managed) return;
    managed.refs = Math.max(0, managed.refs - 1);
    if (managed.refs > 0) return;
    managed.idleTimer = setTimeout(() => {
      void this.dispose(managed.path);
    }, this.config.idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  async dispose(sessionPath: string): Promise<void> {
    const key = normalizeSessionKey(sessionPath);
    const managed = this.live.get(key);
    if (!managed) return;
    this.live.delete(key);
    this.clearIdle(managed);
    await managed.rpc.stop().catch(() => undefined);
  }

  async disposeAll(): Promise<void> {
    const paths = [...this.live.keys()];
    await Promise.all(paths.map((path) => this.dispose(path)));
  }

  private async spawnSession(sessionPath: string, cwd: string): Promise<ManagedSession> {
    const rpc = new PiRpcSession({
      bin: this.config.piBin,
      sessionPath,
      cwd,
      sessionDirArg: this.config.sessionDirArg,
    });
    await rpc.start();
    const managed: ManagedSession = {
      path: sessionPath,
      cwd,
      createdAt: new Date().toISOString(),
      rpc,
      refs: 0,
      idleTimer: null,
    };
    this.live.set(sessionPath, managed);
    return managed;
  }

  private clearIdle(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }
  }
}
