/**
 * UI assertions for the settings history route (run against an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-settings-route.ts http://127.0.0.1:4755/
 *
 * The bug: opening settings only swapped the view, without a history entry, so
 * the browser's Back button had nothing app-side to return to and exited the
 * whole shell. Now /settings is a pushed route, Back/Forward move between the
 * app's own views, and a refresh on /settings re-enters settings (server serves
 * the shell for that path; the client restores the view on boot).
 *
 * Drives headless Chrome over CDP the same way scripts/ui-test-sidebar.ts does
 * — Node's built-in WebSocket and fetch, zero dependencies. Exits non-zero on
 * the first failed assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function main(baseUrl: string): Promise<void> {
  const chromeBin = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-settings-route-"));
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

    const state = () =>
      evalJs(`(() => ({
        path: location.pathname,
        view: document.getElementById("app").dataset.view,
        appAlive: !!document.getElementById("messages"),
      }))()`) as Promise<{ path: string; view: string; appAlive: boolean }>;

    // 1) fresh load lands on the chat at "/"
    const s1 = await state();
    ok(s1.path === "/" && s1.view === "chat", `fresh load: chat at "/" (got ${s1.view} at ${s1.path})`);

    // 2) the settings button pushes a real /settings entry
    await evalJs(`document.getElementById("settings").click()`);
    await sleep(200);
    const s2 = await state();
    ok(s2.path === "/settings" && s2.view === "settings", `settings button: /settings view (got ${s2.view} at ${s2.path})`);

    // 3) browser Back returns to the chat page — in-app, not off the site.
    // The marker proves the document survived (before the fix, Back unloaded
    // the app entirely: it was the first and only history entry).
    await evalJs(`window.__routeMarker = 42; history.back()`);
    await sleep(400);
    const s3 = await state();
    const marker = await evalJs(`window.__routeMarker`);
    ok(s3.view === "chat" && s3.path === "/", `Back from settings: chat at "/" (got ${s3.view} at ${s3.path})`);
    ok(marker === 42, `Back stayed inside the app (marker ${marker})`);

    // 4) Forward re-enters settings
    await evalJs(`history.forward()`);
    await sleep(400);
    const s4 = await state();
    ok(s4.view === "settings" && s4.path === "/settings", `Forward: settings again (got ${s4.view} at ${s4.path})`);

    // 5) the in-app ‹ button also returns to the chat URL
    await evalJs(`document.getElementById("settings-back").click()`);
    await sleep(400);
    const s5 = await state();
    ok(s5.view === "chat" && s5.path === "/", `‹ button: chat at "/" (got ${s5.view} at ${s5.path})`);

    // 6) Escape likewise
    await evalJs(`document.getElementById("settings").click()`);
    await sleep(200);
    await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await sleep(400);
    const s6 = await state();
    ok(s6.view === "chat" && s6.path === "/", `Escape: chat at "/" (got ${s6.view} at ${s6.path})`);

    // 7) deep link / refresh on /settings: server serves the shell, boot restores the view
    await cdp.send("Page.navigate", { url: `${baseUrl}settings` });
    await sleep(2500);
    const s7 = await state();
    ok(s7.appAlive && s7.view === "settings" && s7.path === "/settings", `deep link: app boots into settings (got ${s7.view} at ${s7.path}, alive=${s7.appAlive})`);
    ok(
      (await evalJs(`document.querySelectorAll(".settings-menu").length`)) === 5,
      "deep link: settings menu rendered",
    );

    // 8) closing deep-loaded settings must replace in place, not Back out of the app
    await evalJs(`document.getElementById("settings-back").click()`);
    await sleep(400);
    const s8 = await state();
    ok(s8.appAlive && s8.view === "chat" && s8.path === "/", `deep-loaded ‹: chat at "/" without leaving (got ${s8.view} at ${s8.path}, alive=${s8.appAlive})`);

    // 9) no page errors during the whole run
    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
}

// The script takes a base URL like the sidebar test, but can also boot its own
// isolated server when invoked bare (`node scripts/ui-test-settings-route.ts`).
if (process.argv[2]) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
} else {
  const port = 8700 + Math.floor(Math.random() * 200);
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-settings-route-sessions-"));
  const repoRoot = join(import.meta.dirname, "..");
  const server: ChildProcess = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PI_SHELL_SESSIONS_DIR: sessionsDir, PI_SHELL_PORT: String(port), PI_SHELL_OPEN_BROWSER: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => undefined);
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    await main(`http://127.0.0.1:${port}/`);
  } finally {
    server.kill("SIGKILL");
  }
}
