import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
    assert.equal((await readFile(path, "utf8")).trim(), replaced);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("refuses a symlink and does not read or chmod the target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-token-"));
    const target = join(dir, "secret");
    await writeFile(target, `${"b".repeat(43)}\n`, { mode: 0o644 });
    await symlink(target, authTokenPath(dir));

    await assert.rejects(loadOrCreateAuthToken(dir), /symbolic link/);
    assert.equal(await readFile(target, "utf8"), `${"b".repeat(43)}\n`);
    assert.equal((await stat(target)).mode & 0o777, 0o644);
    assert.equal((await lstat(authTokenPath(dir))).isSymbolicLink(), true);
  });

  it("refuses a path that is not a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-token-"));
    const path = authTokenPath(dir);
    await mkdir(path);
    await assert.rejects(loadOrCreateAuthToken(dir), /not a regular file/);
  });

  it("reports an unreadable token file with an actionable error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-token-"));
    const path = authTokenPath(dir);
    await writeFile(path, "keep-me\n", { mode: 0o600 });
    await chmod(path, 0o000);
    try {
      const message = await unreadableMessage(dir, path);
      assert.match(message, /cannot read/);
      assert.match(message, /chmod 600/);
      assert.match(message, /remove it/);
      assert.match(message, /web-shell-token/);
      await chmod(path, 0o600);
      assert.equal(await readFile(path, "utf8"), "keep-me\n");
    } finally {
      await chmod(path, 0o600).catch(() => {});
    }
  });
});

/**
 * Mode 000 is still readable by root. Drop to nobody so the refusal is real.
 * Otherwise the current user is enough.
 */
async function unreadableMessage(dir: string, path: string): Promise<string> {
  if (process.getuid?.() !== 0) {
    try {
      await loadOrCreateAuthToken(dir);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`expected an unreadable-token error for ${path}`);
  }
  await chmod(dir, 0o755);
  const script = `
    import { loadOrCreateAuthToken } from ${JSON.stringify(join(import.meta.dirname, "../src/server/authToken.ts"))};
    try {
      await loadOrCreateAuthToken(process.env.TOKEN_DIR);
      process.stdout.write("OK\\n");
    } catch (error) {
      process.stdout.write((error instanceof Error ? error.message : String(error)) + "\\n");
    }
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      uid: 65534,
      gid: 65534,
      env: { ...process.env, TOKEN_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`unreadable-token child exited ${code}: ${err || out}`));
      else resolve(out.trim());
    });
  });
  if (stdout === "OK") throw new Error(`nobody could read ${path}; the refusal path did not run`);
  return stdout;
}
