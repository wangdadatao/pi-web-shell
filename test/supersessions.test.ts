import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BranchMarkStore,
  defaultBranchMarkStorePath,
  hideSupersededSessions,
} from "../src/server/supersessions.ts";
import type { SessionSummary } from "../src/shared/types.ts";

let seq = 0;
/** A minimal summary; only the fields the fold rule reads matter. */
function session(path: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  seq += 1;
  return {
    path,
    id: `s${seq}`,
    cwd: "/Users/me/proj",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    mtimeMs: 1_000,
    sizeBytes: 10,
    title: "t",
    version: 3,
    ...overrides,
  };
}

const T0 = Date.parse("2026-10-10T00:00:00.000Z");

describe("hideSupersededSessions", () => {
  const old = "/sessions/old.jsonl";
  const child = "/sessions/child.jsonl";

  it("hides a parent that a child forked away from (the edit-resend case)", () => {
    // The fork copies the session and abandons the old file mid-conversation:
    // the parent's last write (03:25:22) predates the child's creation
    // (03:25:23) by the fork itself.
    const out = hideSupersededSessions(
      [
        session(old, { mtimeMs: T0 - 1_000 }),
        session(child, { createdAt: "2026-10-10T00:00:01.000Z", mtimeMs: T0 + 5_000, parentSession: old }),
      ],
      new Set(),
    );
    assert.deepEqual(out.map((s) => s.path), [child]);
  });

  it("folds a whole chain to its tip (grandparent → parent → tip)", () => {
    const mid = "/sessions/mid.jsonl";
    const tip = "/sessions/tip.jsonl";
    const out = hideSupersededSessions(
      [
        session(old, { mtimeMs: T0 - 10_000 }),
        session(mid, { createdAt: "2026-10-10T00:00:05.000Z", mtimeMs: T0 - 1_000, parentSession: old }),
        session(tip, { createdAt: "2026-10-10T00:00:09.000Z", mtimeMs: T0 + 3_000, parentSession: mid }),
      ],
      new Set(),
    );
    assert.deepEqual(out.map((s) => s.path), [tip]);
  });

  it("keeps a parent that lived on after the fork (written past the child's birth)", () => {
    // Real case: forked at 10:13, but the user kept working in the OLD session
    // until the next day, while the child also saw activity later. Both are
    // independent threads — the child being newer overall must not fold the
    // parent away.
    const out = hideSupersededSessions(
      [
        session(old, { mtimeMs: T0 + 60_000 }),
        session(child, { createdAt: "2026-10-09T10:13:57.000Z", mtimeMs: T0 + 90_000, parentSession: old }),
      ],
      new Set(),
    );
    assert.deepEqual(out.map((s) => s.path).sort(), [child, old]);
  });

  it("keeps the parent when the child was marked keep-parent (clone / tree fork)", () => {
    const out = hideSupersededSessions(
      [
        session(old, { mtimeMs: T0 - 1_000 }),
        session(child, { createdAt: "2026-10-10T00:00:01.000Z", mtimeMs: T0 + 5_000, parentSession: old }),
      ],
      new Set([child]),
    );
    assert.deepEqual(out.map((s) => s.path).sort(), [child, old]);
  });

  it("resuming the parent later brings it back (write lands after the child's birth)", () => {
    const out = hideSupersededSessions(
      [
        session(old, { mtimeMs: T0 + 50_000 }),
        session(child, { createdAt: "2026-10-10T00:00:01.000Z", mtimeMs: T0 + 2_000, parentSession: old }),
      ],
      new Set(),
    );
    assert.equal(out.length, 2);
  });

  it("leaves unrelated sessions untouched", () => {
    const lone = "/sessions/lone.jsonl";
    const out = hideSupersededSessions([session(old), session(lone)], new Set());
    assert.equal(out.length, 2);
  });

  it("deleting the child restores the parent (child absent from the listing)", () => {
    const out = hideSupersededSessions([session(old, { mtimeMs: 1_000 })], new Set());
    assert.deepEqual(out.map((s) => s.path), [old]);
  });
});

describe("BranchMarkStore", () => {
  let root: string;
  let store: BranchMarkStore;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-shell-marks-"));
    store = new BranchMarkStore(join(root, "branch-marks.jsonl"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips keep-parent children and invalidates its cache on append", async () => {
    assert.equal((await store.keepParentChildren()).size, 0);

    await store.mark({ child: "/sessions/a.jsonl", keepParent: true, at: 1 });
    await store.mark({ child: "/sessions/b.jsonl", keepParent: false, at: 2 });
    let keep = await store.keepParentChildren();
    assert.deepEqual([...keep], ["/sessions/a.jsonl"]);

    await store.mark({ child: "/sessions/c.jsonl", keepParent: true, at: 3 });
    keep = await store.keepParentChildren();
    assert.equal(keep.size, 2);
    assert.ok(keep.has("/sessions/c.jsonl"));
  });

  it("skips corrupt or non-object lines without failing", async () => {
    const path = join(root, "corrupt.jsonl");
    await writeFile(path, "not json\n{\"child\": \"/x\", \"keepParent\": true}\n{ truncated\n", "utf8");
    const keep = await new BranchMarkStore(path).keepParentChildren();
    assert.deepEqual([...keep], ["/x"]);
  });

  it("returns empty for a missing file and never throws from mark()", async () => {
    const missing = new BranchMarkStore(join(root, "nope", "deeper", "marks.jsonl"));
    assert.equal((await missing.keepParentChildren()).size, 0);
    await missing.mark({ child: "/sessions/z.jsonl", keepParent: true, at: 4 });
    const keep = await missing.keepParentChildren();
    assert.deepEqual([...keep], ["/sessions/z.jsonl"]);
    // The append created the directory chain.
    await stat(join(root, "nope", "deeper", "marks.jsonl"));
  });
});

describe("defaultBranchMarkStorePath", () => {
  it("lives next to pi's agent dir, outside the agent dir itself", () => {
    assert.equal(
      defaultBranchMarkStorePath("/Users/me/.pi/agent"),
      "/Users/me/.pi/web-shell/branch-marks.jsonl",
    );
  });

  it("follows PI_CODING_AGENT_DIR overrides instead of the real home", () => {
    // Test runners point PI_CODING_AGENT_DIR at a temp dir; the marks must
    // stay inside that boundary, not leak into ~/.pi.
    assert.equal(
      defaultBranchMarkStorePath("/tmp/pi-shell-test-x/agent"),
      "/tmp/pi-shell-test-x/web-shell/branch-marks.jsonl",
    );
  });
});
