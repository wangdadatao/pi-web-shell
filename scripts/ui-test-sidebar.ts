/**
 * UI assertions for the sidebar collapse toggle (run against an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-sidebar.ts http://127.0.0.1:4755/
 *
 * Drives headless Chrome over CDP the same way scripts/screenshot.ts does —
 * Node's built-in WebSocket and fetch, zero dependencies. Exits non-zero on the
 * first failed assertion.
 */

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:4711/";

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
    list.push(handler);
    this.handlers.set(method, list);
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

async function main(): Promise<void> {
  const chromeBin = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-sidebar-"));
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
    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2500);

    const evalJs = async (expression: string): Promise<unknown> =>
      (await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }))
        .result?.value;

    // The app auto-opens the first session; a live SSE stream must survive the
    // collapse cycle below, so remember whether one is up.
    const hadStream = await evalJs(`!!window.piShellDebug?.state?.stream`);
    console.log(`INFO: SSE stream open on load: ${hadStream}`);

    // 1) toggle + crumb elements exist
    ok(await evalJs(`!!document.getElementById("sidebar-toggle")`), "toggle button exists");
    ok(await evalJs(`!!document.getElementById("sidebar-crumb")`), "breadcrumb element exists");

    // 2) default expanded
    const w0 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    ok(w0 >= 200, `expanded: folders pane width ${w0} >= 200`);

    // 3) collapse
    await cdp.send("Runtime.evaluate", { expression: `document.getElementById("sidebar-toggle").click()` });
    await sleep(200);
    const w1 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    const w2 = Number(await evalJs(`document.getElementById("sessions").getBoundingClientRect().width`));
    const cw = Number(await evalJs(`document.getElementById("chat").getBoundingClientRect().width`));
    const vw = Number(await evalJs(`window.innerWidth`));
    ok(w1 < 5 && w2 < 5, `collapsed: pane widths ${w1}/${w2} ~ 0`);
    ok(Math.abs(cw - vw) < 5, `collapsed: chat fills viewport (${cw} of ${vw})`);

    // 4) breadcrumb shows the current folder
    const crumb = String(await evalJs(`document.getElementById("sidebar-crumb").textContent`));
    ok(crumb.length > 0, `breadcrumb shows location: "${crumb}"`);

    // 5) the live stream survived the collapse
    if (hadStream) {
      ok(await evalJs(`!!window.piShellDebug?.state?.stream`), "SSE stream alive after collapse");
    }

    // 6) persistence across reload
    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2000);
    const w3 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    ok(w3 < 5, `persisted: still collapsed after reload (width ${w3})`);

    // 7) expand restores
    await cdp.send("Runtime.evaluate", { expression: `document.getElementById("sidebar-toggle").click()` });
    await sleep(200);
    const w4 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    ok(w4 >= 200, `expand restores folders pane (width ${w4})`);
    ok((await evalJs(`localStorage.getItem("piShellSidebar")`)) === "1", "localStorage remembers expanded");

    // 8) Cmd/Ctrl+B keyboard shortcut toggles too
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    await sleep(200);
    const w5 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    ok(w5 < 5, `Cmd/Ctrl+B collapses (width ${w5})`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    await sleep(200);
    const w6 = Number(await evalJs(`document.getElementById("folders").getBoundingClientRect().width`));
    ok(w6 >= 200, `Cmd/Ctrl+B expands (width ${w6})`);

    // 9) no page errors during the whole cycle
    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
  console.log("all sidebar assertions passed");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
