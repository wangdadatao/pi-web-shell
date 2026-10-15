import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_SECURITY_POLICY,
  isJsonContentType,
  isOriginAllowed,
  presentedToken,
  queryTokenAllowed,
  tokenMatches,
} from "../src/server/requestGuard.ts";

const HOST = "127.0.0.1:4711";

describe("isOriginAllowed", () => {
  it("accepts the page itself and a navigation with no origin", () => {
    assert.equal(isOriginAllowed({ origin: `http://${HOST}`, "sec-fetch-site": "same-origin" }, HOST), true);
    assert.equal(isOriginAllowed({ "sec-fetch-site": "same-origin" }, HOST), true);
    assert.equal(isOriginAllowed({ "sec-fetch-site": "none" }, HOST), true);
    assert.equal(isOriginAllowed({}, HOST), true);
  });

  it("rejects cross-site, same-site, and a mismatched origin", () => {
    assert.equal(isOriginAllowed({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, HOST), false);
    assert.equal(isOriginAllowed({ "sec-fetch-site": "cross-site" }, HOST), false);
    assert.equal(isOriginAllowed({ origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" }, HOST), false);
    assert.equal(isOriginAllowed({ origin: "https://evil.example" }, HOST), false);
    assert.equal(isOriginAllowed({ origin: "null" }, HOST), false);
    assert.equal(isOriginAllowed({}, undefined), false);
  });
});

describe("token presentation", () => {
  it("accepts the header everywhere and the query only on SSE and image GETs", () => {
    const url = new URL("http://127.0.0.1/api/stream?token=from-query");
    assert.equal(presentedToken({ "x-pi-shell-token": "from-header" }, url, true), "from-header");
    assert.equal(presentedToken({}, url, true), "from-query");
    assert.equal(presentedToken({}, url, false), null);
    assert.equal(queryTokenAllowed("GET", "/api/stream"), true);
    assert.equal(queryTokenAllowed("GET", "/api/events"), true);
    assert.equal(queryTokenAllowed("GET", "/api/local-image"), true);
    assert.equal(queryTokenAllowed("GET", "/api/image/abc"), true);
    assert.equal(queryTokenAllowed("POST", "/api/stream"), false);
    assert.equal(queryTokenAllowed("GET", "/api/sessions"), false);
    assert.equal(queryTokenAllowed("POST", "/api/prompt"), false);
  });

  it("compares in a way that rejects missing and mismatched values", () => {
    assert.equal(tokenMatches("secret", "secret"), true);
    assert.equal(tokenMatches("secret", "other"), false);
    assert.equal(tokenMatches(null, "secret"), false);
    assert.equal(tokenMatches("", "secret"), false);
    assert.equal(tokenMatches("secret", ""), false);
  });
});

describe("write content type", () => {
  it("accepts application/json with an optional parameter", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
    assert.equal(isJsonContentType("text/plain"), false);
    assert.equal(isJsonContentType("application/x-www-form-urlencoded"), false);
    assert.equal(isJsonContentType(undefined), false);
  });
});

describe("content security policy", () => {
  it("allows same-origin scripts and disallows inline scripts", () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split(";").find((part) => part.trim().startsWith("script-src"));
    assert.ok(scriptSrc);
    assert.match(scriptSrc, /'self'/);
    assert.doesNotMatch(scriptSrc, /unsafe-inline/);
    assert.doesNotMatch(scriptSrc, /unsafe-eval/);
  });
});
