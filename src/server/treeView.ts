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

/**
 * Entry types that are session bookkeeping, not conversation. The CLI's tree
 * hides them by default, and a navigator that shows "thinking_level_change"
 * as a reply is noise. Hidden nodes are *hoisted*, not dropped: their children
 * take their place so an interleaved system/bookkeeping entry cannot cut off
 * the rest of the branch.
 */
const HIDDEN_TYPES = new Set([
  "usage",
  "model_change",
  "thinking_level_change",
  "session_info",
  "label",
  "context_edit",
  "custom",
]);

interface RawNode {
  entry: Record<string, unknown>;
  children: RawNode[];
  label?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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

  return { nodes: forest.flatMap((node) => convert(node, active)), leafId };
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

/**
 * Convert one raw node into zero or more view nodes.
 *
 * Zero for a hidden bookkeeping node *whose children are returned instead* —
 * the caller's `flatMap` splices them into the parent's list, so a hidden entry
 * in the middle of a branch cannot swallow the branch.
 *
 * pi's `get_tree` hands back whole session entries: a message entry is
 * `{type:"message", id, parentId, timestamp, message:{role, content, …}}`.
 * The role/content live under `message`, not on the entry — reading them from
 * the top level silently makes every node "assistant" with an empty preview.
 */
function convert(raw: unknown, active: Set<string>): TreeViewNode[] {
  const node = raw as RawNode | null;
  const entry = node?.entry;
  if (!entry || typeof entry !== "object") return [];

  const children = (Array.isArray(node!.children) ? node!.children : []).flatMap((child) =>
    convert(child, active),
  );
  if (isHidden(entry)) return children;

  const id = idOf(entry) ?? "";
  return [
    {
      id,
      kind: kindOf(entry),
      preview: previewOf(entry),
      label: typeof node!.label === "string" && node!.label !== "" ? node!.label : null,
      active: id !== "" && active.has(id),
      children,
    },
  ];
}

// A hidden node is hoisted away, so a label attached to it is dropped with it.
// Acceptable — the CLI's default view hides these entries too, and labels are
// only set on conversation nodes in practice.
function isHidden(entry: Record<string, unknown>): boolean {
  const type = entry["type"];
  if (typeof type !== "string") return false;
  if (HIDDEN_TYPES.has(type)) return true;
  // System messages carry the prompt/tool loadout; they are not conversation.
  if (type === "message") return asRecord(entry["message"])?.["role"] === "system";
  return false;
}

function kindOf(entry: Record<string, unknown>): TreeViewNode["kind"] {
  if (entry["type"] !== "message") return "other";
  const role = asRecord(entry["message"])?.["role"];
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "other";
}

function idOf(entry: Record<string, unknown>): string | null {
  return typeof entry["id"] === "string" ? entry["id"] : null;
}

/**
 * Ids of the user messages on the active branch, oldest first.
 *
 * Feeds the inline "edit / delete and resend" actions, which need the durable
 * entry id to `fork` from. The transcript (`get_messages`) has no ids, and
 * `get_fork_messages` is not branch-filtered, so walk from `leafId` through
 * `parentId` — same cursor `get_tree` uses — and keep the user messages.
 *
 * Callers align this with the rendered transcript from the **end**: compaction
 * drops older user messages from the model context but never reorders them, so
 * the tail always lines up even when the head does not.
 */
export function activeUserEntryIds(data: unknown): string[] {
  const record = asRecord(data) ?? {};
  const entries = Array.isArray(record["entries"]) ? record["entries"] : [];
  const leafId = typeof record["leafId"] === "string" ? record["leafId"] : null;

  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of entries) {
    const entry = asRecord(raw);
    const id = entry ? idOf(entry) : null;
    if (entry && id) byId.set(id, entry);
  }

  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let cursor = leafId; cursor && !seen.has(cursor); ) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    path.push(entry);
    cursor = typeof entry["parentId"] === "string" ? entry["parentId"] : null;
  }
  path.reverse();

  return path
    .filter((entry) => entry["type"] === "message" && asRecord(entry["message"])?.["role"] === "user")
    .map((entry) => idOf(entry))
    .filter((id): id is string => id !== null);
}

/** First text of the entry, collapsed to one line; entry type for non-messages. */
function previewOf(entry: Record<string, unknown>): string {
  if (entry["type"] !== "message") return String(entry["type"] ?? "?");
  const content = asRecord(entry["message"])?.["content"];
  const text = textOf(content).replace(/\s+/g, " ").trim();
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
