/**
 * The write path for pi's agent-directory settings.json.
 *
 * The browser never sends a JSON document to write verbatim. It sends a flat
 * `{ "dotted.key": value | null }` patch over the fixed whitelist below, and
 * every value is type- and range-checked here before anything touches disk.
 * `null` (or an empty string) removes the key, so pi falls back to its
 * built-in default. Keys present in the file but not on the whitelist are
 * parsed and re-serialized untouched — editing from the web must never
 * surprise keys this page does not know about.
 *
 * The whitelist deliberately carries only keys that mean something to the web
 * shell. Terminal-only keys (theme, tuiMode, fullscreen*, terminal.*, …) stay
 * out of the page; edit those in the file itself.
 *
 * Safety: one backup (`settings.json.bak`, the previous bytes) per save and an
 * atomic tmp+rename write, so a crash mid-save cannot leave a truncated file.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditableKeySpec } from "../shared/types.ts";

/** Mirrors pi's `docs/settings.md`; defaults are pi's built-ins, not ours. */
export const EDITABLE_KEYS: Record<string, EditableKeySpec> = {
  // Model and thinking — rendered on the "models" settings page.
  defaultProvider: { type: "string", builtin: null },
  defaultModel: { type: "string", builtin: null },
  defaultThinkingLevel: {
    type: "enum",
    values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    builtin: "medium",
  },
  // Agent behaviour — rendered on the "agent" settings page.
  defaultTools: { type: "string[]", builtin: "read, bash, edit, write" },
  hideThinkingBlock: { type: "boolean", builtin: false },
  showCacheMissNotices: { type: "boolean", builtin: false },
  enableSkillCommands: { type: "boolean", builtin: true },
  "markdown.mermaid": { type: "enum", values: ["off", "final", "streaming"], builtin: "streaming" },
  "compaction.enabled": { type: "boolean", builtin: true },
  "compaction.reserveTokens": { type: "number", min: 0, max: 1_000_000, builtin: 16384 },
  "compaction.keepRecentTokens": { type: "number", min: 0, max: 1_000_000, builtin: 20000 },
  "images.autoResize": { type: "boolean", builtin: true },
  "images.blockImages": { type: "boolean", builtin: false },
  "retry.enabled": { type: "boolean", builtin: true },
  "retry.maxRetries": { type: "number", min: 0, max: 10, builtin: 3 },
  "retry.baseDelayMs": { type: "number", min: 0, max: 600_000, builtin: 2000 },
  "retry.maxAgentDelayMs": { type: "number", min: 0, max: 3_600_000, builtin: 60_000 },
};

/** A rejected patch: the file on disk was never touched. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

/** AGENTS.md is instructions, not config; a megabyte is already absurd. */
const MAX_AGENTS_MD = 1024 * 1024;

/** Write a whole small file: back the current bytes up, then swap atomically. */
async function backupAndWrite(path: string, content: string): Promise<string | null> {
  let backup: string | null = null;
  try {
    await copyFile(path, `${path}.bak`);
    backup = `${path}.bak`;
  } catch {
    // No previous file: nothing to back up.
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return backup;
}

/** Replace the agent directory's AGENTS.md (global instructions). */
export async function writeAgentsMd(
  agentDir: string,
  content: string,
): Promise<{ backup: string | null; bytes: number }> {
  if (typeof content !== "string") throw new SettingsValidationError("content must be a string");
  if (content.length > MAX_AGENTS_MD) {
    throw new SettingsValidationError(`AGENTS.md is larger than ${MAX_AGENTS_MD} bytes; edit it by hand`);
  }
  const backup = await backupAndWrite(join(agentDir, "AGENTS.md"), content);
  return { backup, bytes: Buffer.byteLength(content, "utf8") };
}

/** Read AGENTS.md for the editor; null when missing or too large to edit. */
export async function readAgentsMd(agentDir: string): Promise<string | null> {
  try {
    const content = await readFile(join(agentDir, "AGENTS.md"), "utf8");
    return content.length > MAX_AGENTS_MD ? null : content;
  } catch {
    return null;
  }
}

/**
 * Enable or disable one MCP server in mcp.json.
 *
 * pi's own rule is mirrored: `enabled: false` keeps the entry without
 * connecting, an absent flag means enabled — so enabling *removes* the key
 * instead of writing `true`, leaving the file the way pi itself would.
 */
export async function setMcpEnabled(
  agentDir: string,
  name: string,
  enabled: boolean,
): Promise<{ backup: string | null; enabled: boolean }> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new SettingsValidationError("name must be a non-empty string");
  }
  if (typeof enabled !== "boolean") throw new SettingsValidationError("enabled must be a boolean");

  const mcpPath = join(agentDir, "mcp.json");
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(mcpPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    root = parsed as Record<string, unknown>;
  } catch {
    throw new SettingsValidationError("mcp.json is missing or not valid JSON; fix it by hand first");
  }

  const servers = root["mcpServers"];
  if (!servers || typeof servers !== "object") {
    throw new SettingsValidationError("mcp.json has no mcpServers object");
  }
  const spec = (servers as Record<string, unknown>)[name];
  if (!spec || typeof spec !== "object") {
    throw new SettingsValidationError(`unknown MCP server: ${name}`);
  }

  if (enabled) delete (spec as Record<string, unknown>)['enabled'];
  else (spec as Record<string, unknown>)['enabled'] = false;

  const backup = await backupAndWrite(mcpPath, `${JSON.stringify(root, null, 2)}\n`);
  return { backup, enabled };
}

/** Tool-list entries: plain names or `+name` / `-name` modifiers. */
const TOOL_ENTRY = /^[+-]?[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const MAX_STRING = 200;
const MAX_ARRAY = 64;

/** Current value per whitelist key from an already-parsed settings object. */
export function editableValuesOf(
  settings: Record<string, unknown> | null,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(EDITABLE_KEYS)) {
    const value = getPath(settings, key);
    values[key] = value === undefined ? null : value;
  }
  return values;
}

export interface SettingsPatchResult {
  /** Post-patch value of every whitelist key (null = unset). */
  values: Record<string, unknown>;
  /** Path of the backup written before the change, or null when none was needed. */
  backup: string | null;
}

/**
 * Apply a flat `{key: value|null}` patch and write settings.json atomically.
 * Throws `SettingsValidationError` (400 material) for anything unexpected;
 * any other error is I/O and bubbles up as a 500.
 */
export async function applySettingsPatch(
  agentDir: string,
  patch: Record<string, unknown>,
): Promise<SettingsPatchResult> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SettingsValidationError("patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!EDITABLE_KEYS[key]) throw new SettingsValidationError(`unknown setting: ${key}`);
  }

  const settingsPath = join(agentDir, "settings.json");
  let root: Record<string, unknown> = {};
  try {
    const text = await readFile(settingsPath, "utf8");
    // A file that exists but does not parse must not be overwritten: the
    // user has to fix it by hand first, or this save would destroy data.
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      root = parsed as Record<string, unknown>;
    } catch {
      throw new SettingsValidationError("settings.json is not a JSON object; fix it by hand first");
    }
  } catch (error) {
    if (error instanceof SettingsValidationError) throw error;
    // Missing file: start from an empty object. Anything else (EACCES, …) bubbles.
  }

  for (const [key, raw] of Object.entries(patch)) {
    const value = validateValue(key, EDITABLE_KEYS[key]!, raw);
    if (value === null) deletePath(root, key);
    else setPath(root, key, value);
  }

  const backup = await backupAndWrite(settingsPath, `${JSON.stringify(root, null, 2)}\n`);
  return { values: editableValuesOf(root), backup };
}

/** Normalize one incoming value; `null` means "remove the key". */
function validateValue(key: string, spec: EditableKeySpec, raw: unknown): unknown {
  // An empty string is the UI's way of saying "unset" for every type — no
  // whitelisted key has a legitimate "" value.
  if (raw === null || raw === undefined || raw === "") return null;

  switch (spec.type) {
    case "boolean":
      if (typeof raw !== "boolean") throw new SettingsValidationError(`${key}: expected true or false`);
      return raw;

    case "string": {
      if (typeof raw !== "string") throw new SettingsValidationError(`${key}: expected a string`);
      const value = raw.trim();
      if (value === "") return null; // empty means "unset, use pi's default"
      if (value.length > MAX_STRING) throw new SettingsValidationError(`${key}: too long`);
      return value;
    }

    case "enum":
      if (typeof raw !== "string" || !(spec.values ?? []).includes(raw)) {
        throw new SettingsValidationError(`${key}: expected one of ${(spec.values ?? []).join(" | ")}`);
      }
      return raw;

    case "number": {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
        throw new SettingsValidationError(`${key}: expected an integer`);
      }
      if ((spec.min !== undefined && raw < spec.min) || (spec.max !== undefined && raw > spec.max)) {
        throw new SettingsValidationError(`${key}: out of range (${spec.min ?? "-∞"}…${spec.max ?? "∞"})`);
      }
      return raw;
    }

    case "string[]": {
      if (!Array.isArray(raw)) throw new SettingsValidationError(`${key}: expected an array of strings`);
      if (raw.length > MAX_ARRAY) throw new SettingsValidationError(`${key}: too many entries`);
      const list: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string") throw new SettingsValidationError(`${key}: entries must be strings`);
        const value = entry.trim();
        if (value === "") continue;
        if (!TOOL_ENTRY.test(value)) throw new SettingsValidationError(`${key}: bad entry "${value}"`);
        list.push(value);
      }
      return list.length === 0 ? null : list;
    }
  }
}

/** Read `a.b.c` from a nested object; undefined when any segment is missing. */
function getPath(source: Record<string, unknown> | null, dotted: string): unknown {
  let node: unknown = source;
  for (const segment of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Set `a.b.c`, creating intermediate objects as needed. */
function setPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

/** Delete the leaf of `a.b.c`. An emptied parent object is left in place —
 * pi resolves each setting independently, so `"compaction": {}` is harmless. */
function deletePath(root: Record<string, unknown>, dotted: string): void {
  const segments = dotted.split(".");
  let node: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (!next || typeof next !== "object") return;
    node = next as Record<string, unknown>;
  }
  delete node[segments[segments.length - 1]!];
}
