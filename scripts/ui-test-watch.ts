/**
 * UI assertions for the watch panel (read-only live tail of a second session).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/x PI_SHELL_PORT=4755 PI_SHELL_OPEN_BROWSER=0 \
 *     node src/server/index.ts &
 *   node scripts/ui-test-watch.ts http://127.0.0.1:4755/
 *
 * The panel rides its own /api/stream, so this replaces EventSource with a
 * fake before watching and feeds it synthetic frames: snapshot tail, live
 * status, streamed assistant text, tool lines, give-up notice, and clean
 * teardown. The real stream plumbing (refs, retries, idle reaping) is covered
 * by the server-side registry tests.
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

async function main(baseUrl: string): Promise<void> {
  const chromeBin = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-watch-"));
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

    // Replace EventSource before watching; the fake records URL and frames.
    await evalJs(`(() => {
      window.__watchFake = { instances: [] };
      class FakeEventSource {
        constructor(url) {
          this.url = url;
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.closed = false;
          window.__watchFake.instances.push(this);
        }
        close() { this.closed = true; }
      }
      window.EventSource = FakeEventSource;
      return "stubbed";
    })()`);

    const send = (frame: unknown) =>
      evalJs(`window.__watchFake.instances[window.__watchFake.instances.length - 1].onmessage({ data: ${JSON.stringify(
        JSON.stringify(frame),
      )} })`);

    // 0) the panel must not paint before it is opened: display:flex on the
    // panel beats the UA [hidden] rule unless the stylesheet guards it —
    // this exact bug shipped once (visible from first paint, eye could not
    // hide it), so assert the computed style, not the hidden property.
    ok(
      (await evalJs(`getComputedStyle(document.getElementById("watch-panel")).display`)) === "none",
      "before watching: panel takes no space (computed display none)",
    );

    // 1) watching opens the panel and its own stream to the right path
    await evalJs(`window.piShellDebug.startWatch({ path: "/tmp/watched.jsonl", title: "被盯的会话", cwd: "/tmp/proj/sub" })`);
    await sleep(200);
    const opened = (await evalJs(`(() => ({
      visible: !document.getElementById("watch-panel").hidden,
      display: getComputedStyle(document.getElementById("watch-panel")).display,
      url: window.__watchFake.instances[0]?.url ?? "",
      title: document.getElementById("watch-title").textContent,
      status: document.getElementById("watch-status").className,
      chatPadded: getComputedStyle(document.getElementById("chat")).paddingRight !== "0px",
    }))()`)) as Record<string, unknown>;
    ok(opened.visible, "watch panel opens");
    ok(opened.display === "flex", `panel actually renders (${opened.display})`);
    ok(String(opened.url).includes("/api/stream%3Fpath".replace("%3F", "?").replace("?", "%3F")) || String(opened.url).includes("/api/stream?path="), `own stream to /api/stream?path= (${opened.url})`);
    ok(String(opened.url).includes(encodeURIComponent("/tmp/watched.jsonl")), `stream points at the watched session (${opened.url})`);
    ok(opened.title === "被盯的会话", `title shown (${opened.title})`);
    ok(String(opened.status).includes("loading"), `connecting status (${opened.status})`);
    ok(opened.chatPadded, "chat column yields space to the panel");

    // 2) snapshot tail renders one line per message, tool results included
    await send({
      type: "snapshot",
      messages: [
        { role: "system", content: "skip me" },
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "toolResult", toolName: "bash", content: "" },
        { role: "user", content: [{ type: "text", text: "第二问（块内容）" }] },
      ],
      state: { isStreaming: false },
    });
    const tailed = (await evalJs(`(() => ({
      lines: [...document.querySelectorAll("#watch-messages .watch-line")].map((l) => l.textContent),
      status: document.getElementById("watch-status").className,
    }))()`)) as Record<string, unknown>;
    const lines = tailed.lines as string[];
    ok(lines.length === 4, `one line per message, system skipped (got ${lines.length})`);
    ok(lines[0]?.includes("第一问") && lines[0]?.includes("你"), `user line prefixed (${lines[0]})`);
    ok(lines[2] === "🔧 bash", `tool line (${lines[2]})`);
    ok(lines[3]?.includes("第二问"), `block-array content flattened (${lines[3]})`);
    ok(String(tailed.status).includes("idle"), `idle after snapshot (${tailed.status})`);

    // 3) live: status flips, streamed text lands in one growing line, tools log
    await send({ type: "event", event: { type: "agent_start" } });
    ok((await evalJs(`document.getElementById("watch-status").className.includes("live")`)), "agent_start → live");
    await send({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "正在生成的回答" } } });
    await send({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "的后半段" } } });
    await send({ type: "event", event: { type: "tool_execution_start", toolName: "edit" } });
    const streamed = (await evalJs(`(() => ({
      lines: [...document.querySelectorAll("#watch-messages .watch-line")].map((l) => l.textContent),
    }))()`)) as { lines: string[] };
    ok(
      streamed.lines.at(-2)?.includes("正在生成的回答的后半段"),
      `deltas accumulate into one line (${streamed.lines.at(-2)})`,
    );
    ok(streamed.lines.at(-1) === "🔧 edit", `tool line during run (${streamed.lines.at(-1)})`);

    // 4) message_end finalizes the streamed line; agent_settled goes idle
    await send({ type: "event", event: { type: "message_end", message: { role: "assistant", content: "最终回答定稿" } } });
    await send({ type: "event", event: { type: "agent_settled" } });
    const settled = (await evalJs(`(() => ({
      lines: [...document.querySelectorAll("#watch-messages .watch-line")].map((l) => l.textContent),
      streamingLeft: !!document.querySelector("#watch-messages .watch-line.streaming"),
      status: document.getElementById("watch-status").className,
    }))()`)) as Record<string, unknown>;
    const settledLines = settled.lines as string[];
    ok(
      settledLines.includes("pi · 最终回答定稿"),
      `message_end finalizes the streamed line in place (${settledLines.at(-2)})`,
    );
    ok(settled.streamingLeft === false, "streaming class cleared");
    ok(String(settled.status).includes("idle"), `settled → idle (${settled.status})`);

    // 5) give-up path: retries exhausted leaves a visible notice
    await evalJs(`(() => {
      const watch = window.piShellDebug.state.watch;
      watch.retries = 3;
      window.__watchFake.instances[window.__watchFake.instances.length - 1].onerror();
    })()`);
    await sleep(200);
    const gaveUp = (await evalJs(`(() => ({
      notice: [...document.querySelectorAll("#watch-messages .watch-line.notice")].some((l) => l.textContent.includes("断开")),
      panelOpen: !document.getElementById("watch-panel").hidden,
    }))()`)) as Record<string, unknown>;
    ok(gaveUp.notice && gaveUp.panelOpen, "retries exhausted → visible notice, panel stays for manual retry");

    // 6) Escape must not close the watch panel (it is not a modal)
    await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    ok(await evalJs(`!document.getElementById("watch-panel").hidden`), "Escape leaves the watch panel alone");

    // 7) teardown: closing the panel closes the stream
    await evalJs(`window.piShellDebug.stopWatch()`);
    const closed = (await evalJs(`(() => ({
      hidden: document.getElementById("watch-panel").hidden,
      display: getComputedStyle(document.getElementById("watch-panel")).display,
      streamClosed: window.__watchFake.instances.every((i) => i.closed),
      watchNull: window.piShellDebug.state.watch === null,
    }))()`)) as Record<string, unknown>;
    ok(
      closed.hidden && closed.streamClosed && closed.watchNull && closed.display === "none",
      `stopWatch closes the stream, clears state, and actually hides (${closed.display})`,
    );

    // 8) no page errors during the whole run
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
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-watch-sessions-"));
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
