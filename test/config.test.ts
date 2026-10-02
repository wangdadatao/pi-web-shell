import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/server/config.ts";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

describe("loadConfig sessions directory", () => {
  it("defaults to pi's own sessions dir and does not pass --session-dir", () => {
    const config = loadConfig({});
    assert.equal(config.sessionsDir, DEFAULT_SESSIONS_DIR);
    assert.equal(config.sessionDirArg, null);
  });

  it("follows PI_CODING_AGENT_DIR and still leaves the flag off", () => {
    const config = loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" });
    assert.equal(config.sessionsDir, join("/tmp/pi-agent", "sessions"));
    assert.equal(config.sessionDirArg, null);
  });

  it("indexes PI_CODING_AGENT_SESSION_DIR but lets pi resolve it itself", () => {
    const custom = "/tmp/pi-agent/sessions";
    const config = loadConfig({ PI_CODING_AGENT_SESSION_DIR: custom });
    assert.equal(config.sessionsDir, custom);
    // The child inherits the env var, so passing the flag would be redundant
    // (and would force pi's flat layout).
    assert.equal(config.sessionDirArg, null);
  });

  it("pins the child with --session-dir for a web-only override", () => {
    const custom = "/tmp/pi-shell/sessions";
    const config = loadConfig({ PI_SHELL_SESSIONS_DIR: custom });
    assert.equal(config.sessionsDir, custom);
    assert.equal(config.sessionDirArg, custom);
  });

  it("lets PI_SHELL_SESSIONS_DIR win over PI_CODING_AGENT_SESSION_DIR", () => {
    const config = loadConfig({
      PI_SHELL_SESSIONS_DIR: "/tmp/shell-sessions",
      PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
    });
    assert.equal(config.sessionsDir, "/tmp/shell-sessions");
    assert.equal(config.sessionDirArg, "/tmp/shell-sessions");
  });

  it("does not pass the flag when the override matches pi's own dir", () => {
    const config = loadConfig({ PI_SHELL_SESSIONS_DIR: DEFAULT_SESSIONS_DIR });
    assert.equal(config.sessionsDir, DEFAULT_SESSIONS_DIR);
    assert.equal(config.sessionDirArg, null);

    // Same path, written differently (trailing slash), still no flag.
    const trailing = loadConfig({ PI_SHELL_SESSIONS_DIR: `${DEFAULT_SESSIONS_DIR}/` });
    assert.equal(trailing.sessionDirArg, null);
    assert.equal(resolve(trailing.sessionsDir), resolve(DEFAULT_SESSIONS_DIR));
  });
});
