/**
 * Extension UI protocol rules, as pure functions.
 *
 * pi speaks an `extension_ui_request` / `extension_ui_response` subprotocol so
 * that a non-terminal host can answer extension dialogs and mirror their
 * status/widgets. The decisions live here — what clears a status, which answer
 * fields are valid — so they can be unit-tested without spawning pi.
 */

import type { ExtensionUiState } from "../shared/types.ts";

export function emptyExtensionUiState(): ExtensionUiState {
  return { status: [], widgets: [], title: null };
}

/**
 * Fold one fire-and-forget request into the cached state.
 *
 * `setStatus` / `setWidget` with their payload omitted retract that key, which
 * is how an extension cleans up after itself. Actions (`set_editor_text`) and
 * one-shot notifications carry no persistent state and are ignored here.
 */
export function applyExtensionUiState(state: ExtensionUiState, event: Record<string, unknown>): void {
  switch (event["method"]) {
    case "setStatus": {
      const key = stringOrNull(event["statusKey"]);
      if (!key) return;
      const text = stringOrNull(event["statusText"]);
      const index = state.status.findIndex((entry) => entry.key === key);
      if (text === null) {
        if (index >= 0) state.status.splice(index, 1);
        return;
      }
      if (index >= 0) state.status[index] = { key, text };
      else state.status.push({ key, text });
      return;
    }
    case "setWidget": {
      const key = stringOrNull(event["widgetKey"]);
      if (!key) return;
      const lines = stringArray(event["widgetLines"]);
      const index = state.widgets.findIndex((entry) => entry.key === key);
      if (lines === null) {
        if (index >= 0) state.widgets.splice(index, 1);
        return;
      }
      const placement = event["widgetPlacement"] === "belowEditor" ? "belowEditor" : "aboveEditor";
      const widget = { key, lines, placement } as const;
      if (index >= 0) state.widgets[index] = widget;
      else state.widgets.push(widget);
      return;
    }
    case "setTitle": {
      state.title = stringOrNull(event["title"]);
      return;
    }
    default:
      return;
  }
}

export type UiResponseResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Shape the browser's answer into pi's `extension_ui_response`.
 *
 * `cancelled` wins over a value, so a dialog can never be both answered and
 * dismissed. A `confirm` answer is a boolean; `select` / `input` / `editor`
 * answers are strings. Anything else is rejected rather than guessed at.
 */
export function buildUiResponse(input: Record<string, unknown>): UiResponseResult {
  const id = stringOrNull(input["id"]);
  if (!id) return { ok: false, error: "id is required" };

  if (input["cancelled"] === true) {
    return { ok: true, record: { type: "extension_ui_response", id, cancelled: true } };
  }
  if (typeof input["confirmed"] === "boolean") {
    return { ok: true, record: { type: "extension_ui_response", id, confirmed: input["confirmed"] } };
  }
  if (typeof input["value"] === "string") {
    return { ok: true, record: { type: "extension_ui_response", id, value: input["value"] } };
  }
  return { ok: false, error: "one of value, confirmed, or cancelled is required" };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value === "" ? null : value;
}

/** `null` means "retract the key"; a non-array is treated as omitted. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((line) => (typeof line === "string" ? line : String(line ?? "")));
}
