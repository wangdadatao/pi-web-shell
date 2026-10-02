/**
 * Headless screenshot tool.
 *
 * Drives Chrome over the DevTools Protocol so we can capture pages that hold
 * long-lived connections (our SSE stream), which plain `--screenshot` waits on
 * forever. Uses Node's built-in WebSocket and fetch, so no dependencies.
 *
 * Usage:
 *   node scripts/screenshot.ts <url> <out.png> [--width 1440] [--height 900]
 *                              [--wait 4000] [--full] [--scale 2]
 *                              [--eval "document.title"]
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((value): value is string => Boolean(value));

interface Options {
  url: string;
  out: string;
  width: number;
  height: number;
  waitMs: number;
  fullPage: boolean;
  scale: number;
  evalExpr: string | null;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(token, next);
        i += 1;
      } else {
        flags.set(token, true);
      }
    } else {
      positional.push(token);
    }
  }
  const url = positional[0];
  const out = positional[1];
  if (!url || !out) {
    throw new Error("usage: screenshot.ts <url> <out.png> [--width N] [--height N] [--wait ms] [--full] [--scale N]");
  }
  return {
    url,
    out,
    width: Number(flags.get("--width") ?? 1440),
    height: Number(flags.get("--height") ?? 900),
    waitMs: Number(flags.get("--wait") ?? 3500),
    fullPage: flags.has("--full"),
    scale: Number(flags.get("--scale") ?? 2),
    evalExpr: typeof flags.get("--eval") === "string" ? String(flags.get("--eval")) : null,
  };
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

class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "cdp error"));
      else pending.resolve(message.result);
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const chrome = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-shell-chrome-"));

  const child = spawn(
    chrome,
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
    process.stderr.write("screenshot timed out after 90s\n");
    process.exit(1);
  }, 90_000);

  try {
    await waitForPort(port);
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("no page target");

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    // Surface page-side breakage; without this a thrown module just looks blank.
    const pageErrors: string[] = [];
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        .exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const event = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (event.type !== "error" && event.type !== "warning") return;
      const text = (event.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? "")))
        .join(" ");
      pageErrors.push(`[console.${event.type ?? "log"}] ${text}`);
    });

    await cdp.send("Page.enable");
    // A native alert/prompt blocks the renderer, and nothing in CDP dismisses it
    // on its own -- an unhandled one hangs the screenshot forever. Auto-accept.
    cdp.on("Page.javascriptDialogOpening", () => {
      void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: options.url });
    await sleep(options.waitMs);

    if (pageErrors.length > 0) {
      process.stdout.write(`page errors (${pageErrors.length}):\n`);
      for (const error of pageErrors.slice(0, 5)) process.stdout.write(`  ${error.split("\n")[0]}\n`);
    }
    if (options.evalExpr) {
      const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>(
        "Runtime.evaluate",
        { expression: options.evalExpr, returnByValue: true, awaitPromise: true },
      );
      if (result.exceptionDetails) {
        process.stderr.write(`eval error: ${result.exceptionDetails.text ?? "unknown"}\n`);
      } else {
        process.stdout.write(`eval: ${JSON.stringify(result.result.value)}\n`);
      }
    }

    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: options.fullPage,
    });
    await writeFile(options.out, Buffer.from(shot.data, "base64"));
    cdp.close();
    process.stdout.write(`screenshot → ${options.out} (${options.width}x${options.height} @${options.scale}x)\n`);
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
