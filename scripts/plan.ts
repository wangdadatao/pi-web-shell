import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Item {
  text: string;
  done: boolean;
  section: string;
}

const PLAN_PATH = fileURLToPath(new URL("../docs/PLAN.md", import.meta.url));

async function main(): Promise<void> {
  const markdown = await readFile(PLAN_PATH, "utf8");
  const items = parseItems(markdown);

  if (items.length === 0) {
    process.stdout.write("No checkbox items found in docs/PLAN.md\n");
    return;
  }

  const done = items.filter((item) => item.done).length;
  const total = items.length;
  const bar = progressBar(done, total);
  process.stdout.write(`\n  pi-web-shell plan  ${bar}  ${done}/${total}\n\n`);

  for (const [section, sectionItems] of bySection(items)) {
    const sectionDone = sectionItems.filter((item) => item.done).length;
    process.stdout.write(`  ${section}  (${sectionDone}/${sectionItems.length})\n`);
    for (const item of sectionItems) {
      process.stdout.write(`    ${item.done ? "✅" : "⬜"} ${item.text}\n`);
    }
    process.stdout.write("\n");
  }

  const next = items.find((item) => !item.done);
  if (next) {
    process.stdout.write(`  👉 next: ${next.text}   [${next.section}]\n\n`);
  } else {
    process.stdout.write("  🎉 all items done\n\n");
  }
}

function parseItems(markdown: string): Item[] {
  const items: Item[] = [];
  let section = "计划";
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      section = (heading[1] ?? "").trim();
      continue;
    }
    const checkbox = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!checkbox) continue;
    const rest = (checkbox[2] ?? "").trim();
    items.push({ text: rest, done: (checkbox[1] ?? " ").toLowerCase() === "x", section });
  }
  return items;
}

function bySection(items: Item[]): Map<string, Item[]> {
  const map = new Map<string, Item[]>();
  for (const item of items) {
    const list = map.get(item.section) ?? [];
    list.push(item);
    map.set(item.section, list);
  }
  return map;
}

function progressBar(done: number, total: number, width = 24): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
