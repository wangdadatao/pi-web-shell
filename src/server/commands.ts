/**
 * Reshape pi's `get_commands` payload for the composer's command menu.
 *
 * The RPC returns more than the menu needs (`sourceInfo`, resource paths), and
 * its fields are untyped on the wire, so everything is validated here rather
 * than trusted by the browser.
 */

import type { CommandInfo } from "../shared/types.ts";

export function normalizeCommands(raw: unknown): CommandInfo[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const commands: CommandInfo[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    // Duplicate names are possible when a resource is discovered twice; the
    // menu is a list of things to type, so one entry per name is enough.
    if (!name || seen.has(name)) continue;
    seen.add(name);

    commands.push({
      name,
      description: typeof record["description"] === "string" ? record["description"] : "",
      source: typeof record["source"] === "string" ? record["source"] : "",
    });
  }

  return commands;
}
