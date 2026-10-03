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

    const clickToggle = () => cdp.send("Runtime.evaluate", { expression: `document.getElementById("sidebar-toggle").click()` });
    const pressCmdB = async () => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
      await sleep(250);
    };
    const sidebar = () => evalJs(`document.getElementById("app").dataset.sidebar`);
    const paneW = (id: string) => evalJs(`document.getElementById("${id}").getBoundingClientRect().width`);
    // Which header hosts the toggle now, and how far it sits from the left edge.
    const toggleHome = async () => {
      const info = (await evalJs(`(() => {
        const b = document.getElementById("sidebar-toggle");
        const host = b.closest("aside")?.id || (b.closest("#chat-head") ? "chat-head" : "?");
        return { host, x: Math.round(b.getBoundingClientRect().x) };
      })()`)) as { host: string; x: number };
      return info;
    };

    // The app auto-opens the first session; a live SSE stream must survive the
    // collapse cycle below, so remember whether one is up.
    const hadStream = await evalJs(`!!window.piShellDebug?.state?.stream`);
    console.log(`INFO: SSE stream open on load: ${hadStream}`);

    // 1) toggle exists, the old breadcrumb is gone
    ok(await evalJs(`!!document.getElementById("sidebar-toggle")`), "toggle button exists");
    ok(await evalJs(`!document.getElementById("sidebar-crumb")`), "breadcrumb removed");

    // 2) default full: both panes visible, toggle in the folders head at the top-left
    const w0f = Number(await paneW("folders"));
    const w0s = Number(await paneW("sessions"));
    ok(w0f >= 200 && w0s >= 200, `full: pane widths ${w0f}/${w0s}`);
    let t = await toggleHome();
    ok(t.host === "folders" && t.x <= 24, `full: toggle in folders head, top-left (${t.host}, x=${t.x})`);
    ok((await evalJs(`document.getElementById("sidebar-toggle").title`)) === "收起文件夹栏（⌘B）", "tooltip names the next stage");

    // 3) click 1 → sessions only (folders pane collapses, sessions stay)
    await clickToggle();
    await sleep(250);
    ok((await sidebar()) === "no-folders", "click 1 → no-folders");
    ok(Number(await paneW("folders")) < 5 && Number(await paneW("sessions")) >= 200, `no-folders: folders ~0, sessions kept (${await paneW("sessions")})`);
    t = await toggleHome();
    ok(t.host === "sessions" && t.x <= 24, `no-folders: toggle docked to sessions head (${t.host}, x=${t.x})`);

    // 4) click 2 → fullscreen (both panes gone, chat fills the viewport)
    await clickToggle();
    await sleep(250);
    ok((await sidebar()) === "fullscreen", "click 2 → fullscreen");
    ok(Number(await paneW("folders")) < 5 && Number(await paneW("sessions")) < 5, "fullscreen: both panes ~0");
    const cw = Number(await evalJs(`document.getElementById("chat").getBoundingClientRect().width`));
    const vw = Number(await evalJs(`window.innerWidth`));
    ok(Math.abs(cw - vw) < 5, `fullscreen: chat fills viewport (${cw} of ${vw})`);
    t = await toggleHome();
    ok(t.host === "chat-head" && t.x <= 24, `fullscreen: toggle docked to chat head top-left (${t.host}, x=${t.x})`);

    // 5) click 3 → full again (the cycle wraps)
    await clickToggle();
    await sleep(250);
    ok((await sidebar()) === "full" && Number(await paneW("folders")) >= 200, "click 3 → full (cycle wraps)");
    t = await toggleHome();
    ok(t.host === "folders", "toggle back in the folders head");

    // 6) ⌘B jumps straight between full and fullscreen, skipping the middle stage
    await pressCmdB();
    ok((await sidebar()) === "fullscreen", "⌘B from full → fullscreen");
    await pressCmdB();
    ok((await sidebar()) === "full", "⌘B returns to the previous state (full)");

    // 7) ⌘B remembers the intermediate stage as the restore point
    await clickToggle(); // → no-folders
    await sleep(250);
    await pressCmdB(); // → fullscreen
    ok((await sidebar()) === "fullscreen", "⌘B from no-folders → fullscreen");
    await pressCmdB(); // → no-folders
    ok((await sidebar()) === "no-folders", "⌘B restores no-folders, not full");

    // 8) the live stream survived the whole cycle
    if (hadStream) {
      ok(await evalJs(`!!window.piShellDebug?.state?.stream`), "SSE stream alive after cycle");
    }

    // 9) persistence across reload (currently no-folders)
    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2000);
    ok((await sidebar()) === "no-folders" && Number(await paneW("sessions")) >= 200, "persisted: no-folders after reload");
    ok((await evalJs(`localStorage.getItem("piShellSidebar")`)) === "no-folders", "localStorage stores the stage");
    ok((await evalJs(`localStorage.getItem("piShellSidebarLast")`)) === "no-folders", "localStorage stores last-expanded");

    // 10) legacy two-state value "0" migrates to fullscreen
    await evalJs(`localStorage.setItem("piShellSidebar", "0")`);
    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2000);
    ok((await sidebar()) === "fullscreen", `legacy "0" migrates to fullscreen`);
    t = await toggleHome();
    ok(t.host === "chat-head" && t.x <= 24, `after migration toggle in chat head (${t.host}, x=${t.x})`);
    await clickToggle(); // fullscreen → full, leave the profile expanded
    await sleep(250);
    ok((await sidebar()) === "full", "click from fullscreen expands to full");

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
