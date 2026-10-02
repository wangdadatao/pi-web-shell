import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/server/sessionIndex.ts";

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function header(cwd: string, id: string, version = 3): string {
  return line({ type: "session", version, id, timestamp: "2024-12-03T14:00:00.000Z", cwd });
}

describe("SessionIndex", () => {
  let root: string;
  let index: SessionIndex;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-shell-test-"));
    index = new SessionIndex(root);

    // Folder name is deliberately lossy: the real cwd contains dashes.
    const dirA = join(root, "--Users-me-my-project--");
    await mkdir(dirA, { recursive: true });
    await writeFile(
      join(dirA, "2024-12-03T14-00-00-000Z_aaa.jsonl"),
      header("/Users/me/my-project", "aaa") +
        line({ type: "model_change", id: "m1", parentId: null, provider: "deepseek", modelId: "deepseek-flash" }) +
        line({ type: "message", id: "u1", parentId: "m1", message: { role: "user", content: "修复登录 bug" } }) +
        line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } }),
    );

    // A named session in a second folder.
    const dirB = join(root, "--Users-me-other--");
    await mkdir(dirB, { recursive: true });
    await writeFile(
      join(dirB, "2024-12-04T10-00-00-000Z_bbb.jsonl"),
      header("/Users/me/other", "bbb") +
        line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "重构" } }) +
        line({ type: "session_info", id: "i1", parentId: "u1", name: "重构 auth" }),
    );
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the working directory from the header, not the folder name", async () => {
    const sessions = await index.listSessions();
    const cwds = sessions.map((s) => s.cwd).sort();
    assert.deepEqual(cwds, ["/Users/me/my-project", "/Users/me/other"]);
  });

  it("prefers a session name over the first user message", async () => {
    const sessions = await index.listSessions();
    const named = sessions.find((s) => s.cwd === "/Users/me/other");
    assert.equal(named?.title, "重构 auth");
    assert.equal(named?.name, "重构 auth");
  });

  it("falls back to the first user message for the title", async () => {
    const sessions = await index.listSessions();
    const plain = sessions.find((s) => s.cwd === "/Users/me/my-project");
    assert.equal(plain?.title, "修复登录 bug");
    assert.equal(plain?.name, undefined);
  });

  it("groups folders with session counts, newest first", async () => {
    const sessions = await index.listSessions();
    const folders = await index.listFolders(sessions);
    assert.equal(folders.length, 2);
    assert.equal(folders[0]?.cwd, "/Users/me/other");
    assert.equal(folders[0]?.sessionCount, 1);
  });

  it("returns an empty list for a missing sessions directory", async () => {
    const missing = new SessionIndex(join(root, "does-not-exist"));
    assert.deepEqual(await missing.listSessions(), []);
  });

  it("also indexes sessions stored flat in the root (pi --session-dir layout)", async () => {
    await writeFile(
      join(root, "flat.jsonl"),
      header("/Users/me/flat", "flat") +
        line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "扁平布局" } }),
    );
    const sessions = await index.listSessions();
    const flat = sessions.find((s) => s.cwd === "/Users/me/flat");
    assert.ok(flat, "expected the root-level session to be indexed");
    assert.equal(flat.title, "扁平布局");

    const folders = await index.listFolders(sessions);
    assert.ok(folders.some((f) => f.cwd === "/Users/me/flat"));
  });

  it("caches summaries and invalidates when the file changes", async () => {
    const sessions = await index.listSessions();
    const target = sessions.find((s) => s.cwd === "/Users/me/my-project");
    assert.ok(target);

    const again = await index.get(target.path);
    assert.equal(again?.title, target.title);

    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      target.path,
      line({ type: "session_info", id: "i9", parentId: "a1", name: "改名了" }),
    );
    const updated = await index.get(target.path);
    assert.equal(updated?.name, "改名了");
  });
});
