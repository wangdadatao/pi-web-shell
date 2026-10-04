/**
 * Checks that the shell's Markdown/syntax palette still matches pi's theme.
 *
 *   npm run theme:check
 *
 * Our colours are copied from pi, not invented. pi resolves its `dark.json`
 * theme (okhsl colours) into hex when it exports a session, so the reliable way
 * to read the real values is to ask pi for an HTML export and parse its `:root`
 * block. Run this after upgrading pi; if it reports drift, update the
 * `--md-*` / `--syntax-*` variables in `src/web/style.css`.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const STYLE_PATH = join(PROJECT_DIR, "src", "web", "style.css");

/** pi theme variables we mirror, and the CSS variable we store them in. */
const MIRRORED = [
  "mdHeading",
  "mdLink",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
];

function cssVarName(piName: string): string {
  return `--${piName.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function findSessionDir(): string {
  return process.env["PI_SHELL_SESSIONS_DIR"] ?? join(process.env["HOME"] ?? "", ".pi", "agent", "sessions");
}

async function findSession(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const root = findSessionDir();
  const entries = await readdir(root);
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    let info;
    try {
      info = await stat(dir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      const fileStat = await stat(file);
      candidates.push({ path: file, mtimeMs: fileStat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0];
  if (!newest) throw new Error(`no sessions found under ${root}`);
  return newest.path;
}

/**
 * Ask pi to export a session, then read the resolved theme variables.
 *
 * `theme` forces a theme through a throwaway agent directory. That indirection
 * is needed because `--use-theme` only affects the interactive TUI; the HTML
 * export resolves the `theme` *setting*, so the only way to see another theme's
 * resolved hexes is to point pi at a settings.json that asks for it.
 */
async function readPiPalette(sessionPath: string, theme?: string): Promise<Map<string, string>> {
  const workDir = await mkdtemp(join(tmpdir(), "pi-theme-"));
  const outputPath = join(workDir, "export.html");
  let env = process.env;
  if (theme) {
    const agentDir = join(workDir, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme }));
    env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  }
  const child: ChildProcessWithoutNullStreams = spawn(
    process.env["PI_SHELL_PI_BIN"] ?? "pi",
    ["--mode", "rpc", "--session", sessionPath],
    { stdio: ["pipe", "pipe", "pipe"], env },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("pi export_html timed out")), 60_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let record: { type?: string; command?: string; success?: boolean; error?: string };
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (record.type === "response" && record.command === "export_html") {
            clearTimeout(timer);
            child.stdin.end();
            if (record.success) resolve();
            else reject(new Error(record.error ?? "export_html failed"));
          }
        }
      });
      child.on("error", reject);
      child.stdin.write(`${JSON.stringify({ id: "1", type: "export_html", outputPath })}\n`);
    });

    const html = await readFile(outputPath, "utf8");
    const root = /:root\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
    const palette = new Map<string, string>();
    for (const match of root.matchAll(/--([A-Za-z]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
      const name = match[1];
      const value = match[2];
      if (name && value) palette.set(name, value.toLowerCase());
    }
    return palette;
  } finally {
    child.kill("SIGKILL");
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The variables of one block of `style.css`, lowercased. */
function readCssBlock(css: string, selector: string): Map<string, string> {
  const block = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
  const values = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) values.set(name, value.toLowerCase());
  }
  return values;
}

async function main(): Promise<void> {
  const sessionPath = await findSession(process.argv[2]);
  process.stdout.write(`session: ${sessionPath}\n`);
  process.stdout.write("exporting with pi to resolve the themes...\n\n");

  const css = await readFile(STYLE_PATH, "utf8");
  // `:root` is the dark palette (the default), `:root[data-theme="light"]` the
  // light one. Both copy pi's markdown/syntax colours, so both are checked.
  const blocks: Array<{ name: string; selector: string; theme?: string }> = [
    { name: "dark (:root)", selector: ":root" },
    { name: 'light (:root[data-theme="light"])', selector: ':root\\[data-theme="light"\\]', theme: "light" },
  ];

  let failed = false;
  for (const block of blocks) {
    const piPalette = await readPiPalette(sessionPath, block.theme);
    if (piPalette.size === 0) throw new Error("could not read any theme variables from pi's export");

    const cssValues = readCssBlock(css, block.selector);
    const drift: string[] = [];
    const missing: string[] = [];
    for (const piName of MIRRORED) {
      const expected = piPalette.get(piName);
      const ourName = cssVarName(piName);
      const actual = cssValues.get(ourName);
      if (!expected) {
        missing.push(`pi did not export --${piName}`);
        continue;
      }
      if (actual !== expected) {
        drift.push(`  ${ourName.padEnd(26)} ours ${actual ?? "(missing)"}   pi ${expected}`);
      }
    }

    if (missing.length > 0) {
      process.stdout.write(`⚠️  ${block.name}: ${missing.length} variable(s) not in pi's export\n`);
      for (const line of missing) process.stdout.write(`  ${line}\n`);
    }
    if (drift.length === 0) {
      process.stdout.write(`✅ ${block.name}: ${MIRRORED.length} colours match pi\n`);
      continue;
    }
    failed = true;
    process.stdout.write(`❌ ${block.name}: ${drift.length} colour(s) drifted\n\n`);
    for (const line of drift) process.stdout.write(`${line}\n`);
  }

  if (failed) {
    process.stdout.write("\nupdate the drifted values in src/web/style.css\n");
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
