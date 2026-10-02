import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionKey } from "../src/server/paths.ts";

describe("normalizeSessionKey", () => {
  let root: string;
  let realDir: string;
  let linkDir: string;

  before(async () => {
    // /tmp is itself a symlink on macOS; build an explicit one so the test
    // does not depend on that.
    root = await mkdtemp(join(realpathSync(tmpdir()), "pi-paths-"));
    realDir = join(root, "real");
    linkDir = join(root, "link");
    await mkdir(realDir);
    await symlink(realDir, linkDir);
    await writeFile(join(realDir, "s.jsonl"), "x");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a symlinked existing file to the real path", () => {
    const viaLink = join(linkDir, "s.jsonl");
    assert.equal(normalizeSessionKey(viaLink), join(realDir, "s.jsonl"));
  });

  it("resolves the deepest existing ancestor for a not-yet-written file", () => {
    const pending = join(linkDir, "pending.jsonl");
    // The key must match what the file will become once it lands via the real
    // directory, so a pending session cannot be registered twice.
    assert.equal(normalizeSessionKey(pending), join(realDir, "pending.jsonl"));
  });

  it("stays consistent before and after the file lands", async () => {
    const pending = join(linkDir, "lands.jsonl");
    const before = normalizeSessionKey(pending);
    await writeFile(pending, "x");
    try {
      assert.equal(normalizeSessionKey(pending), before);
    } finally {
      const { unlink } = await import("node:fs/promises");
      await unlink(pending);
    }
  });

  it("falls back to the resolved lexical path when nothing exists", () => {
    const ghost = join(linkDir, "ghost", "deeper", "g.jsonl");
    // Only the link exists; the ghost part does not. Parent resolution kicks in
    // at the link and keeps the rest as-is.
    assert.ok(normalizeSessionKey(ghost).endsWith(join("ghost", "deeper", "g.jsonl")));
  });

  it("is idempotent", () => {
    const once = normalizeSessionKey(join(linkDir, "s.jsonl"));
    assert.equal(normalizeSessionKey(once), once);
  });
});
