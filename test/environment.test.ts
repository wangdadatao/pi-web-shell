import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectEnvironment } from "../src/server/environment.ts";
import { loadConfig } from "../src/server/config.ts";

/** An agent directory shaped like a real one, but under a temp dir. */
async function makeAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-"));
  await mkdir(join(agentDir, "skills", "image-gen"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "image-gen", "SKILL.md"),
    [
      "---",
      "name: image-gen",
      'description: "画一张图，中文提示词也行"',
      "---",
      "",
      "# Image generation",
    ].join("\n"),
  );
  // A bare markdown file is a skill too; a directory without SKILL.md is not.
  await writeFile(join(agentDir, "skills", "notes.md"), "no frontmatter here\n");
  // Block scalars are how real skills write long descriptions.
  await mkdir(join(agentDir, "skills", "blocky"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "blocky", "SKILL.md"),
    ["---", "name: blocky", "description: |", "  first line", "  second line", "---", ""].join("\n"),
  );
  await mkdir(join(agentDir, "skills", "not-a-skill"), { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-flash",
      defaultThinkingLevel: "high",
      theme: "dark",
      enableSkillCommands: false,
      packages: ["github:user/repo"],
      skills: ["-skills/notes.md"],
    }),
  );
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
        docs: { url: "https://example.com/mcp", enabled: false },
      },
    }),
  );
  return agentDir;
}

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("collectEnvironment", () => {
  it("reports skills, MCP servers, and the resource lists pi will read", async () => {
    const agentDir = await makeAgentDir();
    dirs.push(agentDir);
    const config = loadConfig({ PI_CODING_AGENT_DIR: agentDir });

    const env = await collectEnvironment(config);

    assert.equal(env.agentDir, agentDir);
    assert.deepEqual(
      env.skills.map((skill) => skill.name),
      ["blocky", "image-gen", "notes"],
    );
    assert.equal(env.skills[0]?.description, "first line second line");
    assert.equal(env.skills[1]?.description, "画一张图，中文提示词也行");
    assert.equal(env.skills[1]?.scope, "user");

    assert.deepEqual(
      env.mcpServers.map((server) => [server.name, server.transport, server.enabled]),
      [
        ["docs", "http", false],
        ["filesystem", "stdio", true],
      ],
    );
    assert.equal(env.mcpServers[1]?.target, "npx -y server-filesystem .");

    assert.equal(env.defaults.provider, "deepseek");
    assert.equal(env.defaults.model, "deepseek-flash");
    assert.equal(env.defaults.theme, "dark");
    assert.equal(env.defaults.hideThinkingBlock, false);
    assert.equal(env.resourcePaths.enableSkillCommands, false);
    assert.deepEqual(env.resourcePaths.packages, ["github:user/repo"]);
    assert.deepEqual(env.resourcePaths.skills, ["-skills/notes.md"]);
    assert.deepEqual(env.resourcePaths.prompts, []);
    // Notes travel as ids so the wording can be translated client-side.
    assert.deepEqual(env.noteIds, ["readonly", "mcpNoConnect"]);

    // The unfilled slot must be reported as missing rather than hidden.
    const models = env.files.find((file) => file.label === "models.json");
    assert.equal(models?.exists, false);
    assert.equal(models?.mtime, null);
    assert.equal(env.files.find((file) => file.label === "settings.json")?.exists, true);
  });

  it("survives an empty agent directory", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-empty-"));
    dirs.push(agentDir);
    const env = await collectEnvironment(loadConfig({ PI_CODING_AGENT_DIR: agentDir }));

    assert.deepEqual(env.skills, []);
    assert.deepEqual(env.mcpServers, []);
    assert.equal(env.defaults.provider, null);
    assert.equal(env.resourcePaths.enableSkillCommands, true);
    assert.ok(env.files.every((file) => !file.exists));
  });

  it("ignores invalid JSON instead of throwing", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-bad-"));
    dirs.push(agentDir);
    await writeFile(join(agentDir, "settings.json"), "{ not json");
    const env = await collectEnvironment(loadConfig({ PI_CODING_AGENT_DIR: agentDir }));
    assert.equal(env.defaults.provider, null);
    assert.deepEqual(env.resourcePaths.themes, []);
  });
});
