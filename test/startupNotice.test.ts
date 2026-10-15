import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStartupBanner, nonLoopbackWarning, tokenizedUrl } from "../src/server/startupNotice.ts";

const TOKEN = "c".repeat(43);

describe("startup banner", () => {
  it("prints the tokenized URL for an interactive terminal", () => {
    const banner = formatStartupBanner({
      host: "127.0.0.1",
      port: 4711,
      sessionsDir: "/tmp/sessions",
      piBin: "pi",
      authToken: TOKEN,
      tokenPath: "/tmp/agent/web-shell-token",
      revealToken: true,
    });
    assert.match(banner, /pi-web-shell running/);
    assert.ok(banner.includes(tokenizedUrl("127.0.0.1", 4711, TOKEN)));
    assert.equal(nonLoopbackWarning("127.0.0.1"), null);
    assert.equal(nonLoopbackWarning("localhost"), null);
    assert.equal(nonLoopbackWarning("::1"), null);
  });

  it("omits the token when stdout would be a log or a pipe", () => {
    const banner = formatStartupBanner({
      host: "127.0.0.1",
      port: 4711,
      sessionsDir: "/tmp/sessions",
      piBin: "pi",
      authToken: TOKEN,
      tokenPath: "/tmp/agent/web-shell-token",
      revealToken: false,
    });
    assert.match(banner, /→ http:\/\/127\.0\.0\.1:4711\/\n/);
    assert.equal(banner.includes(TOKEN), false);
    assert.match(banner, /web-shell-token/);
    assert.match(banner, /not written to logs/);
  });

  it("warns that a non-loopback bind is plaintext HTTP", () => {
    for (const host of ["0.0.0.0", "192.168.1.20"]) {
      const warning = nonLoopbackWarning(host);
      assert.ok(warning);
      assert.match(warning, /WARNING/);
      assert.match(warning, /plaintext HTTP/);
      assert.match(warning, /LAN/);
      assert.equal(warning.includes(TOKEN), false);
    }
  });

  it("does not write the token to a piped server stdout", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-banner-agent-"));
    const sessionsDir = await mkdtemp(join(tmpdir(), "pi-banner-sessions-"));
    const repoRoot = join(import.meta.dirname, "..");
    const child = spawn(process.execPath, ["src/server/index.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SHELL_SESSIONS_DIR: sessionsDir,
        PI_SHELL_PORT: "0",
        PI_SHELL_HOST: "127.0.0.1",
        PI_SHELL_OPEN_BROWSER: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`banner timeout\n${stdout}\n${stderr}`));
        }, 8000);
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        child.stdout?.on("data", () => {
          if (!stdout.includes("pi-web-shell running")) return;
          finish(resolve);
        });
        child.on("exit", (code) => {
          finish(() => reject(new Error(`server exited ${code} before the banner\n${stdout}\n${stderr}`)));
        });
      });
      const token = (await readFile(join(agentDir, "web-shell-token"), "utf8")).trim();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(stdout.includes(token), false);
      assert.match(stdout, /→ http:\/\/127\.0\.0\.1:\d+\/\n/);
      assert.equal(stderr.includes("WARNING"), false);
    } finally {
      child.kill("SIGKILL");
      await rm(agentDir, { recursive: true, force: true });
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
});
