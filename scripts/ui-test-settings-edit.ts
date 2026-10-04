/**
 * UI assertions for editing pi's settings.json from the settings page (run
 * against an isolated server with its own agent directory).
 *
 *   PI_SHELL_SESSIONS_DIR=/tmp/s PI_CODING_AGENT_DIR=/tmp/a PI_SHELL_PORT=4755 \
 *     PI_SHELL_OPEN_BROWSER=0 node src/server/index.ts &
 *   node scripts/ui-test-settings-edit.ts http://127.0.0.1:4755/ /tmp/a
 *
 * The agent dir is seeded with a realistic settings.json, the form is driven
 * through the real DOM (selects, inputs, save button), and the result is
 * checked three ways: the API response, the environment payload, and the file
 * on disk (unknown keys preserved, backup written). Never run this against a
 * real agent dir — it writes settings.json.
 *
 * Headless Chrome over CDP, same zero-dependency approach as the other
 * ui-tests. Exits non-zero on the first failed assertion.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? null;
const AGENT_DIR = process.argv[3] ?? null;

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

const SEED = `{
  "theme": "dark",
  "defaultProvider": "deepseek",
  "defaultThinkingLevel": "high",
  "packages": ["git:github.com/earendil-works/pi-review"],
  "compaction": { "enabled": true, "modelOverrides": { "x/y": { "reserveTokens": 999 } } },
  "retry": { "maxRetries": 3, "provider": { "maxRetries": 0 } }
}`;

async function main(baseUrl: string, agentDir: string): Promise<void> {
  await writeFile(join(agentDir, "settings.json"), SEED, "utf8");
  const chromeBin = await findChrome();
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await mkdtemp(join(tmpdir(), "pi-ui-settings-edit-"));
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

    // 1) the agent section renders the seeded values
    await evalJs(`window.piShellDebug.openSettings(); window.piShellDebug.selectSettingsSection("agent")`);
    await sleep(600);
    const initial = (await evalJs(`(() => {
      const controls = [...document.querySelectorAll("[data-setting-key]")];
      return {
        count: controls.length,
        compaction: controls.find((c) => c.dataset.settingKey === "compaction.enabled")?.value,
        retries: controls.find((c) => c.dataset.settingKey === "retry.maxRetries")?.value,
        saveBtn: !!document.getElementById("settings-save"),
      };
    })()`)) as Record<string, unknown>;
    ok(initial.count === 14, `agent form has 14 controls (got ${initial.count})`);
    ok(initial.compaction === "true", `compaction.enabled seeded true (got ${initial.compaction})`);
    ok(initial.retries === "3", `retry.maxRetries seeded 3 (got ${initial.retries})`);
    ok(initial.saveBtn, "save button present");

    // 2) edit, save, and see the optimistic refresh
    await evalJs(`(() => {
      const set = (key, value) => {
        const c = document.querySelector(\`[data-setting-key="\${key}"]\`);
        c.value = value;
      };
      set("compaction.enabled", "false");
      set("retry.maxRetries", "5");
    })()`);
    await evalJs(`document.getElementById("settings-save").click()`);
    await sleep(600);
    const saved = (await evalJs(`(() => {
      const status = document.getElementById("settings-save-status");
      return { text: status?.textContent ?? "", cls: status?.className ?? "", compaction: document.querySelector('[data-setting-key="compaction.enabled"]')?.value };
    })()`)) as Record<string, unknown>;
    ok(String(saved.cls).includes("ok"), `save reported success (${String(saved.text).slice(0, 40)}…)`);
    ok(saved.compaction === "false", "form re-rendered with the new value");

    // 3) unset the default provider on the models page
    await evalJs(`window.piShellDebug.selectSettingsSection("models")`);
    await sleep(300);
    await evalJs(`(() => {
      const c = document.querySelector('[data-setting-key="defaultProvider"]');
      c.value = "";
      document.getElementById("settings-save").click();
    })()`);
    await sleep(600);

    // 4) the environment payload now reports the saved state (fetched from
    // Node: Runtime.evaluate does not await page promises)
    const envPayload = (await (await fetch(`${baseUrl}api/settings/environment`)).json()) as {
      editable: { values: Record<string, unknown> };
    };
    const env = envPayload.editable.values;
    ok(env["defaultProvider"] === null, `defaultProvider unset in payload (got ${env["defaultProvider"]})`);
    ok(
      env["compaction.enabled"] === false && env["retry.maxRetries"] === 5,
      `payload carries the edits (${env["compaction.enabled"]}, ${env["retry.maxRetries"]})`,
    );

    // 5) out-of-range value is rejected with a visible error and nothing written
    const before = await readFile(join(agentDir, "settings.json"), "utf8");
    await evalJs(`window.piShellDebug.selectSettingsSection("agent")`);
    await sleep(300);
    await evalJs(`(() => {
      const c = document.querySelector('[data-setting-key="retry.maxRetries"]');
      c.value = "999";
      document.getElementById("settings-save").click();
    })()`);
    await sleep(600);
    const rejected = (await evalJs(`(() => ({
      cls: document.getElementById("settings-save-status")?.className ?? "",
      text: document.getElementById("settings-save-status")?.textContent ?? "",
    }))()`)) as Record<string, unknown>;
    ok(String(rejected.cls).includes("error"), `out-of-range rejected visibly (${String(rejected.text)})`);
    ok((await readFile(join(agentDir, "settings.json"), "utf8")) === before, "rejected save left the file untouched");

    // 6) the file on disk: edits applied, unknown keys and siblings preserved
    const disk = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    ok(disk["theme"] === "dark", "unknown key theme preserved");
    ok(disk["defaultProvider"] === undefined, "defaultProvider key removed");
    ok(disk["defaultThinkingLevel"] === "high", "defaultThinkingLevel untouched");
    ok(Array.isArray(disk["packages"]), "packages preserved");
    const compaction = disk["compaction"] as Record<string, unknown>;
    ok(compaction["enabled"] === false, "compaction.enabled written");
    ok(
      JSON.stringify(compaction["modelOverrides"]) === JSON.stringify({ "x/y": { reserveTokens: 999 } }),
      "compaction.modelOverrides preserved",
    );
    const retry = disk["retry"] as Record<string, unknown>;
    ok(retry["maxRetries"] === 5, "retry.maxRetries written");
    ok(JSON.stringify(retry["provider"]) === JSON.stringify({ maxRetries: 0 }), "retry.provider preserved");

    // 7) backup holds the pre-edit bytes (seed, from the first save)
    const backup = await readFile(join(agentDir, "settings.json.bak"), "utf8");
    ok(JSON.parse(backup)["theme"] === "dark", "settings.json.bak exists with the pre-save state");

    // 8) no page errors during the whole run
    ok(pageErrors.length === 0, `no page exceptions (got ${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

    cdp.close();
  } finally {
    clearTimeout(hardTimeout);
    child.kill("SIGKILL");
  }

  if (failed) process.exit(1);
}

if (BASE && AGENT_DIR) {
  main(BASE, AGENT_DIR).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
} else {
  // Self-booting: isolated server AND an isolated agent dir — this test writes
  // settings.json, so it must never touch the real ~/.pi/agent.
  const port = 8700 + Math.floor(Math.random() * 200);
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-settings-edit-sessions-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-ui-settings-edit-agent-"));
  const repoRoot = join(import.meta.dirname, "..");
  const server: ChildProcess = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_SHELL_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SHELL_PORT: String(port),
      PI_SHELL_OPEN_BROWSER: "0",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    await main(`http://127.0.0.1:${port}/`, agentDir);
  } finally {
    server.kill("SIGKILL");
    await rm(agentDir, { recursive: true, force: true });
  }
}
