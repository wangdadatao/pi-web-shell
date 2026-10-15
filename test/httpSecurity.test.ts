import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp, type ServerDeps } from "../src/server/httpServer.ts";
import { normalizeSessionKey } from "../src/server/paths.ts";
import type { Config } from "../src/server/config.ts";

const TOKEN = "security-test-token";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Listen {
  port: number;
  close: () => Promise<void>;
}

function deps(options: { host?: string; cwd?: string; sessionPath?: string } = {}): ServerDeps {
  const cwd = options.cwd ?? "/tmp";
  const sessionPath = options.sessionPath ? normalizeSessionKey(options.sessionPath) : "";
  return {
    config: {
      host: options.host ?? "127.0.0.1",
      port: 0,
      home: "/tmp",
      agentDir: "/tmp/pi-security-agent",
      sessionsDir: "/tmp/pi-security-sessions",
      sessionDirArg: null,
      piBin: "pi",
      openBrowser: false,
      idleTimeoutMs: 1000,
    } as Config,
    index: {
      listSessions: async () => [],
      listFolders: async () => [],
      get: async (path: string) =>
        sessionPath && normalizeSessionKey(path) === sessionPath
          ? { path: sessionPath, cwd, title: "t", id: "id", createdAt: "", updatedAt: "", mtimeMs: 0, sizeBytes: 0, version: 3 }
          : null,
    },
    registry: {
      list: () => [],
      get: (path: string) =>
        sessionPath && normalizeSessionKey(path) === sessionPath
          ? { path: sessionPath, cwd, refs: 0, streaming: false }
          : undefined,
    },
    branchMarks: { keepParentChildren: async () => new Set<string>() },
    authToken: TOKEN,
  } as unknown as ServerDeps;
}

async function listen(appDeps: ServerDeps): Promise<Listen> {
  const server: Server = createApp(appDeps);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function raw(
  port: number,
  method: string,
  path: string,
  headers: IncomingHttpHeaders = {},
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

describe("API authentication", () => {
  it("rejects a cross-site origin even when the token is present", async () => {
    const app = await listen(deps());
    try {
      const cross = await raw(app.port, "POST", "/api/sessions/new", {
        host: `127.0.0.1:${app.port}`,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
        "x-pi-shell-token": TOKEN,
      }, "not-json");
      assert.equal(cross.status, 403);

      const sameSite = await raw(app.port, "GET", "/api/sessions", {
        host: `127.0.0.1:${app.port}`,
        origin: `http://127.0.0.1:9`,
        "sec-fetch-site": "same-site",
        "x-pi-shell-token": TOKEN,
      });
      assert.equal(sameSite.status, 403);
    } finally {
      await app.close();
    }
  });

  it("rejects a missing or invalid token", async () => {
    const app = await listen(deps());
    try {
      const host = `127.0.0.1:${app.port}`;
      const missing = await raw(app.port, "GET", "/api/sessions", {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
      });
      assert.equal(missing.status, 401);

      const invalid = await raw(app.port, "GET", "/api/sessions", {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
        "x-pi-shell-token": "nope",
      });
      assert.equal(invalid.status, 401);

      const queryOnWrite = await raw(app.port, "POST", `/api/prompt?token=${TOKEN}`, {
        host,
        origin: `http://${host}`,
        "content-type": "application/json",
      }, "{}");
      assert.equal(queryOnWrite.status, 401);
    } finally {
      await app.close();
    }
  });

  it("returns 415 for a write that is not application/json", async () => {
    const app = await listen(deps());
    try {
      const host = `127.0.0.1:${app.port}`;
      const plain = await raw(app.port, "POST", "/api/sessions/new", {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
        "x-pi-shell-token": TOKEN,
      }, "{\"cwd\":\"/tmp\"}");
      assert.equal(plain.status, 415);

      const missingType = await raw(app.port, "POST", "/api/prompt", {
        host,
        origin: `http://${host}`,
        "x-pi-shell-token": TOKEN,
      }, "{}");
      assert.equal(missingType.status, 415);
    } finally {
      await app.close();
    }
  });

  it("protects SSE and local-image, and serves the page plus an in-cwd image", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sec-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-sec-out-"));
    const session = join(root, "session.jsonl");
    const inside = join(root, "pic.png");
    const outsideFile = join(outside, "pic.png");
    await writeFile(session, "");
    await writeFile(inside, PNG);
    await writeFile(outsideFile, PNG);
    const app = await listen(deps({ cwd: root, sessionPath: session }));
    try {
      const host = `127.0.0.1:${app.port}`;
      const own = {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
      };

      const sessions = await raw(app.port, "GET", "/api/sessions", { ...own, "x-pi-shell-token": TOKEN });
      assert.equal(sessions.status, 200);
      assert.equal(JSON.parse(sessions.text).sessions.length, 0);

      const stream = await raw(app.port, "GET", "/api/stream?path=/tmp/nope.jsonl", own);
      assert.equal(stream.status, 401);
      const streamToken = await raw(
        app.port,
        "GET",
        `/api/stream?path=/tmp/nope.jsonl&token=${encodeURIComponent(TOKEN)}`,
        { ...own, "sec-fetch-site": "same-origin" },
      );
      assert.notEqual(streamToken.status, 401);
      assert.notEqual(streamToken.status, 403);

      const events = await raw(app.port, "GET", "/api/events", own);
      assert.equal(events.status, 401);

      const imageBare = await raw(
        app.port,
        "GET",
        `/api/local-image?path=${encodeURIComponent(inside)}&session=${encodeURIComponent(session)}`,
        own,
      );
      assert.equal(imageBare.status, 401);

      const imageCross = await raw(
        app.port,
        "GET",
        `/api/local-image?path=${encodeURIComponent(inside)}&session=${encodeURIComponent(session)}&token=${encodeURIComponent(TOKEN)}`,
        { host, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      );
      assert.equal(imageCross.status, 403);

      const imageOut = await raw(
        app.port,
        "GET",
        `/api/local-image?path=${encodeURIComponent(outsideFile)}&session=${encodeURIComponent(session)}&token=${encodeURIComponent(TOKEN)}`,
        own,
      );
      assert.equal(imageOut.status, 403);

      const imageIn = await raw(
        app.port,
        "GET",
        `/api/local-image?path=${encodeURIComponent(inside)}&session=${encodeURIComponent(session)}&token=${encodeURIComponent(TOKEN)}`,
        { host, "sec-fetch-site": "same-origin" },
      );
      assert.equal(imageIn.status, 200);
      assert.equal(imageIn.headers["content-type"], "image/png");
      assert.equal(imageIn.headers["referrer-policy"], "no-referrer");

      const page = await raw(app.port, "GET", "/", { host });
      assert.equal(page.status, 200);
      assert.match(String(page.headers["content-type"]), /text\/html/);
      assert.equal(page.headers["referrer-policy"], "no-referrer");
      const csp = String(page.headers["content-security-policy"]);
      const scriptSrc = csp.split(";").find((part) => part.trim().startsWith("script-src"));
      assert.ok(scriptSrc);
      assert.match(scriptSrc, /'self'/);
      assert.doesNotMatch(scriptSrc, /unsafe-inline/);
      assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/);
      assert.match(page.text, /需要重新打开终端里的链接/);
      assert.doesNotMatch(page.text, /security-test-token/);
    } finally {
      await app.close();
    }
  });

  it("still enforces token and origin when the bind address is not loopback", async () => {
    const app = await listen(deps({ host: "0.0.0.0" }));
    try {
      const host = "evil.example:4711";
      const noToken = await raw(app.port, "GET", "/api/sessions", { host });
      assert.equal(noToken.status, 401);

      const cross = await raw(app.port, "GET", "/api/sessions", {
        host,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "x-pi-shell-token": TOKEN,
      });
      assert.equal(cross.status, 403);

      const own = await raw(app.port, "GET", "/api/sessions", {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
        "x-pi-shell-token": TOKEN,
      });
      assert.equal(own.status, 200);
    } finally {
      await app.close();
    }
  });
});
