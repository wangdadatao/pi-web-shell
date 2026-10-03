/**
 * UI assertions for ```mermaid rendering (run against an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4756 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-mermaid.ts http://127.0.0.1:4756/
 *
 * Headless Chrome over CDP, same zero-dependency approach as
 * scripts/ui-test-sidebar.ts. Exits non-zero on the first failed assertion.
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
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-mermaid-"));
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
    process.stderr.write("ui-test timed out after 90s\n");
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
    const pageErrors: string[] = [];
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = (params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        .exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    });
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const event = params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (event.type !== "error") return;
      pageErrors.push(`[console.error] ${(event.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
    });
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2500);

    const evalJs = async (expression: string): Promise<unknown> =>
      (
        await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
      ).result?.value;

    /** Push a Markdown reply into the transcript and wait for mermaid to settle. */
    const renderReply = (md: string) =>
      evalJs(`(async () => {
        const messages = document.getElementById("messages");
        messages.innerHTML = '<div class="msg assistant">' + piShellDebug.renderMarkdown(${JSON.stringify(md)}) + "</div>";
        const canvases = [...document.querySelectorAll(".mermaid-body")];
        for (let i = 0; i < 200; i++) {
          if (canvases.length > 0 && canvases.every((c) => c.dataset.mermaidState === "done" || c.dataset.mermaidState === "failed")) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return canvases.map((c) => c.dataset.mermaidState);
      })()`);

    // 1) the 3.4 MB bundle is not on the critical path: no diagram, no mermaid
    ok((await evalJs(`typeof globalThis.mermaid`)) === "undefined", "mermaid not loaded before the first diagram");

    // 2) a flowchart fence renders an SVG, and the fence body survives for "copy"
    const flow = "```mermaid\nflowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n```";
    ok(JSON.stringify(await renderReply(flow)) === '["done"]', "flowchart fence → done");
    ok(await evalJs(`!!document.querySelector(".mermaid-body svg")`), "an inline SVG is in the DOM");
    ok(
      Number(await evalJs(`document.querySelectorAll('.mermaid-body g.node').length`)) === 3,
      "flowchart drew its 3 nodes",
    );
    ok(
      (await evalJs(`document.querySelector(".mermaid-source code").textContent`)) ===
        flow.replace(/^```mermaid\n/, "").replace(/\n```$/, ""),
      "the fence body is kept verbatim for the copy button",
    );
    ok(
      await evalJs(`document.querySelector(".mermaid-source").hidden === true`),
      "source stays collapsed when the diagram renders",
    );
    ok(
      (await evalJs(`document.querySelector(".mermaid-block .code-lang").textContent`)) === "mermaid" &&
        (await evalJs(`document.querySelector(".mermaid-block .copy-btn").dataset.copy`)) === "diagram",
      "the block keeps the code-block header (language + copy)",
    );

    // 3) the diagram fits its column instead of forcing a horizontal scrollbar
    ok(
      await evalJs(`(() => {
        const body = document.querySelector(".mermaid-body");
        const svg = body.querySelector("svg");
        return svg.getBoundingClientRect().width <= body.clientWidth + 1;
      })()`),
      "svg fits the diagram column",
    );

    // 4) mermaid and Prism coexist: the code fence next door is still highlighted
    await renderReply(flow + "\n\ntext\n\n```json\n{\"a\": 1}\n```");
    ok(
      Number(await evalJs(`document.querySelectorAll(".mermaid-block svg").length`)) === 1 &&
        Number(await evalJs(`document.querySelectorAll(".code-block").length`)) === 1,
      "one diagram + one code block",
    );
    ok(
      Number(await evalJs(`document.querySelectorAll(".code-block .token").length`)) > 0,
      "the neighbouring code block is still Prism-highlighted",
    );

    // 5) broken syntax degrades to a readable error plus the source, not a blank box
    ok(
      JSON.stringify(await renderReply("```mermaid\npie title Bad\n  not valid at all\n```")) === '["failed"]',
      "invalid diagram → failed",
    );
    ok(
      await evalJs(`!!document.querySelector(".mermaid-body .mermaid-error") &&
        !document.querySelector(".mermaid-source").hidden`),
      "failure shows the reason and reveals the source",
    );

    // 6) mermaid output bypasses DOMPurify, so labels must not execute script
    await renderReply(
      "```mermaid\nflowchart TD\n  A[\"<img src=x onerror=window.__pwned=1>\"] --> B\n```",
    );
    ok((await evalJs(`window.__pwned`)) === undefined, "script in a label does not execute");
    ok(
      Number(await evalJs(`document.querySelectorAll('.mermaid-body img[onerror]').length`)) === 0,
      "no onerror attribute survives into the DOM",
    );

    // 7) a re-render (stream `text_end` then finalize) leaves exactly one diagram
    await renderReply(flow);
    await renderReply(flow);
    await sleep(500);
    ok(
      Number(await evalJs(`document.querySelectorAll(".mermaid-body").length`)) === 1 &&
        Number(await evalJs(`document.querySelectorAll(".mermaid-body svg").length`)) === 1,
      "re-rendering the same reply does not duplicate diagrams",
    );

    // 8) an unclosed fence stays literal text instead of half-rendering
    await renderReply("```mermaid\nflowchart TD\n  A-->\n```");
    ok(
      (await evalJs(`document.querySelector(".mermaid-body")?.dataset.mermaidState`)) === "failed",
      "malformed flowchart is reported, not silently dropped",
    );

    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
  console.log("all mermaid assertions passed");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
