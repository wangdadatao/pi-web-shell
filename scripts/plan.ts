import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Item {
  text: string;
  done: boolean;
  section: string;
  /** False for sections that are not work: they must not move the progress bar. */
  work: boolean;
}

const PLAN_PATH = fileURLToPath(new URL("../docs/PLAN.md", import.meta.url));

/**
 * Sections whose checkboxes are not todos.
 *
 * "已知取舍" records decisions to live with (a 256KB title read, no multi-client
 * write protection), so counting it as unfinished work made the bar permanently
 * incomplete-looking and put "next:" on an item nobody can tick.
 */
const NON_WORK_SECTIONS = ["已知取舍"];

async function main(): Promise<void> {
  const markdown = await readFile(PLAN_PATH, "utf8");
  const items = parseItems(markdown);

  if (items.length === 0) {
    process.stdout.write("No checkbox items found in docs/PLAN.md\n");
    return;
  }

  const work = items.filter((item) => item.work);
  const done = work.filter((item) => item.done).length;
  const bar = progressBar(done, work.length);
  process.stdout.write(`\n  pi-web-shell plan  ${bar}  ${done}/${work.length}\n\n`);

  for (const [section, sectionItems] of bySection(items)) {
    if (sectionItems[0]?.work === false) {
      process.stdout.write(`  ${section}  (${sectionItems.length})\n`);
      for (const item of sectionItems) process.stdout.write(`    • ${item.text}\n`);
      process.stdout.write("\n");
      continue;
    }
    const sectionDone = sectionItems.filter((item) => item.done).length;
    process.stdout.write(`  ${section}  (${sectionDone}/${sectionItems.length})\n`);
    for (const item of sectionItems) {
      process.stdout.write(`    ${item.done ? "✅" : "⬜"} ${item.text}\n`);
    }
    process.stdout.write("\n");
  }

  const next = work.find((item) => !item.done);
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
    const work = !NON_WORK_SECTIONS.some((name) => section.includes(name));
    items.push({ text: rest, done: (checkbox[1] ?? " ").toLowerCase() === "x", section, work });
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
