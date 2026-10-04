/**
 * Cross-session token / cost accounting.
 *
 * pi writes a `usage` record (token counts plus the computed cost) onto every
 * assistant message in the session `.jsonl` files, so totals for the whole
 * machine can be derived without asking pi anything — no child process needed,
 * which matters because the settings page must work with no session open.
 *
 * Sessions are big (161 MB / 136 files on the first machine this ran on, one
 * file alone 28 MB, mostly base64 images), so:
 *
 * - files are streamed and only lines containing `"usage":` are parsed;
 * - each file's contribution is cached by mtime + size, so the first report is
 *   the only expensive one and unchanged files are never read twice.
 *
 * Measured on that 212 MB / 153 file directory: 0.5 s for a cold full scan,
 * ~0 ms once cached.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageReport, UsageRow, UsageSlice, UsageTotals } from "../shared/types.ts";

/**
 * How many sessions a per-slice session ranking carries. Session rows are the
 * only unbounded part of the payload (one per model × one per file), and the
 * table shows a top-N anyway.
 */
const SESSION_ROWS = 50;

/** The subset of an assistant message's `usage` we total up. */
interface RawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
}

interface RawEntry {
  type?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    provider?: unknown;
    usage?: RawUsage;
  };
}

/** Per-file contribution, kept so an unchanged file never gets re-read. */
interface FileUsage {
  mtimeMs: number;
  sizeBytes: number;
  cwd: string;
  totals: UsageTotals;
  byDay: Map<string, UsageTotals>;
  byModel: Map<string, UsageTotals>;
  /** day → model → totals. Needed for the heatmap, which is one model at a time. */
  byDayModel: Map<string, Map<string, UsageTotals>>;
}

/** Running per-model aggregates (`byDay` needs the real day × model pairs). */
interface ModelSlice {
  totals: UsageTotals;
  byDay: Map<string, UsageTotals>;
  byProject: Map<string, UsageTotals>;
  bySession: Map<string, UsageTotals>;
}

export interface UsageIndexOptions {
  /** Set false in tests to force a full re-scan on every report. */
  cache?: boolean;
}

export class UsageIndex {
  readonly sessionsDir: string;
  private readonly cache = new Map<string, FileUsage>();
  private readonly useCache: boolean;

  constructor(sessionsDir: string, options: UsageIndexOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.useCache = options.cache ?? true;
  }

  /**
   * Total every session file under `sessionsDir`.
   *
   * `titles` maps a session path to a display title (the sidebar's summaries);
   * it is only used to label the per-session rows.
   */
  async report(titles: Map<string, string> = new Map()): Promise<UsageReport> {
    const started = performance.now();
    const paths = await listSessionFiles(this.sessionsDir);

    const perFile: Array<{ path: string; usage: FileUsage }> = [];
    await Promise.all(
      paths.map(async (path) => {
        const info = await stat(path).catch(() => null);
        if (!info) return; // removed between listing and stat
        const cached = this.cache.get(path);
        if (
          this.useCache &&
          cached &&
          cached.mtimeMs === info.mtimeMs &&
          cached.sizeBytes === info.size
        ) {
          perFile.push({ path, usage: cached });
          return;
        }
        const usage = await scanSession(path, info.mtimeMs, info.size);
        if (this.useCache) this.cache.set(path, usage);
        perFile.push({ path, usage });
      }),
    );

    // Forget files that no longer exist, or the cache grows forever.
    if (this.useCache) {
      const live = new Set(paths);
      for (const path of [...this.cache.keys()]) {
        if (!live.has(path)) this.cache.delete(path);
      }
    }

    const totals = emptyTotals();
    const byDay = new Map<string, UsageTotals>();
    const byModel = new Map<string, UsageTotals>();
    const byProject = new Map<string, UsageTotals>();
    const bySession = new Map<string, UsageTotals>();
    const models = new Map<string, ModelSlice>();
    let messages = 0;

    for (const { path, usage } of perFile) {
      messages += usage.totals.calls;
      accumulate(totals, usage.totals);
      addTotals(bySession, path, usage.totals);
      if (usage.cwd) addTotals(byProject, usage.cwd, usage.totals);
      for (const [day, bucket] of usage.byDay) addTotals(byDay, day, bucket);
      for (const [model, bucket] of usage.byModel) addTotals(byModel, model, bucket);

      // Per-model slices. Totals, sessions, and projects come straight from the
      // file's per-model totals; the days need the day × model pairs, which
      // multiplying `byDay` by `byModel` cannot reconstruct.
      for (const [model, bucket] of usage.byModel) {
        const slice = sliceFor(models, model);
        accumulate(slice.totals, bucket);
        addTotals(slice.bySession, path, bucket);
        if (usage.cwd) addTotals(slice.byProject, usage.cwd, bucket);
      }
      for (const [day, byModelOfDay] of usage.byDayModel) {
        for (const [model, bucket] of byModelOfDay) addTotals(sliceFor(models, model).byDay, day, bucket);
      }
    }

    const modelSlices: Record<string, UsageSlice> = {};
    for (const [model, slice] of models) {
      modelSlices[model] = {
        totals: slice.totals,
        byDay: toRows(slice.byDay, (day) => day, "key-desc"),
        byProject: toRows(slice.byProject, (cwd) => cwd, "cost-desc"),
        bySession: toRows(slice.bySession, (path) => titles.get(path) ?? basename(path), "cost-desc").slice(
          0,
          SESSION_ROWS,
        ),
      };
    }

    return {
      scope: "all",
      scanned: { files: perFile.length, messages, ms: Math.round(performance.now() - started) },
      totals,
      byDay: toRows(byDay, (day) => day, "key-desc"),
      byModel: toRows(byModel, (model) => model, "cost-desc"),
      byProject: toRows(byProject, (cwd) => cwd, "cost-desc"),
      bySession: toRows(bySession, (path) => titles.get(path) ?? basename(path), "cost-desc").slice(
        0,
        SESSION_ROWS,
      ),
      models: modelSlices,
    };
  }
}

/** `2026-10-03` in the viewer's local timezone, so "today" means today. */
function localDay(iso: unknown): string {
  if (typeof iso !== "string") return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function scanSession(path: string, mtimeMs: number, sizeBytes: number): Promise<FileUsage> {
  const usage: FileUsage = {
    mtimeMs,
    sizeBytes,
    cwd: "",
    totals: emptyTotals(),
    byDay: new Map(),
    byModel: new Map(),
    byDayModel: new Map(),
  };

  return new Promise<FileUsage>((resolve) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(usage);
    };

    lines.on("line", (line) => {
      if (first) {
        first = false;
        // The header carries the working directory; it is the first line and
        // never contains a usage record, so it needs its own check.
        const header = tryParse(line) as RawEntry | null;
        if (header?.type === "session" && typeof header.cwd === "string") usage.cwd = header.cwd;
      }
      // Cheap prefilter: a line without this substring cannot hold a usage
      // record, and JSON.parse on a multi-megabyte image line is not free.
      if (!line.includes('"usage":')) return;
      const entry = tryParse(line) as RawEntry | null;
      const message = entry?.message;
      if (!message || message.role !== "assistant" || !message.usage) return;

      const raw = message.usage;
      const tokens = {
        input: num(raw.input),
        output: num(raw.output),
        cacheRead: num(raw.cacheRead),
        cacheWrite: num(raw.cacheWrite),
        reasoning: num(raw.reasoning),
        total: num(raw.totalTokens),
        cost: num(raw.cost?.total),
        calls: 1,
      };
      const day = localDay(entry.timestamp);
      const model = `${str(message.provider)}/${str(message.model)}`;
      accumulate(usage.totals, tokens);
      accumulate(bucketFor(usage.byDay, day), tokens);
      accumulate(bucketFor(usage.byModel, model), tokens);
      let byModelOfDay = usage.byDayModel.get(day);
      if (!byModelOfDay) {
        byModelOfDay = new Map();
        usage.byDayModel.set(day, byModelOfDay);
      }
      accumulate(bucketFor(byModelOfDay, model), tokens);
    });
    lines.on("close", finish);
    stream.on("error", finish);
  });
}

function sliceFor(map: Map<string, ModelSlice>, model: string): ModelSlice {
  let slice = map.get(model);
  if (!slice) {
    slice = {
      totals: emptyTotals(),
      byDay: new Map(),
      byProject: new Map(),
      bySession: new Map(),
    };
    map.set(model, slice);
  }
  return slice;
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    cost: 0,
    calls: 0,
  };
}

function accumulate(target: UsageTotals, add: UsageTotals): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheWrite += add.cacheWrite;
  target.reasoning += add.reasoning;
  target.total += add.total;
  target.cost += add.cost;
  target.calls += add.calls;
}

function addTotals(map: Map<string, UsageTotals>, key: string, add: UsageTotals): void {
  accumulate(bucketFor(map, key), add);
}

function bucketFor(map: Map<string, UsageTotals>, key: string): UsageTotals {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyTotals();
    map.set(key, bucket);
  }
  return bucket;
}

function toRows(
  map: Map<string, UsageTotals>,
  label: (key: string) => string,
  order: "key-desc" | "cost-desc",
): UsageRow[] {
  const rows: UsageRow[] = [...map].map(([key, totals]) => ({ key, label: label(key), ...totals }));
  if (order === "key-desc") rows.sort((a, b) => b.key.localeCompare(a.key));
  else rows.sort((a, b) => b.cost - a.cost || b.total - a.total);
  return rows;
}

function tryParse(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
}

/**
 * pi stores sessions one of two ways (see docs/ARCHITECTURE.md), and both have
 * to be walked: `<dir>/--<cwd>--/<file>.jsonl` and `<dir>/<file>.jsonl`.
 */
async function listSessionFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const loose = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(root, entry.name));
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = join(root, entry.name);
        try {
          return (await readdir(dir))
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(dir, name));
        } catch {
          return [];
        }
      }),
  );
  return [...loose, ...nested.flat()];
}
