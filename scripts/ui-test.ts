/**
 * One-command regression: `npm run ui:test`.
 *
 * Runs typecheck → unit tests → every scripts/ui-test-*.ts in order, against
 * a single isolated server (own temp sessions dir, random port, browser
 * suppressed). The UI scripts never prompt a real pi subprocess — they stub
 * the API in the page or feed synthetic events — so the whole suite is offline
 * and safe to run any time.
 *
 * Convention: a ui-test script that receives a base URL as argv[2] must use
 * it instead of booting its own server, so this runner can share one. Scripts
 * invoked bare keep their self-booting behaviour for standalone use.
 *
 * Zero dependencies, like everything in scripts/: Node's own fetch and
 * child_process. Exits non-zero if any step fails; every step always runs so
 * one broken area does not hide another.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one step to completion, streaming its output. False = it failed. */
function run(label: string, command: string, args: string[]): Promise<boolean> {
  console.log(`\n━━━ ${label} ` + "─".repeat(Math.max(1, 52 - label.length)));
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", (error) => {
      process.stderr.write(`${label}: ${error.message}\n`);
      resolve(false);
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function waitForHttp(url: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  return false;
}

/**
 * Parse the URL out of the server's startup banner.
 *
 * The banner prints the actually-bound address (see `src/server/index.ts`),
 * which is the only trustworthy source when the port was left to the OS.
 */
function readServerUrl(child: ChildProcess, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("server did not print its URL in time")), timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = /→\s+(http:\/\/\S+)/.exec(buffer);
      const url = match?.[1];
      if (url) done(() => resolve(url));
    });
    child.on("exit", (code) => done(() => reject(new Error(`server exited before printing its URL (code ${code})`))));
  });
}

async function main(): Promise<void> {
  const failed: string[] = [];
  const step = async (label: string, command: string, args: string[]): Promise<void> => {
    if (await run(label, command, args)) return;
    failed.push(label);
  };

  // 1) typecheck — cheapest gate first; a red tree fails everything after it.
  await step("typecheck", process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "--noEmit"]);

  // 2) unit tests (the same set `npm test` runs, expanded without a shell).
  const testDir = join(repoRoot, "test");
  const unitTests = (await readdir(testDir))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(testDir, name));
  if (unitTests.length > 0) {
    await step("unit tests", process.execPath, ["--test", ...unitTests]);
  }

  // 3) every UI assertion script, sharing one isolated server.
  const scriptsDir = join(repoRoot, "scripts");
  const uiTests = (await readdir(scriptsDir))
    .filter((name) => /^ui-test-.+\.ts$/.test(name))
    .sort()
    .map((name) => join(scriptsDir, name));
  if (uiTests.length === 0) {
    process.stderr.write("no ui-test-*.ts scripts found\n");
    process.exit(1);
  }

  // Port 0: the OS hands out a port that nothing else can be holding, so the
  // suite can never accidentally talk to some unrelated local service that
  // happens to squat on a fixed port. The real port is parsed from the
  // server's own startup banner below.
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-ui-test-sessions-"));
  // An isolated agent dir too: ui tests must never read, let alone write, the
  // real ~/.pi/agent (the settings-edit test writes settings.json).
  const agentDir = await mkdtemp(join(tmpdir(), "pi-ui-test-agent-"));
  const server: ChildProcess = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_SHELL_SESSIONS_DIR: sessionsDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SHELL_PORT: "0",
      PI_SHELL_OPEN_BROWSER: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const base = await readServerUrl(server).catch((error: Error) => {
      process.stderr.write(`${error.message}\n`);
      return null;
    });
    if (!base || !(await waitForHttp(base))) {
      failed.push("server boot");
      process.stderr.write(`server did not come up${base ? ` at ${base}` : ""}\n`);
    } else {
      console.log(`\n━━━ ui tests ` + "─".repeat(44));
      console.log(`isolated server: ${base} (${sessionsDir})`);
      for (const script of uiTests) {
        const label = script.slice(script.lastIndexOf("/") + 1);
        // The settings-edit test writes settings.json, so it gets the isolated
        // agent dir as a second argument (base URL first, like every script).
        const args = label === "ui-test-settings-edit.ts" ? [script, base, agentDir] : [script, base];
        // One failing script must not stop the others: each runs to completion.
        if (await run(label, process.execPath, args)) continue;
        failed.push(label);
      }
    }
  } finally {
    server.kill("SIGKILL");
  }

  console.log(`\n${failed.length === 0 ? "✅ all green" : "❌ failed: " + failed.join(", ")}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
