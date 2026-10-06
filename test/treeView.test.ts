import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reshapeTree } from "../src/server/treeView.ts";

/**
 * reshapeTree is the only transformation between pi's get_tree (whole entries,
 * parent-linked) and the panel payload (previews, active path). These tests pin
 * that contract with synthetic trees; the RPC itself is exercised end-to-end
 * against a real pi in the UI smoke paths.
 */

function message(id: string, parentId: string | null, role: string, text: string) {
  return { type: "message", id, parentId, role, content: [{ type: "text", text }] };
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

  it("tolerates junk input", () => {
    const view = reshapeTree({ tree: "nope", leafId: 42 });
    assert.deepEqual(view.nodes, []);
    assert.equal(view.leafId, null);
    const empty = reshapeTree(null);
    assert.deepEqual(empty.nodes, []);
  });
});
