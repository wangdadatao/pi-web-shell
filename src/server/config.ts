import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  home: string;
  /** Directory this server indexes for sessions. */
  sessionsDir: string;
  /**
   * Value to pass to the pi child as `--session-dir`.
   *
   * `null` means "don't pass the flag at all". pi then resolves its own session
   * directory and keeps its normal per-project layout
   * (`<sessionsDir>/--<encoded-cwd>--/<file>.jsonl`), which is what
   * `pi --resume` lists. Only a web-only override needs the flag.
   */
  sessionDirArg: string | null;
  piBin: string;
  openBrowser: boolean;
  idleTimeoutMs: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Load configuration from the environment.
 *
 * `PI_SHELL_SESSIONS_DIR` is this server's own override; otherwise we honor
 * pi's `PI_CODING_AGENT_SESSION_DIR`, otherwise the documented default
 * `~/.pi/agent/sessions` (under `PI_CODING_AGENT_DIR` when set).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultSessionsDir = join(
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "sessions",
  );
  const shellSessionsDir = env.PI_SHELL_SESSIONS_DIR;
  const sessionsDir = resolve(
    shellSessionsDir ?? env.PI_CODING_AGENT_SESSION_DIR ?? defaultSessionsDir,
  );

  // Only override pi's own resolution when we are the only one who knows the
  // directory. A `PI_CODING_AGENT_SESSION_DIR` is inherited by the child, so the
  // flag would be redundant there. Passing `--session-dir` also switches pi to a
  // flat layout that `pi --resume` cannot see — see docs/ARCHITECTURE.md.
  const piOwnSessionsDir = env.PI_CODING_AGENT_SESSION_DIR ?? defaultSessionsDir;
  const sessionDirArg =
    shellSessionsDir && resolve(shellSessionsDir) !== resolve(piOwnSessionsDir)
      ? resolve(shellSessionsDir)
      : null;

  return {
    host: env.PI_SHELL_HOST ?? "127.0.0.1",
    port: intFromEnv(env.PI_SHELL_PORT, 4711),
    home: homedir(),
    sessionsDir,
    sessionDirArg,
    piBin: env.PI_SHELL_PI_BIN ?? "pi",
    openBrowser: boolFromEnv(env.PI_SHELL_OPEN_BROWSER, true),
    idleTimeoutMs: intFromEnv(env.PI_SHELL_IDLE_TIMEOUT_MS, 15 * 60 * 1000),
  };
}
