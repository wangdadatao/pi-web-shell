import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionSummary } from "../shared/types.ts";
import { normalizeSessionKey } from "./paths.ts";

/**
 * Sidebar view of pi's fork chains.
 *
 * pi's fork (the move behind the transcript's edit/delete-resend buttons) never
 * rewrites the old session: it copies the conversation up to the branch point
 * into a **new** `.jsonl` file whose header points back at the old one via
 * `parentSession`, and all further turns land in the new file. The old file
 * stays on disk forever.
 *
 * To the user, though, editing their last message happens *in this session* —
 * the sidebar showing two identically-titled rows reads as a bug. So the
 * session list folds each chain to its tip: a file that a newer child forked
 * away from is hidden until it outlives that child (someone resumes and writes
 * it, or the child is deleted).
 *
 * Deliberate duplication is exempt: `clone` and an explicit fork from the
 * branch tree are "give me another copy to keep both of" moves, so those
 * children are marked here and their parent stays listed.
 */
export interface BranchMark {
  /** The forked/cloned child session file (absolute path, as pi reported it). */
  child: string;
  /** True when the parent must stay visible (clone / explicit tree fork). */
  keepParent: boolean;
  /** Wall-clock ms at mark time; unused by the filter, kept for auditing. */
  at: number;
}

/** Append-only store of branch marks, one JSON object per line. */
export class BranchMarkStore {
  private readonly path: string;
  private cache: { mtimeMs: number; size: number; keep: Set<string> } | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Record a mark for a freshly created child session. Never throws. */
  async mark(mark: BranchMark): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(mark)}\n`, "utf8");
      this.cache = null; // the append invalidated it
    } catch {
      // A failed mark only means the parent may be folded away later; never
      // let bookkeeping break the fork/clone call itself.
    }
  }

  /**
   * Session paths (normalized) whose parent must stay visible.
   *
   * The file is tiny and read on every session listing, so it is cached by
   * mtime + size. Corrupt or partial lines are skipped, not fatal.
   */
  async keepParentChildren(): Promise<Set<string>> {
    let fileStat;
    try {
      fileStat = await stat(this.path);
    } catch {
      return new Set();
    }
    if (this.cache && this.cache.mtimeMs === fileStat.mtimeMs && this.cache.size === fileStat.size) {
      return this.cache.keep;
    }
    const { readFileSync } = await import("node:fs");
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return new Set();
    }
    const keep = new Set<string>();
    for (const raw of text.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const mark = JSON.parse(trimmed) as Partial<BranchMark>;
        if (mark.keepParent === true && typeof mark.child === "string" && mark.child !== "") {
          keep.add(normalizeSessionKey(mark.child));
        }
      } catch {
        // Truncated or hand-edited line; ignore.
      }
    }
    this.cache = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, keep };
    return keep;
  }
}

/**
 * Where branch marks live: a sibling of pi's agent dir —
 * `<dirname(agentDir)>/web-shell/branch-marks.jsonl` (default install:
 * `~/.pi/web-shell/branch-marks.jsonl`). Keyed off the agent dir, not $HOME,
 * so an isolated `PI_CODING_AGENT_DIR` (test runners) keeps its marks inside
 * the isolation boundary instead of leaking into the real home.
 */
export function defaultBranchMarkStorePath(agentDir: string): string {
  return join(dirname(agentDir), "web-shell", "branch-marks.jsonl");
}

/**
 * Fold fork chains to their tips.
 *
 * A session is hidden when some other listed session was forked *from* it
 * (header `parentSession`), that child is not marked keep-parent, and the
 * parent was already dead at fork time: its last write must predate the
 * child's **creation**. Comparing against the child's creation — not its last
 * activity — is what keeps independently-continued parents listed: a fork that
 * the user then abandoned while going on writing in the old session (or
 * resuming it later) leaves the parent's mtime past the child's birth, and
 * that parent is its own thread, not a stale copy.
 *
 * Hiding is derived from the live listing, so it self-heals: a deleted child
 * brings its parent back.
 */
export function hideSupersededSessions(
  sessions: SessionSummary[],
  keepParentChildren: ReadonlySet<string>,
): SessionSummary[] {
  // Children by normalized parent path, keyed with their birth time. Pending
  // (not yet written) sessions have no header on disk, so they never appear as
  // children here — fine, a fork writes its child file before anything else
  // can happen to it.
  const childrenOf = new Map<string, { bornMs: number; child: SessionSummary }[]>();
  for (const session of sessions) {
    if (!session.parentSession) continue;
    const bornMs = Date.parse(session.createdAt);
    if (!Number.isFinite(bornMs)) continue;
    const key = normalizeSessionKey(session.parentSession);
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push({ bornMs, child: session });
    else childrenOf.set(key, [{ bornMs, child: session }]);
  }
  if (childrenOf.size === 0) return sessions;

  const hidden = new Set<string>();
  for (const parent of sessions) {
    const children = childrenOf.get(normalizeSessionKey(parent.path));
    if (!children) continue;
    const superseded = children.some(
      ({ bornMs, child }) =>
        !keepParentChildren.has(normalizeSessionKey(child.path)) && parent.mtimeMs <= bornMs,
    );
    if (superseded) hidden.add(parent.path);
  }
  if (hidden.size === 0) return sessions;
  return sessions.filter((session) => !hidden.has(session.path));
}
