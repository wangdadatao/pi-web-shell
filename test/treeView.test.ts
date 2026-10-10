import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeUserEntryIds, reshapeTree } from "../src/server/treeView.ts";

/**
 * reshapeTree is the only transformation between pi's get_tree (whole entries,
 * parent-linked) and the panel payload (previews, active path). These tests pin
 * that contract with synthetic trees; the RPC itself is exercised end-to-end
 * against a real pi in the UI smoke paths.
 */

/**
 * The real entry shape pi's `get_tree` returns: role and content are nested
 * under `message`, not on the entry (a user message's content is a plain
 * string, an assistant's is a block array). The earlier fixture put them at the
 * top level, which is exactly why a shape bug in `convert` went unnoticed.
 */
function message(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2024-12-03T14:00:00.000Z",
    message: { role, content: role === "user" ? text : [{ type: "text", text }] },
  };
}

function node(entry: Record<string, unknown>, children: unknown[] = [], label?: string) {
  return { entry, children, ...(label !== undefined ? { label } : {}) };
}

describe("reshapeTree", () => {
  it("marks the active root-to-leaf path and leaves siblings unmarked", () => {
    // root → a1 → a2 (abandoned) and root → b1 (active leaf)
    const data = {
      tree: [
        node(
          message("root", null, "user", "怎么改这个 bug？"),
          [
            node(message("a1", "root", "assistant", "先看日志"), [
              node(message("a2", "a1", "user", "方案一：直接改这里")),
            ]),
            node(message("b1", "root", "assistant", "先看日志"), []),
          ],
        ),
      ],
      leafId: "b1",
    };

    const view = reshapeTree(data);
    assert.equal(view.leafId, "b1");
    assert.equal(view.nodes.length, 1);

    const root = view.nodes[0]!;
    assert.equal(root.kind, "user");
    assert.equal(root.active, true);
    assert.equal(root.preview, "怎么改这个 bug？");

    const a1 = root.children[0]!;
    const b1 = root.children[1]!;
    assert.equal(a1.id, "a1");
    assert.equal(a1.active, false); // sibling of the active branch
    assert.equal(b1.id, "b1");
    assert.equal(b1.active, true);
  });

  it("walks the active path through parentId, not sibling order", () => {
    const oldBranch = node(message("u2", "s1", "user", "第二问（旧分支）"), [
      node(message("s2", "u2", "assistant", "旧答案")),
    ]);
    const newBranch = node(message("u3", "s1", "user", "第二问（新分支）"), [
      node(message("s3", "u3", "assistant", "新答案")),
    ]);
    const data = {
      tree: [
        node(message("u1", null, "user", "第一问"), [
          node(message("s1", "u1", "assistant", "答一"), [oldBranch, newBranch]),
        ]),
      ],
      leafId: "s3",
    };

    const view = reshapeTree(data);
    const u1 = view.nodes[0]!;
    const s1 = u1.children[0]!;
    const u3 = s1.children[1]!;
    const s3 = u3.children[0]!;
    const u2 = s1.children[0]!;
    const s2 = u2.children[0]!;

    for (const active of [u1, s1, u3, s3]) assert.equal(active.active, true, `${active.id} on active path`);
    for (const inactive of [u2, s2]) assert.equal(inactive.active, false, `${inactive.id} is an abandoned branch`);
  });

  it("keeps labels, truncates previews, and names non-message entries", () => {
    const long = "长".repeat(300);
    const data = {
      tree: [
        node({ type: "compaction", id: "c1", parentId: null }, [], undefined),
        node(message("u1", null, "user", long), [node(message("a1", "u1", "assistant", ""), [])], "实验分支"),
      ],
      leafId: "a1",
    };

    const view = reshapeTree(data);
    assert.equal(view.nodes.length, 2);
    const compaction = view.nodes[0]!;
    const user = view.nodes[1]!;
    assert.equal(compaction.kind, "other");
    assert.equal(compaction.preview, "compaction");
    assert.equal(user.kind, "user");
    assert.equal(user.preview.length, 121); // 120 chars + ellipsis
    assert.ok(user.preview.endsWith("…"));
    assert.equal(user.label, "实验分支");
    // An assistant turn with no text still renders a node.
    assert.equal(user.children.length, 1);
  });

  it("supports multiple roots and a null leaf", () => {
    const data = {
      tree: [node(message("r1", null, "user", "一"), []), node(message("r2", null, "user", "二"), [])],
      leafId: null,
    };
    const view = reshapeTree(data);
    assert.equal(view.nodes.length, 2);
    assert.equal(view.nodes[0]!.active, false);
    assert.equal(view.nodes[1]!.active, false);
    assert.equal(view.leafId, null);
  });

  it("hides prompt bookkeeping and hoists its children", () => {
    const systemMessage = {
      type: "message",
      id: "sys1",
      parentId: "u1",
      timestamp: "2024-12-03T14:00:01.000Z",
      message: { role: "system", content: "You are an expert coding assistant…" },
    };
    const data = {
      tree: [
        node(message("u1", null, "user", "第一问"), [
          node(systemMessage, [
            node(message("a1", "sys1", "assistant", "答"), [
              node({ type: "thinking_level_change", id: "t1", parentId: "a1" }, []),
            ]),
          ]),
        ]),
      ],
      leafId: "t1",
    };

    const view = reshapeTree(data);
    const u1 = view.nodes[0]!;
    assert.equal(u1.id, "u1");
    // The system message is removed, its child takes its place rather than the
    // rest of the branch being cut off.
    assert.equal(u1.children.length, 1);
    const a1 = u1.children[0]!;
    assert.equal(a1.id, "a1");
    assert.equal(a1.kind, "assistant");
    // Trailing bookkeeping is hidden too.
    assert.equal(a1.children.length, 0);
  });

  it("resolves active-branch user ids oldest-first for inline forking", () => {
    const data = {
      entries: [
        { type: "message", id: "u1", parentId: null, message: { role: "user", content: "一" } },
        { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
        { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "二" } },
        // An abandoned sibling after u2: appended later, must not be picked.
        { type: "message", id: "u2b", parentId: "a1", message: { role: "user", content: "二（旧）" } },
        { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [] } },
        { type: "thinking_level_change", id: "t1", parentId: "a2", thinkingLevel: "high" },
      ],
      leafId: "t1",
    };

    // Newest at the end: the last entry back is u2, not the abandoned u2b.
    assert.deepEqual(activeUserEntryIds(data), ["u1", "u2"]);
  });

  it("returns no ids for an empty or unresolvable leaf", () => {
    assert.deepEqual(activeUserEntryIds({ entries: [], leafId: null }), []);
    assert.deepEqual(activeUserEntryIds({ entries: [], leafId: "ghost" }), []);
    assert.deepEqual(activeUserEntryIds(null), []);
  });

  it("tolerates junk input", () => {
    const view = reshapeTree({ tree: "nope", leafId: 42 });
    assert.deepEqual(view.nodes, []);
    assert.equal(view.leafId, null);
    const empty = reshapeTree(null);
    assert.deepEqual(empty.nodes, []);
  });
});
