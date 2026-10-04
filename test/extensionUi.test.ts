import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyExtensionUiState,
  buildUiResponse,
  emptyExtensionUiState,
} from "../src/server/extensionUi.ts";

describe("buildUiResponse", () => {
  it("requires an id", () => {
    const result = buildUiResponse({ value: "x" });
    assert.equal(result.ok, false);
  });

  it("shapes a select/input/editor answer", () => {
    const result = buildUiResponse({ id: "abc", value: "" });
    assert.deepEqual(result, {
      ok: true,
      record: { type: "extension_ui_response", id: "abc", value: "" },
    });
  });

  it("shapes a confirm answer as a boolean", () => {
    assert.deepEqual(buildUiResponse({ id: "abc", confirmed: false }), {
      ok: true,
      record: { type: "extension_ui_response", id: "abc", confirmed: false },
    });
  });

  it("prefers cancellation over a value", () => {
    assert.deepEqual(buildUiResponse({ id: "abc", value: "x", cancelled: true }), {
      ok: true,
      record: { type: "extension_ui_response", id: "abc", cancelled: true },
    });
  });

  it("rejects an answer with no value at all", () => {
    assert.equal(buildUiResponse({ id: "abc" }).ok, false);
  });
});

describe("applyExtensionUiState", () => {
  it("adds, updates, and retracts a status key", () => {
    const state = emptyExtensionUiState();
    applyExtensionUiState(state, { method: "setStatus", statusKey: "a", statusText: "one" });
    applyExtensionUiState(state, { method: "setStatus", statusKey: "b", statusText: "two" });
    applyExtensionUiState(state, { method: "setStatus", statusKey: "a", statusText: "again" });
    assert.deepEqual(state.status, [
      { key: "a", text: "again" },
      { key: "b", text: "two" },
    ]);

    applyExtensionUiState(state, { method: "setStatus", statusKey: "a" });
    assert.deepEqual(state.status, [{ key: "b", text: "two" }]);
  });

  it("keeps widget placement and retracts on an omitted payload", () => {
    const state = emptyExtensionUiState();
    applyExtensionUiState(state, { method: "setWidget", widgetKey: "w", widgetLines: ["a", "b"] });
    assert.deepEqual(state.widgets, [{ key: "w", lines: ["a", "b"], placement: "aboveEditor" }]);

    applyExtensionUiState(state, {
      method: "setWidget",
      widgetKey: "w",
      widgetLines: ["x"],
      widgetPlacement: "belowEditor",
    });
    assert.deepEqual(state.widgets, [{ key: "w", lines: ["x"], placement: "belowEditor" }]);

    applyExtensionUiState(state, { method: "setWidget", widgetKey: "w" });
    assert.deepEqual(state.widgets, []);
  });

  it("sets and clears the title", () => {
    const state = emptyExtensionUiState();
    applyExtensionUiState(state, { method: "setTitle", title: "reviewing" });
    assert.equal(state.title, "reviewing");
    applyExtensionUiState(state, { method: "setTitle" });
    assert.equal(state.title, null);
  });

  it("ignores methods that carry no persistent state", () => {
    const state = emptyExtensionUiState();
    applyExtensionUiState(state, { method: "notify", message: "hi" });
    applyExtensionUiState(state, { method: "set_editor_text", text: "hi" });
    assert.deepEqual(state, { status: [], widgets: [], title: null });
  });
});
