/**
 * UI assertions for the send-scroll fix (run against an isolated server).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-scroll.ts http://127.0.0.1:4755/
 *
 * Reproduces the bug scenario: a long transcript, the view not at the bottom,
 * then Enter-send. Before the fix the user's bubble stayed below the fold until
 * the first assistant delta scrolled; now `sendMessage` scrolls itself. The
 * prompt POST is stubbed in the page, so no pi subprocess is ever spawned.
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
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-scroll-"));
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

    // ---- setup: stub the prompt POST, fake an open session, build a long transcript
    await evalJs(`(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "/api/prompt") {
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
          );
        }
        return realFetch(input, init);
      };
      window.piShellDebug.state.path = "/tmp/pi-ui-scroll/fake-session.jsonl";
      const long = Array.from({ length: 40 }, (_, i) => "第 " + (i + 1) + " 行：" + "内容".repeat(30)).join("\\n");
      for (let i = 0; i < 12; i++) {
        window.piShellDebug.handleEvent({ type: "message_end", message: { role: "assistant", content: long } });
      }
      return "ready";
    })()`);

    const boxState = async () =>
      evalJs(`(() => {
        const box = document.getElementById("messages");
        const br = box.getBoundingClientRect();
        const last = box.lastElementChild.getBoundingClientRect();
        return {
          scrollable: box.scrollHeight > box.clientHeight + 50,
          pinned: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
          lastBelowFold: last.bottom > br.bottom + 1,
          lastVisible: last.top >= br.top - 1 && last.bottom <= br.bottom + 1,
          lastIsUser: box.lastElementChild.classList.contains("user"),
        };
      })()`);

    // 1) the transcript is long enough to scroll
    const s1 = (await boxState()) as Record<string, unknown>;
    ok(s1.scrollable, `transcript scrolls (scrollHeight ${s1.scrollable ? ">" : "<="} viewport)`);

    // 2) bug precondition: park the view at the top; the newest bubble is off-screen
    await evalJs(`document.getElementById("messages").scrollTop = 0`);
    const s2 = (await boxState()) as Record<string, unknown>;
    ok(!s2.pinned && s2.lastBelowFold, "precondition: view at top, last bubble below the fold");

    // 3) Enter-send pins the view to the new user bubble without any assistant event
    await evalJs(`(() => {
      const input = document.getElementById("input");
      input.value = "发送后应立即可见，无需手动滚动";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await sleep(300);
    const s3 = (await boxState()) as Record<string, unknown>;
    ok(s3.lastIsUser, "sent bubble is the user's");
    ok(s3.pinned, "view pinned to bottom right after send");
    ok(s3.lastVisible, "user bubble fully visible without manual scrolling");
    ok(await evalJs(`document.getElementById("input").value === ""`), "input cleared");
    ok((await evalJs(`document.querySelectorAll("#messages .msg.error").length`)) === 0, "no error notice after send");

    // 4) same when the view was parked mid-transcript
    await evalJs(`document.getElementById("messages").scrollTop = Math.floor(document.getElementById("messages").scrollHeight / 2)`);
    await evalJs(`(() => {
      const input = document.getElementById("input");
      input.value = "中途位置发送，也应立即可见";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await sleep(300);
    const s4 = (await boxState()) as Record<string, unknown>;
    ok(s4.lastIsUser && s4.pinned && s4.lastVisible, "send from mid-transcript also pins and reveals the bubble");

    // 5) pasted image: the sent bubble reserves intrinsic size
    await evalJs(`(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#c2410c"; ctx.fillRect(0, 0, 640, 480);
      canvas.toBlob((blob) => {
        const file = new File([blob], "test.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.getElementById("input").dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      }, "image/png");
    })()`);
    await sleep(500);
    await evalJs(`(() => {
      const input = document.getElementById("input");
      input.value = "带图片的消息";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await sleep(400);
    const s5 = (await evalJs(`(() => {
      const box = document.getElementById("messages");
      const br = box.getBoundingClientRect();
      const last = box.lastElementChild;
      const img = last.querySelector("img");
      return {
        pinned: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
        lastVisible: last.getBoundingClientRect().bottom <= br.bottom + 1,
        hasImg: !!img,
        imgSize: img ? [img.getAttribute("width"), img.getAttribute("height")].join("x") : "",
      };
    })()`)) as Record<string, unknown>;
    ok(s5.hasImg, "image message sent");
    ok(s5.imgSize === "640x480", `image reserves intrinsic size (got ${s5.imgSize})`);
    ok(s5.pinned && s5.lastVisible, "image message visible right after send");

    // 6) no page errors during the whole run
    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
}

// The script takes a base URL like the sidebar test, but can also boot its own
// isolated server when invoked bare (`node scripts/ui-test-scroll.ts`).
if (process.argv[2]) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
} else {
  const port = 8700 + Math.floor(Math.random() * 200);
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-scroll-sessions-"));
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
