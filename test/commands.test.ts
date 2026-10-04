import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCommands } from "../src/server/commands.ts";

describe("normalizeCommands", () => {
  it("keeps name, description, and source", () => {
    assert.deepEqual(
      normalizeCommands([
        { name: "review", description: "Review changes", source: "extension" },
        { name: "skill:humanizer", description: "Rewrite prose", source: "skill" },
      ]),
      [
        { name: "review", description: "Review changes", source: "extension" },
        { name: "skill:humanizer", description: "Rewrite prose", source: "skill" },
      ],
    );
  });

  it("returns an empty list for a malformed payload", () => {
    assert.deepEqual(normalizeCommands(undefined), []);
    assert.deepEqual(normalizeCommands({}), []);
    assert.deepEqual(normalizeCommands([null, 42, "x", {}]), []);
  });

  it("drops entries with no usable name and de-duplicates by name", () => {
    assert.deepEqual(
      normalizeCommands([
        { name: "  " },
        { name: "dup" },
        { name: "dup", description: "second" },
        { name: "keep" },
      ]),
      [
        { name: "dup", description: "", source: "" },
        { name: "keep", description: "", source: "" },
      ],
    );
  });
});
