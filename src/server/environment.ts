/**
 * Read-only view of what pi will load: its settings files, skills, and MCP
 * servers.
 *
 * Everything here is *discovered and reported*, never written and never
 * executed. Two deliberate choices:
 *
 * - MCP servers are read from `mcp.json` instead of running `pi mcp list`.
 *   That command connects to every server (which can spawn `npx`, prompt for
 *   OAuth, or hang), and a settings page has no business starting processes.
 *   The trade-off is that live connection state is not shown — the UI says so.
 * - Skills are listed by scanning the agent directory, not via pi's
 *   `get_commands` RPC, so the page works with no session open. The cost is
 *   that per-project `.pi/skills` are not included (the page is machine-wide).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { EDITABLE_KEYS, editableValuesOf, readAgentsMd } from "./settingsStore.ts";
import type {
  ConfigFileInfo,
  McpServerInfo,
  ResourcePaths,
  SettingsEnvironment,
  SkillInfo,
} from "../shared/types.ts";

/** Frontmatter lives at the top of a skill; 8 KB is far more than it needs. */
const FRONTMATTER_BYTES = 8 * 1024;

export async function collectEnvironment(config: Config): Promise<SettingsEnvironment> {
  const agentDir = config.agentDir;
  const settingsPath = join(agentDir, "settings.json");
  const mcpPath = join(agentDir, "mcp.json");

  const [settings, mcp, files, skills, agentsMd] = await Promise.all([
    readJson(settingsPath),
    readJson(mcpPath),
    describeFiles([
      ["settings.json", settingsPath],
      ["mcp.json", mcpPath],
      ["models.json", join(agentDir, "models.json")],
      ["auth.json", join(agentDir, "auth.json")],
      ["AGENTS.md", join(agentDir, "AGENTS.md")],
    ]),
    listSkills(join(agentDir, "skills")),
    readAgentsMd(agentDir),
  ]);

  return {
    agentDir,
    files,
    defaults: {
      provider: stringOrNull(settings?.["defaultProvider"]),
      model: stringOrNull(settings?.["defaultModel"]),
      thinkingLevel: stringOrNull(settings?.["defaultThinkingLevel"]),
      theme: stringOrNull(settings?.["theme"]),
      hideThinkingBlock: settings?.["hideThinkingBlock"] === true,
    },
    resourcePaths: readResourcePaths(settings),
    editable: {
      keys: EDITABLE_KEYS,
      values: editableValuesOf(settings),
    },
    agentsMd,
    skills,
    mcpServers: listMcpServers(mcp, mcpPath),
    server: {
      host: config.host,
      port: config.port,
      sessionsDir: config.sessionsDir,
      piBin: config.piBin,
      idleTimeoutMs: config.idleTimeoutMs,
    },
    // Ids, not sentences: the wording lives in the client's dictionary.
    noteIds: ["readonly", "mcpNoConnect"],
  };
}

function readResourcePaths(settings: Record<string, unknown> | null): ResourcePaths {
  return {
    packages: stringArray(settings?.["packages"]),
    extensions: stringArray(settings?.["extensions"]),
    skills: stringArray(settings?.["skills"]),
    prompts: stringArray(settings?.["prompts"]),
    themes: stringArray(settings?.["themes"]),
    // pi's default is true, and only an explicit `false` turns it off.
    enableSkillCommands: settings?.["enableSkillCommands"] !== false,
  };
}

function listMcpServers(
  mcp: Record<string, unknown> | null,
  mcpPath: string,
): McpServerInfo[] {
  const servers = mcp?.["mcpServers"];
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, unknown>)
    .map(([name, value]) => {
      const spec = (value ?? {}) as Record<string, unknown>;
      const url = stringOrNull(spec["url"]);
      const command = stringOrNull(spec["command"]);
      const args = stringArray(spec["args"]);
      return {
        name,
        transport: url ? ("http" as const) : ("stdio" as const),
        target: url ?? [command ?? "?", ...args].join(" "),
        // `enabled: false` keeps an entry without connecting to it.
        enabled: spec["enabled"] !== false,
        description: stringOrNull(spec["description"]) ?? "",
        source: mcpPath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills are directories holding a `SKILL.md`, or bare `.md` files. Only the
 * frontmatter (`name` / `description`) is read; the body is instructions for
 * the model, not something this page needs.
 */
async function listSkills(skillsDir: string): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = await Promise.all(
    entries.map(async (entry): Promise<SkillInfo | null> => {
      if (entry.isFile()) {
        if (!entry.name.endsWith(".md")) return null;
        const path = join(skillsDir, entry.name);
        const meta = await readFrontmatter(path);
        return {
          name: meta.name ?? entry.name.replace(/\.md$/, ""),
          description: meta.description ?? "",
          path,
          scope: "user",
        };
      }
      if (!entry.isDirectory()) return null;
      const path = join(skillsDir, entry.name, "SKILL.md");
      const meta = await readFrontmatter(path);
      if (meta.missing) return null; // a directory without a SKILL.md is not a skill
      return {
        name: meta.name ?? entry.name,
        description: meta.description ?? "",
        path,
        scope: "user",
      };
    }),
  );

  return found
    .filter((skill): skill is SkillInfo => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface Frontmatter {
  name?: string;
  description?: string;
  /** True when the file itself is missing (only used to skip directories). */
  missing?: boolean;
}

/** Parse the leading `---` block of a Markdown file. Missing keys stay undefined. */
async function readFrontmatter(path: string): Promise<Frontmatter> {
  let text: string;
  try {
    text = (await readFile(path)).subarray(0, FRONTMATTER_BYTES).toString("utf8");
  } catch {
    return { missing: true };
  }
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};

  const fields = parseFrontmatter(text.slice(3, end));
  return { name: fields["name"], description: fields["description"] };
}

/** Block scalars: `key: |`, `key: >`, and their chomping variants. */
const BLOCK_SCALAR = /^[|>][-+]?$/;

/**
 * Minimal YAML frontmatter reader: the flat `key: value` pairs skills use, plus
 * block scalars, which real skills do use for long descriptions:
 *
 * ```
 * description: |
 *   first line
 *   second line
 * ```
 *
 * Newlines inside a block are folded to spaces because the only consumer is a
 * one-line UI label — a browser collapses them anyway. Nested mappings are not
 * supported on purpose: nothing here needs them.
 */
function parseFrontmatter(blockText: string): Record<string, string> {
  const lines = blockText.split("\n");
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[index] ?? "");
    const key = match?.[1];
    if (key === undefined) continue;
    const inline = (match?.[2] ?? "").trim();

    if (!BLOCK_SCALAR.test(inline)) {
      fields[key] = inline.replace(/^["']|["']$/g, "");
      continue;
    }

    const collected: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      // A block ends at the first line that is neither indented nor blank.
      if (line !== "" && !/^[ \t]/.test(line)) break;
      collected.push(line.trim());
      cursor += 1;
    }
    fields[key] = collected.join(" ").replace(/\s+/g, " ").trim();
    index = cursor - 1;
  }
  return fields;
}

async function describeFiles(entries: ReadonlyArray<readonly [string, string]>): Promise<ConfigFileInfo[]> {
  return Promise.all(
    entries.map(async ([label, path]) => {
      const info = await stat(path).catch(() => null);
      return {
        label,
        path,
        exists: info !== null,
        mtime: info ? info.mtime.toISOString() : null,
        sizeBytes: info ? info.size : null,
      };
    }),
  );
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Missing or invalid JSON is the same to us: nothing to report.
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
