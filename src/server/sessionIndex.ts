import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { FolderSummary, SessionSummary } from "../shared/types.ts";

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
const MAX_TITLE = 80;

interface SessionHeader {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
}

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  summary: SessionSummary;
}

export interface SessionIndexOptions {
  /** When set, summaries are cached by path + mtime + size. */
  cache?: boolean;
}

/**
 * Indexes pi's session directory.
 *
 * Sessions live in `<sessionsDir>/--<encoded-cwd>--/<timestamp>_<id>.jsonl`.
 * The folder name is lossy (real dashes collide with path separators), so the
 * working directory is always read from the session header, never parsed from
 * the directory name.
 *
 * Files can be large, so we only read a head slice (header + first user
 * message) and a tail slice (most recent `/name`).
 */
export class SessionIndex {
  readonly sessionsDir: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly useCache: boolean;

  constructor(sessionsDir: string, options: SessionIndexOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.useCache = options.cache ?? true;
  }

  /** Summarize a single session file (cached by mtime + size). */
  async get(path: string): Promise<SessionSummary | null> {
    return this.summarize(path);
  }

  /** All sessions across every folder, newest activity first. */
  async listSessions(): Promise<SessionSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    // pi lays sessions out one of two ways:
    //   <dir>/--<encoded-cwd>--/<file>.jsonl   (its own grouping)
    //   <dir>/<file>.jsonl                     (when --session-dir is passed)
    // Index both so an explicit --session-dir cannot hide sessions from us.
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.sessionsDir, entry.name));
    const loose = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(this.sessionsDir, entry.name));

    const [grouped, flat] = await Promise.all([
      Promise.all(folders.map((dir) => this.listFolder(dir))),
      Promise.all(loose.map((path) => this.summarize(path))),
    ]);

    const summaries = [
      ...grouped.flat(),
      ...flat.filter((summary): summary is SessionSummary => summary !== null),
    ];
    return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Folders that actually contain sessions, newest activity first. */
  async listFolders(sessions: SessionSummary[]): Promise<FolderSummary[]> {
    const byCwd = new Map<string, FolderSummary>();
    for (const session of sessions) {
      const existing = byCwd.get(session.cwd);
      if (existing) {
        existing.sessionCount += 1;
        if (session.mtimeMs > existing.lastActivityMs) {
          existing.lastActivityMs = session.mtimeMs;
          existing.lastActivity = session.updatedAt;
        }
      } else {
        byCwd.set(session.cwd, {
          cwd: session.cwd,
          sessionCount: 1,
          lastActivity: session.updatedAt,
          lastActivityMs: session.mtimeMs,
        });
      }
    }
    return [...byCwd.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  private async listFolder(dir: string): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const files = names.filter((name) => name.endsWith(".jsonl"));
    const summaries = await Promise.all(files.map((name) => this.summarize(join(dir, name))));
    return summaries.filter((s): s is SessionSummary => s !== null);
  }

  private async summarize(path: string): Promise<SessionSummary | null> {
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      return null;
    }

    const cached = this.cache.get(path);
    if (
      this.useCache &&
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.sizeBytes === fileStat.size
    ) {
      return cached.summary;
    }

    const { head, tail } = await readSlices(path, fileStat.size);
    const header = findHeader(head);
    if (!header?.cwd) return null;

    const name = findLastName(tail) ?? findLastName(head);
    const firstUser = findFirstUserText(head);

    // The header timestamp is the creation time. When a file has no header
    // timestamp, the file's own birth time is the honest fallback — mtime would
    // silently relabel "created" as "last written".
    const born = fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime;
    const summary: SessionSummary = {
      path,
      id: header.id ?? basenameWithoutExtension(path),
      cwd: header.cwd,
      createdAt: header.timestamp ?? born.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
      title: name ?? firstUser ?? "(empty session)",
      version: header.version ?? 1,
      ...(name !== undefined ? { name } : {}),
    };

    this.cache.set(path, { mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size, summary });
    return summary;
  }
}

function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.jsonl$/, "");
}

async function readSlices(
  path: string,
  size: number,
): Promise<{ head: string; tail: string }> {
  if (size === 0) return { head: "", tail: "" };
  const handle = await open(path, "r");
  try {
    const headLength = Math.min(HEAD_BYTES, size);
    const headBuffer = Buffer.alloc(headLength);
    await handle.read(headBuffer, 0, headLength, 0);

    if (size <= HEAD_BYTES) {
      return { head: headBuffer.toString("utf8"), tail: headBuffer.toString("utf8") };
    }

    const tailLength = Math.min(TAIL_BYTES, size);
    const tailBuffer = Buffer.alloc(tailLength);
    await handle.read(tailBuffer, 0, tailLength, size - tailLength);
    // A byte cut can land inside a character, and the decoder answers with
    // U+FFFD — verified: a truncated UTF-8 sequence never decodes to half of a
    // surrogate pair, so there is nothing to repair here. Nor can the damage
    // escape: the mangled line is always a partial line, and a partial line
    // fails `JSON.parse` inside `lines()`, so it is dropped before it can reach
    // a title.
    return { head: headBuffer.toString("utf8"), tail: tailBuffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

/** Iterate complete JSON lines, ignoring a possibly truncated first/last line. */
function* lines(text: string, opts: { skipFirst?: boolean } = {}): Generator<unknown> {
  const raw = text.split("\n");
  if (opts.skipFirst) raw.shift();
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      // Truncated boundary line; ignore.
    }
  }
}

function findHeader(head: string): SessionHeader | null {
  for (const entry of lines(head)) {
    const record = entry as SessionHeader;
    if (record.type === "session") return record;
  }
  return null;
}

function findLastName(text: string): string | undefined {
  let name: string | undefined;
  for (const entry of lines(text)) {
    const record = entry as { type?: string; name?: unknown };
    if (record.type === "session_info") {
      name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : undefined;
    }
  }
  return name;
}

function findFirstUserText(head: string): string | undefined {
  for (const entry of lines(head)) {
    const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (record.type !== "message" || record.message?.role !== "user") continue;
    const text = contentToText(record.message.content);
    if (text) return truncate(text, MAX_TITLE);
  }
  return undefined;
}

/** Flatten a message content value into display text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "image") parts.push("[图片]");
  }
  return parts.join(" ").trim();
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
