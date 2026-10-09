import type { Config } from "./config.ts";
import { PiRpcSession } from "./piSession.ts";
import { applyExtensionUiState, emptyExtensionUiState } from "./extensionUi.ts";
import { normalizeSessionKey } from "./paths.ts";
import type { ActivityReason, ExtensionUiState } from "../shared/types.ts";

export interface ManagedSession {
  path: string;
  cwd: string;
  createdAt: string;
  rpc: PiRpcSession;
  /** Number of open SSE streams / active consumers. */
  refs: number;
  /** True between `agent_start` and `agent_settled` for this subprocess. */
  streaming: boolean;
  idleTimer: NodeJS.Timeout | null;
  /**
   * The subprocess exited. A dead entry must never be handed out again: pi
   * writes to a destroyed stdin without complaint and never answers, so a
   * stream attached to it would hang forever waiting for a snapshot instead of
   * spawning a fresh child.
   */
  dead: boolean;
  /**
   * Latest fire-and-forget extension state (`setStatus` / `setWidget` /
   * `setTitle`). Kept here rather than in the RPC client because it must
   * outlive a single browser stream: the stream snapshot replays it.
   */
  ui: ExtensionUiState;
}

type ActivityListener = (path: string, running: boolean, reason: ActivityReason) => void;

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
  private readonly activityListeners = new Set<ActivityListener>();

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Observe run-state changes for every managed session.
   *
   * Distinct from `PiRpcSession.onEvent`: that fires per event on one session,
   * while this fires only when a session crosses the running/idle boundary and
   * covers sessions nobody is currently watching.
   */
  onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async acquire(sessionPath: string, cwd: string): Promise<ManagedSession> {
    const key = normalizeSessionKey(sessionPath);

    // Loop, never fall through: disposing a dead entry awaits the corpse's
    // exit, and another caller may register a fresh child for this key during
    // that wait. Re-resolve so the child is shared instead of duplicated —
    // two subprocesses on one session file is the thing this registry exists
    // to prevent.
    for (;;) {
      const existing = this.live.get(key);
      if (existing?.dead) {
        // Replace the corpse with a fresh child (we are about to be a consumer).
        await this.dispose(existing.path);
        continue;
      }
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
      streaming: false,
      idleTimer: null,
      dead: false,
      ui: emptyExtensionUiState(),
    };
    this.live.set(sessionFile, managed);
    this.watch(managed);
    // If no consumer ever attaches (the client failed to open a stream), reap it.
    // A run starting before then clears the timer in `setStreaming`.
    this.armIdle(managed);
    return { managed, state };
  }

  /**
   * Hand back one reference.
   *
   * Takes the entry itself, not a path: a caller can hold an entry that was
   * already replaced in `live` (its child died and `acquire` swapped in a
   * fresh one), and a path-keyed lookup would then decrement the
   * *replacement's* refs — arming the idle reaper on a child that still has
   * consumers.
   */
  release(managed: ManagedSession): void {
    managed.refs = Math.max(0, managed.refs - 1);
    if (managed.refs > 0) return;
    // Nobody is left to notice a crash: drop it now so the next `acquire` can
    // spawn a fresh child, instead of keeping a dead entry warm for 15 minutes.
    if (managed.dead) {
      void this.retire(managed);
      return;
    }
    // A running session must not be reaped out from under the agent: refreshing
    // the page drops the stream, not the work. The timer is re-armed on settle.
    if (managed.streaming) return;
    this.armIdle(managed);
  }

  async dispose(sessionPath: string): Promise<void> {
    const key = normalizeSessionKey(sessionPath);
    const managed = this.live.get(key);
    if (managed) await this.retire(managed);
  }

  /**
   * Tear down one entry, but only if it is still the registered one.
   *
   * Identity, not the key, decides: an entry that was already replaced must not
   * take its replacement — and that replacement's subprocess — down with it.
   */
  private async retire(managed: ManagedSession): Promise<void> {
    if (this.live.get(managed.path) !== managed) return;
    this.live.delete(managed.path);
    this.clearIdle(managed);
    // Broadcast before teardown so a subprocess killed mid-run cannot leave a
    // stale "running" dot behind in every connected client. `retired` keeps
    // this apart from a real finish, so clients do not notify on housekeeping.
    this.setStreaming(managed, false, "retired");
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
      streaming: false,
      idleTimer: null,
      dead: false,
      ui: emptyExtensionUiState(),
    };
    this.live.set(sessionPath, managed);
    this.watch(managed);
    return managed;
  }

  /**
   * Subscribe to one subprocess's run boundaries.
   *
   * pi reports `agent_start` / `agent_settled` on the RPC stream for the whole
   * life of the process, whether or not a browser is streaming it. That makes
   * this the authoritative "AI is working" signal for sessions we own — no
   * polling and no session-file heuristics.
   */
  private watch(managed: ManagedSession): void {
    managed.rpc.onEvent((event) => {
      if (event.type === "agent_start") this.setStreaming(managed, true, "started");
      else if (event.type === "agent_settled") this.setStreaming(managed, false, "settled");
      else if (event.type === "extension_ui_request") applyExtensionUiState(managed.ui, event);
    });
    managed.rpc.onExit(() => {
      managed.dead = true;
      this.setStreaming(managed, false, "exited");
      // Crash with nobody watching? Then there is nothing to keep alive.
      if (managed.refs === 0) void this.retire(managed);
    });
  }

  private setStreaming(managed: ManagedSession, running: boolean, reason: ActivityReason): void {
    if (managed.streaming === running) return;
    managed.streaming = running;
    if (running) {
      // Never let the idle reaper kill a live run, even if nobody is watching.
      this.clearIdle(managed);
    } else if (managed.refs === 0 && !managed.idleTimer && this.live.get(managed.path) === managed) {
      this.armIdle(managed);
    }
    for (const listener of this.activityListeners) {
      try {
        listener(managed.path, running, reason);
      } catch (error) {
        process.stderr.write(`[pi-shell] activity listener error: ${String(error)}\n`);
      }
    }
  }

  /** Reap a session this many ms after its last consumer leaves and it goes idle. */
  private armIdle(managed: ManagedSession): void {
    this.clearIdle(managed);
    managed.idleTimer = setTimeout(() => {
      void this.retire(managed);
    }, this.config.idleTimeoutMs);
    managed.idleTimer.unref?.();
  }

  private clearIdle(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }
  }
}
