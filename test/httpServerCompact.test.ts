import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp, type ServerDeps } from "../src/server/httpServer.ts";
import { normalizeSessionKey } from "../src/server/paths.ts";
import type { Config } from "../src/server/config.ts";

/**
 * POST /api/compact is the landing pad for the built-in `/compact`: pi's
 * `prompt` RPC does not execute built-in commands, so the shell owns this one.
 * What is pinned here is the route's contract — the branches that decide
 * whether a compaction may start at all — with fake deps, no pi subprocess.
 */

const SESSION = "/tmp/pi-compact-test/session.jsonl";

interface FakeManaged {
  path: string;
  cwd: string;
  createdAt: string;
  refs: number;
  streaming: boolean;
  idleTimer: null;
  dead: boolean;
  ui: { status: []; widgets: { aboveEditor: []; belowEditor: [] }; title: null };
  rpc: { send: (command: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };
  commands: Record<string, unknown>[];
}

function fakeManaged(
  path: string,
  options: { streaming?: boolean; send?: (command: Record<string, unknown>) => Promise<unknown> } = {},
): FakeManaged {
  const commands: Record<string, unknown>[] = [];
  return {
    path,
    cwd: "/tmp/pi-compact-test",
    createdAt: new Date().toISOString(),
    refs: 0,
    streaming: options.streaming ?? false,
    idleTimer: null,
    dead: false,
    ui: { status: [], widgets: { aboveEditor: [], belowEditor: [] }, title: null },
    commands,
    rpc: {
      send: async (command: Record<string, unknown>) => {
        commands.push(command);
        return options.send ? options.send(command) : { ok: true };
      },
    },
  };
}

/** One server per scenario: the in-flight compaction set is per-app state. */
async function startApp(options: {
  sessions?: FakeManaged[];
  knownPaths?: string[];
  acquire?: (key: string) => FakeManaged | null;
}): Promise<{
  post: (body: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;
  released: string[];
  close: () => Promise<void>;
}> {
  const sessions = new Map<string, FakeManaged>();
  for (const session of options.sessions ?? []) sessions.set(normalizeSessionKey(session.path), session);
  const released: string[] = [];
  const known = new Set((options.knownPaths ?? []).map((path) => normalizeSessionKey(path)));

  const config = {
    host: "127.0.0.1",
    port: 0,
    home: "/tmp",
    agentDir: "/tmp/pi-compact-agent",
    sessionsDir: "/tmp/pi-compact-sessions",
    sessionDirArg: null,
    piBin: "pi",
    openBrowser: false,
    idleTimeoutMs: 1000,
  } as Config;

  const deps = {
    config,
    index: {
      get: async (path: string) =>
        known.has(path)
          ? { path, cwd: "/tmp/pi-compact-test", title: "t", id: "id", createdAt: "", updatedAt: "", mtimeMs: 0, sizeBytes: 0, version: 3 }
          : null,
    },
    registry: {
      get: (path: string) => sessions.get(normalizeSessionKey(path)),
      acquire: async (path: string) => {
        const acquired = options.acquire?.(path) ?? null;
        if (!acquired) throw new Error("unexpected acquire");
        sessions.set(normalizeSessionKey(path), acquired);
        return acquired;
      },
      release: (managed: FakeManaged) => {
        released.push(managed.path);
      },
    },
    branchMarks: { keepParentChildren: async () => new Set<string>() },
  } as unknown as ServerDeps;

  const server: Server = createApp(deps);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    post: async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    },
    released,
    close: async () => {
      // fetch keeps connections alive; without this `close` never fires.
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

describe("POST /api/compact", () => {
  it("404s for a session that is neither open nor on disk", async () => {
    const app = await startApp({});
    try {
      const { status } = await app.post({ path: SESSION });
      assert.equal(status, 404);
    } finally {
      await app.close();
    }
  });

  it("acquires an idle-reaped session and releases it afterwards", async () => {
    const acquired = fakeManaged(SESSION);
    const app = await startApp({
      knownPaths: [SESSION],
      acquire: () => acquired,
    });
    try {
      const { status, data } = await app.post({ path: SESSION });
      assert.equal(status, 200);
      assert.equal(data["ok"], true);
      assert.deepEqual(acquired.commands, [{ type: "compact" }]);
      assert.deepEqual(app.released, [SESSION]);
    } finally {
      await app.close();
    }
  });

  it("409s while the session is mid-run and never calls the model", async () => {
    const running = fakeManaged(SESSION, { streaming: true });
    const app = await startApp({ sessions: [running] });
    try {
      const { status } = await app.post({ path: SESSION });
      assert.equal(status, 409);
      assert.equal(running.commands.length, 0);
    } finally {
      await app.close();
    }
  });

  it("passes customInstructions through to the compact RPC", async () => {
    const session = fakeManaged(SESSION);
    const app = await startApp({ sessions: [session] });
    try {
      await app.post({ path: SESSION, customInstructions: "  重点保留 RPA 结论  " });
      assert.deepEqual(session.commands, [{ type: "compact", customInstructions: "重点保留 RPA 结论" }]);
    } finally {
      await app.close();
    }
  });

  it("409s a second request while the first compaction is in flight", async () => {
    // A mutable holder, not a `let`: TypeScript cannot see the assignment
    // made inside the promise executor and narrows a `let` to null.
    const pendingReleases: Array<() => void> = [];
    let calls = 0;
    const session = fakeManaged(SESSION, {
      send: () => {
        calls += 1;
        // Only the first call hangs, so the third request below can finish.
        if (calls === 1) {
          return new Promise((resolve) => {
            pendingReleases.push(() => resolve({ tokensBefore: 1 }));
          });
        }
        return Promise.resolve({ tokensBefore: 2 });
      },
    });
    const app = await startApp({ sessions: [session] });
    try {
      const first = app.post({ path: SESSION });
      // Let the first request reach the RPC call before the second arrives.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await app.post({ path: SESSION });
      assert.equal(second.status, 409);
      assert.match(String(second.data["error"]), /压缩中/);

      pendingReleases.shift()?.();
      const firstDone = await first;
      assert.equal(firstDone.status, 200);

      // The slot is free again once the first run finished.
      const third = await app.post({ path: SESSION });
      assert.equal(third.status, 200);
      assert.equal(session.commands.length, 2);
    } finally {
      await app.close();
    }
  });

  it("reports a timeout as pending, not as failure (pi may still be working)", async () => {
    const session = fakeManaged(SESSION, {
      send: () => Promise.reject(new Error("pi command timed out: compact")),
    });
    const app = await startApp({ sessions: [session] });
    try {
      const { status, data } = await app.post({ path: SESSION });
      assert.equal(status, 200);
      assert.equal(data["pending"], true);
    } finally {
      await app.close();
    }
  });

  it("500s with pi's message when compaction itself fails", async () => {
    const session = fakeManaged(SESSION, {
      send: () => Promise.reject(new Error("Nothing to compact (session too small)")),
    });
    const app = await startApp({ sessions: [session] });
    try {
      const { status, data } = await app.post({ path: SESSION });
      assert.equal(status, 500);
      assert.match(String(data["error"]), /Nothing to compact/);
    } finally {
      await app.close();
    }
  });
});
