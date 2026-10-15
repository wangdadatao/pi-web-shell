import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensurePrivateLogFiles } from "../scripts/serviceLogs.ts";

describe("ensurePrivateLogFiles", () => {
  it("creates the log directory at 0700 and the log files at 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-"));
    const stdout = join(dir, "stdout.log");
    await writeFile(stdout, "earlier\n", { mode: 0o644 });
    await chmod(stdout, 0o644);

    ensurePrivateLogFiles(dir);

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const name of ["stdout.log", "stderr.log"]) {
      const info = await stat(join(dir, name));
      assert.equal(info.isFile(), true);
      assert.equal(info.mode & 0o777, 0o600);
    }
    assert.equal(await readFile(stdout, "utf8"), "earlier\n");
  });

  it("replaces a log symlink without chmod'ing the target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-"));
    const secret = join(dir, "secret");
    await writeFile(secret, "secret\n", { mode: 0o644 });
    await symlink(secret, join(dir, "stdout.log"));

    ensurePrivateLogFiles(dir);

    assert.equal((await lstat(join(dir, "stdout.log"))).isSymbolicLink(), false);
    assert.equal((await stat(join(dir, "stdout.log"))).mode & 0o777, 0o600);
    assert.equal(await readFile(secret, "utf8"), "secret\n");
    assert.equal((await stat(secret)).mode & 0o777, 0o644);
  });
});
