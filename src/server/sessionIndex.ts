import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { FolderSummary, SessionSummary } from "../shared/types.ts";

const HEAD_BYTES = 256 * 1024;
const MAX_TITLE = 80;
/**
 * Backward name scan. A `/name` is appended once and then buried by everything
 * that follows it, so in a busy file it can sit arbitrarily far from the end —
 * farther than any fixed tail window. We walk back in chunks and stop at the
 * first hit; the cap only bounds the rare from-scratch scan of a large file
 * that was never renamed.
 */
const NAME_SCAN_CHUNK_BYTES = 256 * 1024;
const MAX_NAME_SCAN_BYTES = 4 * 1024 * 1024;

interface SessionHeader {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  /** Set by pi on fork/clone: the file this session branched off from. */
  parentSession?: string;
}

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  summary: SessionSummary;
  /**
   * File size at the last name scan: everything before it has already been
   * examined, so a later read only has to look at what was appended since.
   */
  nameScanTo: number;
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
 * Files can be large, so we read a head slice (header + first user message) and
 * find the most recent `/name` by scanning back from the end.
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

    const cached = this.useCache ? this.cache.get(path) : undefined;
    if (
      cached &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.sizeBytes === fileStat.size
    ) {
      return cached.summary;
    }

    const head = await readHead(path, fileStat.size);
    const header = findHeader(head);
    if (!header?.cwd) return null;

    const name = await this.findName(path, fileStat.size, head, cached);
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
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
    };

    this.cache.set(path, {
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
      summary,
      nameScanTo: fileStat.size,
    });
    return summary;
  }

  /**
   * The most recent `session_info` name, or undefined when never renamed.
   *
   * pi appends the name and then keeps appending the conversation, so a rename
   * can end up far from the end of a large, busy file. Because the file is
   * append-only, a scan we already ran stays valid: only the bytes written since
   * can hold a newer name. So we read just that tail-delta, and only fall back
   * to a bounded backward scan on the first (or a rewritten) file.
   */
  private async findName(
    path: string,
    size: number,
    head: string,
    cached: CacheEntry | undefined,
  ): Promise<string | undefined> {
    // The head slice is the entire file, so it already holds the last name.
    if (size <= HEAD_BYTES) return findLastName(head);

    // Append-only: anything before the last scan's EOF was already examined.
    if (cached && size >= cached.nameScanTo) {
      const appended = (await readRange(path, cached.nameScanTo, size)).toString("utf8");
      return findLastName(appended) ?? cached.summary.name;
    }

    return scanNameBackward(path, size, head);
  }
}

function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.jsonl$/, "");
}

async function readHead(path: string, size: number): Promise<string> {
  if (size === 0) return "";
  const length = Math.min(HEAD_BYTES, size);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    // A byte cut can land inside a character, and the decoder answers with
    // U+FFFD — verified: a truncated UTF-8 sequence never decodes to half of a
    // surrogate pair, so there is nothing to repair here. Nor can the damage
    // escape: the mangled line is always a partial line, and a partial line
    // fails `JSON.parse` inside `lines()`, so it is dropped before it can reach
    // a title.
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read the half-open byte range `[start, end)` as raw bytes. */
async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const buffer = Buffer.alloc(end - start);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Find the last `session_info` by walking backward from EOF in chunks.
 *
 * We stop at the first window that contains one: it abuts the end of the file,
 * so the last name in it is the file's last name. Chunks are concatenated as
 * bytes and decoded once, so a character split at a chunk boundary cannot
 * corrupt the line we are looking for. If the cap is reached first, the head
 * slice is the only remaining cheap place a name could be.
 */
async function scanNameBackward(
  path: string,
  size: number,
  head: string,
): Promise<string | undefined> {
  const floor = Math.max(0, size - MAX_NAME_SCAN_BYTES);
  const chunks: Buffer[] = [];
  let end = size;
  while (end > floor) {
    const start = Math.max(floor, end - NAME_SCAN_CHUNK_BYTES);
    chunks.unshift(await readRange(path, start, end));
    const name = findLastName(Buffer.concat(chunks).toString("utf8"));
    if (name !== undefined) return name;
    end = start;
  }
  return findLastName(head);
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
