import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EDITABLE_KEYS,
  SettingsValidationError,
  applySettingsPatch,
  editableValuesOf,
} from "../src/server/settingsStore.ts";

/**
 * The store is the only writer of the user's real settings.json, so the tests
 * pin its contract: whitelist enforcement, validation, sibling/unknown-key
 * preservation, backup, and atomic replace. All against temp agent dirs.
 */

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function agentDir(name: string, initial?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pi-settings-${name}-`));
  roots.push(dir);
  if (initial !== undefined) await writeFile(join(dir, "settings.json"), initial, "utf8");
  return dir;
}

const REAL_WORLD = `{
  "theme": "dark",
  "defaultProvider": "deepseek",
  "defaultThinkingLevel": "high",
  "packages": ["git:github.com/earendil-works/pi-review"],
  "compaction": { "enabled": true, "modelOverrides": { "x/y": { "reserveTokens": 999 } } },
  "retry": { "maxRetries": 3, "provider": { "maxRetries": 0 } }
}`;

describe("editableValuesOf", () => {
  it("maps whitelist keys to current values, null when unset", () => {
    const settings = JSON.parse(REAL_WORLD) as Record<string, unknown>;
    const values = editableValuesOf(settings);
    assert.equal(values["defaultProvider"], "deepseek");
    assert.equal(values["compaction.enabled"], true);
    assert.equal(values["retry.maxRetries"], 3);
    assert.equal(values["defaultModel"], null);
    assert.equal(values["images.autoResize"], null);
    assert.equal(Object.keys(values).length, Object.keys(EDITABLE_KEYS).length);
  });

  it("tolerates null input (no settings.json at all)", () => {
    const values = editableValuesOf(null);
    assert.equal(Object.keys(values).length, Object.keys(EDITABLE_KEYS).length);
    for (const value of Object.values(values)) assert.equal(value, null);
  });
});

describe("applySettingsPatch", () => {
  it("writes nested keys and preserves unknown keys and nested siblings", async () => {
    const dir = await agentDir("merge", REAL_WORLD);
    const result = await applySettingsPatch(dir, {
      "compaction.enabled": false,
      "retry.maxRetries": 5,
    });
    assert.equal(result.values["compaction.enabled"], false);
    assert.equal(result.values["retry.maxRetries"], 5);

    const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    // Unknown top-level keys survive byte-for-byte in spirit.
    assert.equal(saved["theme"], "dark");
    assert.deepEqual(saved["packages"], ["git:github.com/earendil-works/pi-review"]);
    // Nested siblings the page never mentions survive too.
    const compaction = saved["compaction"] as Record<string, unknown>;
    assert.deepEqual(compaction["modelOverrides"], { "x/y": { reserveTokens: 999 } });
    const retry = saved["retry"] as Record<string, unknown>;
    assert.deepEqual(retry["provider"], { maxRetries: 0 });
    assert.equal(retry["maxRetries"], 5);
  });

  it("backs up the previous file, overwriting an older backup", async () => {
    const dir = await agentDir("backup", REAL_WORLD);
    await applySettingsPatch(dir, { "retry.maxRetries": 4 });
    await applySettingsPatch(dir, { "retry.maxRetries": 6 });

    const backup = await readFile(join(dir, "settings.json.bak"), "utf8");
    const parsed = JSON.parse(backup) as Record<string, unknown>;
    // The backup holds the state before the *second* save.
    assert.equal((parsed["retry"] as Record<string, unknown>)["maxRetries"], 4);
  });

  it("creates the file (and no backup) when none existed", async () => {
    const dir = await agentDir("fresh");
    const result = await applySettingsPatch(dir, { "compaction.reserveTokens": 12345 });
    assert.equal(result.backup, null);
    const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal((saved["compaction"] as Record<string, unknown>)["reserveTokens"], 12345);
  });

  it("null and empty string remove keys (pi falls back to built-ins)", async () => {
    const dir = await agentDir("remove", REAL_WORLD);
    const result = await applySettingsPatch(dir, {
      defaultProvider: null,
      defaultThinkingLevel: "",
      "retry.maxRetries": null,
    });
    assert.equal(result.values["defaultProvider"], null);
    assert.equal(result.values["defaultThinkingLevel"], null);

    const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("defaultProvider" in saved, false);
    assert.equal("defaultThinkingLevel" in saved, false);
    assert.equal("maxRetries" in (saved["retry"] as Record<string, unknown>), false);
    // Other retry keys stay.
    assert.equal("provider" in (saved["retry"] as Record<string, unknown>), true);
  });

  it("string[] accepts +name/-name entries and treats an empty list as unset", async () => {
    const dir = await agentDir("tools");
    const result = await applySettingsPatch(dir, { defaultTools: ["+codemode", "-bash"] });
    assert.deepEqual(result.values["defaultTools"], ["+codemode", "-bash"]);

    const cleared = await applySettingsPatch(dir, { defaultTools: [] });
    assert.equal(cleared.values["defaultTools"], null);
  });

  it("rejects unknown keys without touching the file", async () => {
    const dir = await agentDir("unknown", REAL_WORLD);
    await assert.rejects(
      applySettingsPatch(dir, { theme: "light" } as Record<string, unknown>),
      SettingsValidationError,
    );
    // Nothing changed and no backup was created for the failed attempt.
    assert.equal(existsSync(join(dir, "settings.json.bak")), false);
    const saved = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved["theme"], "dark");
  });

  it("validates types and ranges", async () => {
    const dir = await agentDir("validate", "{}");
    const bad: Array<Record<string, unknown>> = [
      { "compaction.enabled": "yes" },
      { "compaction.reserveTokens": 1.5 },
      { "compaction.reserveTokens": -1 },
      { "retry.maxRetries": 99 },
      { defaultThinkingLevel: "ultra" },
      { defaultProvider: 42 },
      { defaultTools: ["bash;rm -rf /"] },
      { defaultTools: "read" },
    ];
    for (const patch of bad) {
      await assert.rejects(applySettingsPatch(dir, patch), SettingsValidationError);
    }
    // The file is still the pristine empty object.
    assert.equal(await readFile(join(dir, "settings.json"), "utf8"), "{}");
  });

  it("refuses to write over an unparseable settings.json", async () => {
    const dir = await agentDir("broken", "{ not json");
    await assert.rejects(applySettingsPatch(dir, { "retry.maxRetries": 1 }), SettingsValidationError);
    assert.equal(await readFile(join(dir, "settings.json"), "utf8"), "{ not json");
  });

  it("leaves no .tmp file behind", async () => {
    const dir = await agentDir("atomic", REAL_WORLD);
    await applySettingsPatch(dir, { "retry.maxRetries": 2 });
    assert.equal(existsSync(join(dir, "settings.json.tmp")), false);
  });
});
