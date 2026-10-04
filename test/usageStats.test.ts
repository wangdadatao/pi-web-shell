import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { UsageIndex } from "../src/server/usageStats.ts";

/** Build a session file the way pi writes them: header line, then entries. */
function sessionFile(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function assistant(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    id: "e1",
    timestamp: "2026-10-03T12:00:00.000Z",
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: { cost: { total: 0.5 }, ...usage },
      ...extra,
    },
  };
}

async function makeSessionsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-"));
  await mkdir(join(root, "--work-a--"), { recursive: true });
  await writeFile(
    join(root, "--work-a--", "a.jsonl"),
    sessionFile([
      { type: "session", cwd: "/work/a", timestamp: "2026-10-03T11:00:00.000Z" },
      { type: "message", message: { role: "user", content: "hi" } },
      assistant({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 8, totalTokens: 126 }),
      assistant({ input: 200, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 2, totalTokens: 240 }),
    ]),
  );
  // Flat layout, a different day and model, plus a truncated trailing line.
  await writeFile(
    join(root, "b.jsonl"),
    sessionFile([
      { type: "session", cwd: "/work/b", timestamp: "2026-10-04T09:00:00.000Z" },
      {
        type: "message",
        timestamp: "2026-10-04T09:30:00.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          usage: { input: 10, output: 2, cost: { total: 0.25 } },
        },
      },
    ]) + '{"type":"message","message":{"role":"assistant","usage":',  // truncated
  );
  // Not a session at all: no header, so it must not create a project row.
  await writeFile(
    join(root, "c.jsonl"),
    sessionFile([{ type: "message", message: { role: "assistant" } }]),
  );
  return root;
}

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("UsageIndex", () => {
  it("totals usage across grouped and flat session layouts", async () => {
    const root = await makeSessionsDir();
    roots.push(root);

    const report = await new UsageIndex(root).report();

    assert.equal(report.scope, "all");
    assert.equal(report.scanned.files, 3);
    assert.equal(report.scanned.messages, 3);
    assert.deepEqual(
      {
        input: report.totals.input,
        output: report.totals.output,
        cacheRead: report.totals.cacheRead,
        cacheWrite: report.totals.cacheWrite,
        reasoning: report.totals.reasoning,
        total: report.totals.total,
        calls: report.totals.calls,
      },
      { input: 310, output: 62, cacheRead: 5, cacheWrite: 1, reasoning: 10, total: 366, calls: 3 },
    );
    assert.equal(report.totals.cost.toFixed(2), "1.25");
  });

  it("breaks the totals down by day, model, project, and session", async () => {
    const root = await makeSessionsDir();
    roots.push(root);
    const aPath = join(root, "--work-a--", "a.jsonl");

    const report = await new UsageIndex(root).report(new Map([[aPath, "Session A"]]));

    assert.deepEqual(
      report.byDay.map((row) => [row.key, row.calls, row.cost]),
      [
        ["2026-10-04", 1, 0.25],
        ["2026-10-03", 2, 1],
      ],
    );
    assert.deepEqual(
      report.byModel.map((row) => [row.key, row.calls]),
      [
        ["deepseek/deepseek-flash", 2],
        ["anthropic/claude", 1],
      ],
    );
    assert.deepEqual(
      report.byProject.map((row) => row.key).sort(),
      ["/work/a", "/work/b"],
    );
    // A session row is labelled with its sidebar title, or its basename when
    // the caller has no title for it.
    const labels = report.bySession.map((row) => row.label).sort();
    assert.deepEqual(labels, ["Session A", "b", "c"]);
    // The header-less file has no cwd, so it contributes no project row.
    assert.equal(report.bySession.length, 3);
    assert.ok(report.byProject.every((row) => row.key !== ""));
  });

  it("only re-reads files whose mtime or size changed", async () => {
    const root = await makeSessionsDir();
    roots.push(root);

    const index = new UsageIndex(root);
    const first = await index.report();
    const second = await index.report();
    assert.equal(second.totals.cost, first.totals.cost);

    // Backdate the file, then rewrite it with different usage: the size change
    // alone must invalidate the cache. `utimes` keeps mtime honest either way.
    const target = join(root, "--work-a--", "a.jsonl");
    await writeFile(
      target,
      sessionFile([
        { type: "session", cwd: "/work/a" },
        assistant({ input: 1, output: 1, cost: { total: 2 } }),
      ]),
    );
    await utimes(target, new Date("2026-10-05T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));

    const third = await index.report();
    assert.equal(third.totals.cost.toFixed(2), "2.25");
    assert.equal(third.totals.calls, 2);
  });

  it("slices the report per model, including the day × model matrix", async () => {
    // One file, two models, on two different days: a naive day × model cross
    // product would give each model both days.
    const root = await mkdtemp(join(tmpdir(), "pi-usage-models-"));
    roots.push(root);
    await writeFile(
      join(root, "two.jsonl"),
      sessionFile([
        { type: "session", cwd: "/work/two" },
        {
          type: "message",
          timestamp: "2026-10-01T10:00:00.000Z",
          message: {
            role: "assistant",
            provider: "a",
            model: "m1",
            usage: { input: 10, output: 1, totalTokens: 11, cost: { total: 1 } },
          },
        },
        {
          type: "message",
          timestamp: "2026-10-02T10:00:00.000Z",
          message: {
            role: "assistant",
            provider: "b",
            model: "m2",
            usage: { input: 20, output: 2, totalTokens: 22, cost: { total: 3 } },
          },
        },
      ]),
    );

    const report = await new UsageIndex(root).report();

    assert.deepEqual(Object.keys(report.models).sort(), ["a/m1", "b/m2"]);
    assert.deepEqual(
      report.models["a/m1"]?.byDay.map((row) => row.key),
      ["2026-10-01"],
    );
    assert.deepEqual(
      report.models["b/m2"]?.byDay.map((row) => row.key),
      ["2026-10-02"],
    );
    assert.equal(report.models["a/m1"]?.totals.cost, 1);
    assert.equal(report.models["b/m2"]?.totals.cost, 3);
    assert.deepEqual(
      report.models["b/m2"]?.byProject.map((row) => row.key),
      ["/work/two"],
    );
    // The slices add up to the whole report.
    const sliceCost = Object.values(report.models).reduce((sum, slice) => sum + slice.totals.cost, 0);
    assert.equal(sliceCost, report.totals.cost);
  });

  it("reports empty totals for a missing directory", async () => {
    const report = await new UsageIndex(join(tmpdir(), "pi-usage-does-not-exist")).report();
    assert.equal(report.scanned.files, 0);
    assert.equal(report.totals.calls, 0);
    assert.deepEqual(report.byDay, []);
  });
});
