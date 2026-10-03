import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isHostAllowed } from "../src/server/hostCheck.ts";

describe("isHostAllowed (loopback bind)", () => {
  const bind = "127.0.0.1";

  it("allows plain loopback hosts", () => {
    assert.equal(isHostAllowed("127.0.0.1", bind), true);
    assert.equal(isHostAllowed("127.0.0.1:4711", bind), true);
    assert.equal(isHostAllowed("localhost", bind), true);
    assert.equal(isHostAllowed("localhost:4711", bind), true);
    assert.equal(isHostAllowed("LOCALHOST:4711", bind), true);
  });

  it("allows IPv6 loopback with and without brackets/port", () => {
    assert.equal(isHostAllowed("[::1]", bind), true);
    assert.equal(isHostAllowed("[::1]:4711", bind), true);
  });

  it("rejects foreign domains (DNS rebinding payload)", () => {
    assert.equal(isHostAllowed("evil.com", bind), false);
    assert.equal(isHostAllowed("evil.com:4711", bind), false);
  });

  it("rejects loopback-looking suffixes, not just prefixes", () => {
    assert.equal(isHostAllowed("127.0.0.1.evil.com", bind), false);
    assert.equal(isHostAllowed("localhost.evil.com", bind), false);
  });

  it("rejects missing or empty Host", () => {
    assert.equal(isHostAllowed(undefined, bind), false);
    assert.equal(isHostAllowed("", bind), false);
  });

  it("rejects other local-ish names that are not loopback", () => {
    assert.equal(isHostAllowed("192.168.1.5:4711", bind), false);
  });
});

describe("isHostAllowed (non-loopback bind = explicit opt-out)", () => {
  it("skips validation entirely", () => {
    assert.equal(isHostAllowed("192.168.1.5:4711", "0.0.0.0"), true);
    assert.equal(isHostAllowed("evil.com", "0.0.0.0"), true);
    assert.equal(isHostAllowed(undefined, "0.0.0.0"), true);
  });
});
