import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PiRpcSession, type PiEvent } from "../src/server/piSession.ts";

const PI_SESSION_TS = fileURLToPath(new URL("../src/server/piSession.ts", import.meta.url));

describe("PiRpcSession", () => {
  it("rejects in-flight requests when the child exits", async () => {
    const session = new PiRpcSession({
      bin: "/bin/sh",
      extraArgs: ["-c", "exit 0"], // ignores the RPC flags and goes away
      sessionPath: null,
      cwd: process.cwd(),
    });
    await session.start();
    await assert.rejects(() => session.send({ type: "get_state" }, 5_000), /exited/);
    await session.stop();
  });

  it("replays events that arrived before the first listener attached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rpc-startup-"));
    const fixture = join(dir, "startup.ts");
    await writeFile(
      fixture,
      `const event = { type: "extension_ui_request", method: "setStatus", statusKey: "x", statusText: "y" };\nprocess.stdout.write(JSON.stringify(event) + "\\n");\nprocess.stdin.on("end", () => process.exit(0));\n`,
    );

    try {
      const session = new PiRpcSession({
        bin: process.execPath,
        extraArgs: [fixture],
        sessionPath: null,
        cwd: process.cwd(),
      });
      await session.start();
      // Nobody is listening yet: this is exactly the `session_start` window the
      // registry used to miss, losing an extension's first widget/status.
      await new Promise((r) => setTimeout(r, 300));

      const events: PiEvent[] = [];
      session.onEvent((event) => events.push(event));
      assert.equal(events.length, 1);
      assert.equal(events[0]?.["method"], "setStatus");
      assert.equal(events[0]?.["statusText"], "y");

      // Only the first subscriber gets the replay; a later one sees nothing.
      const second: PiEvent[] = [];
      session.onEvent((event) => second.push(event));
      assert.equal(second.length, 0);

      await session.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes an extension UI response to the child's stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rpc-ui-"));
    const fixture = join(dir, "capture.ts");
    const outPath = join(dir, "stdin.jsonl");
    await writeFile(
      fixture,
      `import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buffer += chunk; });
process.stdin.on("end", () => writeFileSync(process.argv[2], buffer));
`,
    );

    try {
      const session = new PiRpcSession({
        bin: process.execPath,
        extraArgs: [fixture, outPath],
        sessionPath: null,
        cwd: process.cwd(),
      });
      await session.start();
      session.respond({ type: "extension_ui_response", id: "ui-1", value: "hello" });
      await session.stop();

      const written = await readFile(outPath, "utf8");
      assert.deepEqual(JSON.parse(written), {
        type: "extension_ui_response",
        id: "ui-1",
        value: "hello",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Regression for the P2 finding: writing to a child that closed its stdin
   * produced EPIPE on `stdin`. With no `error` listener that is an unhandled
   * 'error' event, which killed the whole server — every open session with it.
   *
   * Asserted in a child process on purpose: the property under test is "the
   * process survives", so a broken build has to fail as an exit code rather
   * than take the test runner down with it.
   */
  it("survives an EPIPE from a child whose stdin is closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-rpc-"));
    const fixture = join(dir, "epipe.ts");
    const blob = "x".repeat(256 * 1024);
    await writeFile(
      fixture,
      `import { PiRpcSession } from ${JSON.stringify(PI_SESSION_TS)};
const session = new PiRpcSession({
  bin: "/bin/sh",
  extraArgs: ["-c", "exec 0<&-; sleep 5"],
  sessionPath: null,
  cwd: process.cwd(),
});
await session.start();
await new Promise((r) => setTimeout(r, 150));
for (let i = 0; i < 3; i += 1) {
  await session.send({ type: "ping", blob: ${JSON.stringify(blob)} }, 200).catch(() => undefined);
}
await new Promise((r) => setTimeout(r, 400));
console.log("survived");
await session.stop();
`,
    );

    try {
      const result = await run(process.execPath, [fixture], dir);
      assert.equal(result.code, 0, `fixture died: ${result.stderr}`);
      assert.match(result.stdout, /survived/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Run a command and collect its output. */
function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
