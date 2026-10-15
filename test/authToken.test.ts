import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUTH_TOKEN_FILENAME, authTokenPath, loadOrCreateAuthToken } from "../src/server/authToken.ts";

describe("loadOrCreateAuthToken", () => {
  it("creates a 0600 file and reuses it across calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-token-"));
    const first = await loadOrCreateAuthToken(dir);
    const second = await loadOrCreateAuthToken(dir);
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);

    const path = authTokenPath(dir);
    assert.equal(path, join(dir, AUTH_TOKEN_FILENAME));
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).trim(), first);
  });

  it("tightens permissions on an existing token and replaces a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-token-"));
    const path = authTokenPath(dir);
    const valid = "a".repeat(43);
    await writeFile(path, `${valid}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    const reused = await loadOrCreateAuthToken(dir);
    assert.equal(reused, valid);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    await writeFile(path, "too-short\n", { mode: 0o644 });
    const replaced = await loadOrCreateAuthToken(dir);
    assert.notEqual(replaced, "too-short");
    assert.match(replaced, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
