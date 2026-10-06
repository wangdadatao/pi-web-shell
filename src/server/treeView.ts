/**
 * Reshape pi's `get_tree` RPC answer into the light payload the branch-tree
 * panel renders.
 *
 * The raw tree carries whole entries (full message content, tool results), and
 * a tree view needs none of that — an id, who talked, a one-line preview, the
 * optional label, and whether the node sits on the active branch. Parents are
 * gone too: the active path is recovered from `leafId` plus each entry's
 * `parentId`, because the panel highlights the branch the session is on.
 */

export interface TreeViewNode {
  id: string;
  kind: "user" | "assistant" | "other";
  preview: string;
  label: string | null;
  /** True when the node sits on the path from a root to `leafId`. */
  active: boolean;
  children: TreeViewNode[];
}

export interface TreeView {
  nodes: TreeViewNode[];
  leafId: string | null;
}

const PREVIEW_MAX = 120;

interface RawNode {
  entry: Record<string, unknown>;
  children: RawNode[];
  label?: unknown;
}

export function reshapeTree(data: unknown): TreeView {
  const record = (data ?? {}) as Record<string, unknown>;
  const forest = Array.isArray(record["tree"]) ? (record["tree"] as unknown[]) : [];
  const leafId = typeof record["leafId"] === "string" ? record["leafId"] : null;

  // parent links for the active-path walk: every entry knows its parentId.
  const parents = new Map<string, string>();
  collectParents(forest, parents);

  const active = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && cursor !== undefined && !active.has(cursor)) {
    active.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }

  return { nodes: forest.map((node) => convert(node, active)).filter((n): n is TreeViewNode => n !== null), leafId };
}

function collectParents(forest: unknown[], parents: Map<string, string>): void {
  for (const raw of forest) {
    const node = raw as RawNode | null;
    const entry = node?.entry;
    if (!entry || typeof entry !== "object") continue;
    const id = idOf(entry);
    const parentId = entry["parentId"];
    if (id !== null && typeof parentId === "string") parents.set(id, parentId);
    if (Array.isArray(node!.children)) collectParents(node!.children, parents);
  }
}

function convert(raw: unknown, active: Set<string>): TreeViewNode | null {
  const node = raw as RawNode | null;
  const entry = node?.entry;
  if (!entry || typeof entry !== "object") return null;

  const id = idOf(entry) ?? "";
  const type = entry["type"];
  const role = entry["role"];

  let kind: TreeViewNode["kind"] = "other";
  if (type === "message") kind = role === "user" ? "user" : "assistant";

  return {
    id,
    kind,
    preview: previewOf(entry),
    label: typeof node!.label === "string" && node!.label !== "" ? node!.label : null,
    active: id !== "" && active.has(id),
    children: (Array.isArray(node!.children) ? node!.children : [])
      .map((child) => convert(child, active))
      .filter((child): child is TreeViewNode => child !== null),
  };
}

function idOf(entry: Record<string, unknown>): string | null {
  return typeof entry["id"] === "string" ? entry["id"] : null;
}

/** First text of the entry, collapsed to one line; entry type for non-messages. */
function previewOf(entry: Record<string, unknown>): string {
  if (entry["type"] !== "message") return String(entry["type"] ?? "?");
  const text = textOf(entry["content"]).replace(/\s+/g, " ").trim();
  if (text === "") return "…";
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>)["type"] === "text") {
      const text = (block as Record<string, unknown>)["text"];
      if (typeof text === "string" && text.trim() !== "") return text;
    }
  }
  return "";
}
