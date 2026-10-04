import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/server/sessionRegistry.ts";
import { loadConfig } from "../src/server/config.ts";

/**
 * A stand-in `pi` binary: it records its pid, stays alive, and exits cleanly
 * when the registry closes its stdin. `acquire()` only needs the spawn to
 * succeed, so no protocol answers are required — the registry is exercised
 * with real child processes, which is the point (refs, exits, replacement).
 */
const FAKE_PI = [
  "#!/usr/bin/env node",
  'import { appendFileSync } from "node:fs";',
  "if (process.env.FAKE_PI_PIDFILE)",
  '  appendFileSync(process.env.FAKE_PI_PIDFILE, `${process.pid}\\n`);',
  'process.stdin.on("data", () => undefined);',
  'process.stdin.on("end", () => process.exit(0));',
].join("\n");

interface Fixture {
  registry: SessionRegistry;
  sessionPath: string;
  pidfile: string;
  root: string;
}

async function makeFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-registry-${name}-`));
  const bin = join(root, "fake-pi.mjs");
  await writeFile(bin, FAKE_PI);
  await chmod(bin, 0o755);
  const sessionPath = join(root, "session.jsonl");
  await writeFile(sessionPath, "");
  const pidfile = join(root, "pids");
  // piSession spawns children with our env, so this is how the fake finds it.
  process.env.FAKE_PI_PIDFILE = pidfile;
  const config = loadConfig({ PI_SHELL_PI_BIN: bin, PI_SHELL_IDLE_TIMEOUT_MS: "600000" });
  return { registry: new SessionRegistry(config), sessionPath, pidfile, root };
}

const roots: string[] = [];
after(async () => {
  delete process.env.FAKE_PI_PIDFILE;
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Pids of every fake pi spawned so far, in spawn order. */
async function pids(pidfile: string): Promise<number[]> {
  try {
    return (await readFile(pidfile, "utf8")).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function waitUntil(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("SessionRegistry", () => {
  it("disposeAll retires every live child and empties the table", async () => {
    const f = await makeFixture("dispose-all");
    roots.push(f.root);

    const secondPath = join(f.root, "second.jsonl");
    await writeFile(secondPath, "");
    await f.registry.acquire(f.sessionPath, f.root);
    await f.registry.acquire(secondPath, f.root);
    await waitUntil(async () => (await pids(f.pidfile)).length === 2);
    const [a = -1, b = -1] = (await pids(f.pidfile)).slice(0, 2);

    // This is the "apply config" path: after a settings save, every warm
    // subprocess must be gone so the next acquire respawns with new config.
    await f.registry.disposeAll();
    assert.equal(f.registry.list().length, 0);
    await waitUntil(() => {
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      return !alive(a) && !alive(b);
    });
  });
  it("shares one fresh child between concurrent acquires after a crash", async () => {
    const f = await makeFixture("concurrent");
    roots.push(f.root);

    const m1 = await f.registry.acquire(f.sessionPath, f.root);
    let first = 0;
    await waitUntil(async () => (first = (await pids(f.pidfile))[0] ?? 0) !== 0);
    process.kill(first, "SIGKILL");
    // The corpse stays registered: m1 still holds a reference.
    await waitUntil(() => f.registry.get(f.sessionPath)?.dead === true);

    // Two consumers arrive while the corpse is still in the table. Both must
    // land on one and the same replacement child — a second subprocess would
    // be a second writer for one session file.
    const [a, b] = await Promise.all([
      f.registry.acquire(f.sessionPath, f.root),
      f.registry.acquire(f.sessionPath, f.root),
    ]);
    assert.equal(a, b);
    assert.notEqual(a, m1);
    assert.equal(a.refs, 2);
    await waitUntil(async () => (await pids(f.pidfile)).length === 2);
    assert.equal(f.registry.get(f.sessionPath), a);

    f.registry.release(a);
    f.registry.release(b);
    await f.registry.disposeAll();
  });

  it("releases the entry it was handed, not the one that replaced it", async () => {
    const f = await makeFixture("release");
    roots.push(f.root);

    const m1 = await f.registry.acquire(f.sessionPath, f.root);
    let first = 0;
    await waitUntil(async () => (first = (await pids(f.pidfile))[0] ?? 0) !== 0);
    process.kill(first, "SIGKILL");
    await waitUntil(() => f.registry.get(f.sessionPath)?.dead === true);

    // A new consumer replaces the corpse; the old one (m1) is still attached.
    const m2 = await f.registry.acquire(f.sessionPath, f.root);
    assert.notEqual(m2, m1);
    assert.equal(m2.refs, 1);
    let second = 0;
    await waitUntil(async () => (second = (await pids(f.pidfile))[1] ?? 0) !== 0);

    // The old stream goes away late. A path-keyed release would find m2 in the
    // table, drop its refs to zero, and arm the idle reaper on a child that is
    // still in use; disposing m1 outright would kill m2's subprocess instead.
    f.registry.release(m1);
    assert.equal(m2.refs, 1);
    assert.equal(f.registry.get(f.sessionPath), m2);
    process.kill(second, 0); // still alive

    f.registry.release(m2);
    await f.registry.disposeAll();
  });
});
