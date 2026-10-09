import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { continuesList, findStableEnd } from "../src/web/liveMarkdown.js";

describe("findStableEnd", () => {
  it("commits up to the last blank line", () => {
    assert.deepEqual(findStableEnd("a\n\nb"), { end: 3, inFence: false });
    assert.deepEqual(findStableEnd("a\n\n\nb"), { end: 4, inFence: false });
    assert.deepEqual(findStableEnd("no blank line yet"), { end: 0, inFence: false });
  });

  it("commits at a closing fence, blank line or not", () => {
    const text = "```\na\n```\nafter";
    assert.equal(findStableEnd(text).end, text.indexOf("after"));
    assert.equal(findStableEnd(text).inFence, false);
  });

  it("holds back an unclosed fence, blank lines and all", () => {
    const text = "before\n\n```\ncode\n\nstill code\n";
    const { end, inFence } = findStableEnd(text);
    assert.equal(inFence, true);
    assert.equal(text.slice(0, end), "before\n\n");
  });

  it("returns the last boundary at or after the given offset", () => {
    const text = "a\n\nb\n\nc\n";
    assert.equal(text.slice(0, findStableEnd(text, 0).end), "a\n\nb\n\n");
    // Resuming from a previous boundary sees the same text, just less to scan.
    const grown = "a\n\nb\n\nc\n\nd\n";
    assert.equal(grown.slice(0, findStableEnd(grown, 0).end), "a\n\nb\n\nc\n\n");
    assert.equal(grown.slice(0, findStableEnd(grown, 6).end), "a\n\nb\n\nc\n\n");
  });

  it("does not treat an indented fence as a code fence", () => {
    const text = "    ```\n    still text\n\n";
    assert.equal(findStableEnd(text).end, text.length);
  });

  it("keeps tilde fences separate from backtick fences", () => {
    const text = "~~~\ncode\n```\nnot the close\n~~~\n\ntail";
    const { end, inFence } = findStableEnd(text);
    assert.equal(inFence, false);
    assert.equal(text.slice(0, end).endsWith("~~~\n\n"), true);
  });
});

describe("continuesList", () => {
  it("joins two items of a loose list", () => {
    assert.equal(continuesList("- a\n\n", "- b\n\n"), true);
    assert.equal(continuesList("1. a\n\n", "2. b\n\n"), true);
  });

  it("joins an indented continuation paragraph", () => {
    assert.equal(continuesList("- a\n\n", "  more of the item\n"), true);
  });

  it("does not join unrelated blocks", () => {
    assert.equal(continuesList("- a\n\n", "a plain paragraph\n"), false);
    assert.equal(continuesList("a plain paragraph\n\n", "- b\n\n"), false);
  });
});
