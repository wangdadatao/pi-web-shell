/**
 * UI assertions for the branch-tree panel and the image lightbox (run against
 * an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-tree.ts http://127.0.0.1:4755/
 *
 * The tree/fork/clone endpoints need a live pi subprocess, so this drives the
 * panel with a stubbed fetch (a realistic reshaped tree payload) and asserts
 * the DOM contract: rendering, active-branch highlight, fork wiring, notices,
 * stream re-attach, and the lightbox for transcript images. The server-side
 * reshape itself is covered by test/treeView.test.ts.
 *
 * Headless Chrome over CDP, same zero-dependency approach as the other
 * ui-tests. Exits non-zero on the first failed assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? null;

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((v): v is string => Boolean(v));

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, (v: unknown) => void>();
  private readonly handlers = new Map<string, Array<(params: unknown) => void>>();

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      }
      if (message.id === undefined) return;
      const resolve = this.pending.get(message.id);
      if (!resolve) return;
      this.pending.delete(message.id);
      if (message.error) throw new Error(message.error.message ?? "cdp error");
      resolve(message.result);
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    const list = this.handlers.get(method) ?? [];
    this.handlers.set(method, list);
    list.push(handler);
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function findChrome(): Promise<string> {
  const { access } = await import("node:fs/promises");
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("Chrome not found; set CHROME_BIN");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`server did not come up at ${url}`);
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

let failed = false;
function ok(cond: unknown, label: string): boolean {
  const pass = Boolean(cond);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
  if (!pass) failed = true;
  return pass;
}

/** A realistic reshaped tree: root → abandoned branch / active branch. */
const FAKE_TREE = {
  nodes: [
    {
      id: "u1",
      kind: "user",
      preview: "怎么修这个 bug？",
      label: null,
      active: true,
      children: [
        {
          id: "s1",
          kind: "assistant",
          preview: "先看日志",
          label: null,
          active: true,
          children: [
            {
              id: "u2",
              kind: "user",
              preview: "方案一（旧分支）",
              label: null,
              active: false,
              children: [],
            },
            {
              id: "u3",
              kind: "user",
              preview: "方案二（当前分支）",
              label: "实验",
              active: true,
              children: [{ id: "s3", kind: "assistant", preview: "新答案", label: null, active: true, children: [] }],
            },
          ],
        },
      ],
    },
  ],
  leafId: "s3",
};

async function main(baseUrl: string): Promise<void> {
  const chromeBin = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-tree-"));
  const child = spawn(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  const hardTimeout = setTimeout(() => {
    child.kill("SIGKILL");
    process.stderr.write("ui-test timed out after 60s\n");
    process.exit(1);
  }, 60_000);

  try {
    await waitForPort(port);
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("no page target");

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const pageErrors: string[] = [];
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        .exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    });
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: baseUrl });
    await sleep(2500);

    const evalJs = async (expression: string): Promise<unknown> =>
      (await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }))
        .result?.value;

    // Stub the three endpoints, and remember what fork was called with.
    await evalJs(`(() => {
      window.__calls = { fork: [], clone: 0, tree: 0, streamReattached: 0 };
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith("/api/tree")) {
          window.__calls.tree += 1;
          return Promise.resolve(new Response(JSON.stringify(window.__FAKE_TREE__), { headers: { "Content-Type": "application/json" } }));
        }
        if (url === "/api/fork") {
          window.__calls.fork.push(JSON.parse(String(init.body)));
          return Promise.resolve(new Response(JSON.stringify({ ok: true, cancelled: false, text: "方案二" }), { headers: { "Content-Type": "application/json" } }));
        }
        if (url === "/api/clone") {
          window.__calls.clone += 1;
          return Promise.resolve(new Response(JSON.stringify({ ok: true, cancelled: false, sessionFile: "/tmp/clone.jsonl" }), { headers: { "Content-Type": "application/json" } }));
        }
        return realFetch(input, init);
      };
      window.__FAKE_TREE__ = ${JSON.stringify(FAKE_TREE)};
      window.piShellDebug.state.path = "/tmp/session.jsonl";
      document.getElementById("tree-btn").disabled = false;
      return "ready";
    })()`);

    // 1) the panel renders as a flat active spine with the side branch folded
    //    into one chip: two turns (user + replies merged), fork buttons on the
    //    spine, the abandoned branch hidden until expanded.
    await evalJs(`document.getElementById("tree-btn").click()`);
    await sleep(400);
    const panel = (await evalJs(`(() => {
      const turns = [...document.querySelectorAll("#tree-body .tree-turn")];
      return {
        open: !document.getElementById("tree-panel").hidden,
        turns: turns.length,
        forks: document.querySelectorAll("#tree-body .tree-fork").length,
        activeTurns: turns.filter((n) => n.classList.contains("active")).length,
        chips: document.querySelectorAll("#tree-body .tree-branch-chip").length,
        chipText: document.querySelector("#tree-body .tree-branch-chip")?.textContent ?? "",
        subLine: document.querySelector("#tree-body .tree-sub")?.textContent ?? "",
        labels: [...document.querySelectorAll("#tree-body .tree-label")].map((l) => l.textContent),
      };
    })()`)) as Record<string, unknown>;
    ok(panel.open, "tree panel opens from the header button");
    ok(panel.turns === 2, `one row per turn on the spine (got ${panel.turns})`);
    ok(panel.forks === 2, `spine turns carry fork buttons (got ${panel.forks})`);
    ok(panel.activeTurns === 2, `active spine highlighted (got ${panel.activeTurns})`);
    ok(panel.chips === 1, `abandoned branch folded into one chip (got ${panel.chips})`);
    ok(String(panel.chipText).includes("1 条"), `chip names its size (${panel.chipText})`);
    ok(String(panel.subLine).includes("先看日志"), `assistant reply folded into the turn (${panel.subLine})`);
    ok(String(panel.labels) === "实验", `label chip rendered (${panel.labels})`);

    // 2) expanding the chip reveals the branch's own turns, fork buttons included
    await evalJs(`document.querySelector("#tree-body .tree-branch-chip").click()`);
    await sleep(200);
    const expanded = (await evalJs(`(() => ({
      turns: document.querySelectorAll("#tree-body .tree-turn").length,
      forks: document.querySelectorAll("#tree-body .tree-fork").length,
      nested: document.querySelectorAll("#tree-body .tree-branch-children .tree-turn").length,
    }))()`)) as Record<string, unknown>;
    ok(expanded.turns === 3 && expanded.nested === 1, `expansion adds the branch's turn (${expanded.turns} total, ${expanded.nested} nested)`);
    ok(expanded.forks === 3, `branch user message got a fork button too (${expanded.forks})`);

    // 3) fork: closes the panel, posts the entryId, re-attaches the stream
    await evalJs(`document.querySelector('#tree-body [data-entry-id="u2"] .tree-fork').click()`);
    await sleep(400);
    const afterFork = (await evalJs(`(() => ({
      closed: document.getElementById("tree-panel").hidden,
      forkCalls: window.__calls.fork,
      notice: [...document.querySelectorAll("#messages .msg.notice")].some((n) => n.textContent.includes("已分叉")),
    }))()`)) as Record<string, unknown>;
    ok(afterFork.closed, "fork closes the panel");
    ok(
      String(JSON.stringify(afterFork.forkCalls)).includes('"entryId":"u2"'),
      `fork posted the right entryId (${JSON.stringify(afterFork.forkCalls)})`,
    );
    ok(afterFork.notice === true, "fork notice shown");

    // 4) clone: posts, closes, refreshes the session list
    await evalJs(`document.getElementById("tree-btn").click()`);
    await sleep(300);
    await evalJs(`document.getElementById("tree-clone").click()`);
    await sleep(500);
    const afterClone = (await evalJs(`(() => ({
      closed: document.getElementById("tree-panel").hidden,
      cloneCalls: window.__calls.clone,
      notice: [...document.querySelectorAll("#messages .msg.notice")].map((n) => n.textContent).join("|"),
    }))()`)) as Record<string, unknown>;
    ok(afterClone.closed && Number(afterClone.cloneCalls) === 1, "clone posted once and closed the panel");
    ok(String(afterClone.notice).includes("已克隆"), `clone notice shown (${afterClone.notice})`);

    // 5) Escape and backdrop close the panel
    await evalJs(`document.getElementById("tree-btn").click()`);
    await sleep(300);
    await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    ok(await evalJs(`document.getElementById("tree-panel").hidden`), "Escape closes the tree panel");
    await evalJs(`document.getElementById("tree-btn").click()`);
    await sleep(300);
    await evalJs(`document.getElementById("tree-panel").click()`);
    ok(await evalJs(`document.getElementById("tree-panel").hidden`), "backdrop click closes the tree panel");

    // 6) lightbox: any transcript image opens full-size in-app
    await evalJs(`(() => {
      const img = document.createElement("img");
      img.className = "md-img-local";
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3C/svg%3E";
      document.getElementById("messages").appendChild(img);
      img.click();
    })()`);
    await sleep(200);
    const box = (await evalJs(`(() => ({
      open: !document.getElementById("lightbox").hidden,
      src: document.getElementById("lightbox-img").src.startsWith("data:image/svg+xml"),
    }))()`)) as Record<string, unknown>;
    ok(box.open && box.src, "transcript image opens the lightbox");
    await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    ok(await evalJs(`document.getElementById("lightbox").hidden`), "Escape closes the lightbox");

    // 7) no page errors during the whole run
    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
}

if (BASE) {
  main(BASE).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
} else {
  const port = 8700 + Math.floor(Math.random() * 200);
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-tree-sessions-"));
  const repoRoot = join(import.meta.dirname, "..");
  const server: ChildProcess = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PI_SHELL_SESSIONS_DIR: sessionsDir, PI_SHELL_PORT: String(port), PI_SHELL_OPEN_BROWSER: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    await main(`http://127.0.0.1:${port}/`);
  } finally {
    server.kill("SIGKILL");
  }
}
