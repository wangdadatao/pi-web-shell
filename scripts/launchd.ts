/**
 * Install pi-web-shell as a macOS LaunchAgent so it survives logout and reboot.
 *
 *   npm run service:install
 *   npm run service:status
 *   npm run service:restart
 *   npm run service:uninstall
 *
 * The agent runs `scripts/launchd-run.sh` under `RunAtLoad` + `KeepAlive`, with
 * PI_SHELL_OPEN_BROWSER=0 so logging in never pops a browser window.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const LABEL = process.env["PI_SHELL_LAUNCHD_LABEL"] ?? "dev.pi-web-shell";
const UID = process.getuid?.() ?? 501;
const DOMAIN = `gui/${UID}`;
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs", "pi-web-shell");
const RUNNER = join(PROJECT_DIR, "scripts", "launchd-run.sh");

function readPort(): number {
  const fromEnv = process.env["PI_SHELL_PORT"];
  if (fromEnv && fromEnv.trim() !== "") return Number.parseInt(fromEnv, 10);
  const envFile = join(PROJECT_DIR, ".env");
  if (existsSync(envFile)) {
    const match = /^\s*PI_SHELL_PORT\s*=\s*(\d+)\s*$/m.exec(readFileSync(envFile, "utf8"));
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return 4711;
}

const PORT = readPort();
const APP_URL = `http://127.0.0.1:${PORT}/`;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>${xmlEscape(RUNNER)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(PROJECT_DIR)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(LOG_DIR, "stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(LOG_DIR, "stderr.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${xmlEscape(homedir())}</string>
        <key>PI_SHELL_OPEN_BROWSER</key>
        <string>0</string>
    </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[], ignoreFailure = false): string {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (ignoreFailure) return "";
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr.trim() || String(error)}`);
  }
}

function isLoaded(): boolean {
  return launchctl(["print", `${DOMAIN}/${LABEL}`], true).includes(`gui/${UID}/${LABEL}`);
}

/** Stop a manually started server so it cannot hold the port. */
function freePort(): void {
  let pids: string[] = [];
  try {
    pids = execFileSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return; // nothing listening
  }
  for (const pid of pids) {
    let command = "";
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
    } catch {
      continue;
    }
    if (command.includes(PROJECT_DIR)) {
      process.stdout.write(`  stopping manually started server (pid ${pid})\n`);
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    } else {
      process.stdout.write(`  port ${PORT} is held by an unrelated process (pid ${pid}), leaving it alone\n`);
    }
  }
}

async function waitForHealth(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(APP_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function install(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent install is macOS-only");
  }
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  chmodSync(RUNNER, 0o755);

  writeFileSync(PLIST_PATH, renderPlist(), "utf8");
  process.stdout.write(`wrote ${PLIST_PATH}\n`);

  if (isLoaded()) {
    process.stdout.write("  agent already loaded, reloading\n");
    launchctl(["bootout", `${DOMAIN}/${LABEL}`], true);
  }

  freePort();

  launchctl(["bootstrap", DOMAIN, PLIST_PATH]);
  process.stdout.write(`  bootstrapped ${DOMAIN}/${LABEL}\n`);

  const healthy = await waitForHealth();
  if (healthy) {
    process.stdout.write(`\n  ✅ running → ${APP_URL}\n`);
    process.stdout.write(`  logs: ${join(LOG_DIR, "stderr.log")}\n`);
    process.stdout.write("  it will start automatically at login and restart if it crashes\n");
    process.stdout.write("  (browser auto-open is off for the service; open the URL yourself)\n");
  } else {
    process.stdout.write(`\n  ⚠️  agent loaded but ${APP_URL} is not answering yet.\n`);
    process.stdout.write(`  check: launchctl print ${DOMAIN}/${LABEL}\n`);
    process.stdout.write(`  logs:  ${join(LOG_DIR, "stderr.log")}\n`);
  }
}

function uninstall(): void {
  if (existsSync(PLIST_PATH)) {
    launchctl(["bootout", `${DOMAIN}/${LABEL}`], true);
    rmSync(PLIST_PATH);
    process.stdout.write(`removed ${PLIST_PATH}\n`);
  } else {
    process.stdout.write("agent is not installed\n");
  }
}

function status(): void {
  if (!existsSync(PLIST_PATH)) {
    process.stdout.write(`${LABEL} is not installed\n`);
    return;
  }
  const output = launchctl(["print", `${DOMAIN}/${LABEL}`], true);
  if (output === "") {
    process.stdout.write(`${LABEL} is installed but not loaded\n`);
    return;
  }
  const state = /state = ([^\n]+)/.exec(output)?.[1] ?? "unknown";
  const pid = /pid = (\d+)/.exec(output)?.[1] ?? "-";
  process.stdout.write(`${LABEL}\n`);
  process.stdout.write(`  plist: ${PLIST_PATH}\n`);
  process.stdout.write(`  state: ${state}   pid: ${pid}\n`);
  process.stdout.write(`  url:   ${APP_URL}\n`);
  process.stdout.write(`  logs:  ${join(LOG_DIR, "stderr.log")}\n`);
}

function restart(): void {
  if (!existsSync(PLIST_PATH)) throw new Error("agent is not installed; run npm run service:install");
  launchctl(["kickstart", "-k", `${DOMAIN}/${LABEL}`]);
  process.stdout.write(`restarted ${LABEL}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  switch (command) {
    case "install":
      await install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "restart":
      restart();
      break;
    case "status":
      status();
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.stderr.write("usage: launchd.ts [install|uninstall|status|restart]\n");
      process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
