import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceNode } from "./models.ts";
import {
  appendPaneToWorkspaceRoot,
  cloneWorkspaceTree,
  collectSessionIds,
  insertPaneIntoWorkspace,
  movePaneInWorkspace,
  pruneWorkspaceNode,
  reorderWorkspaceFocusSessionOrder,
  resolveWorkspaceFocusSessionOrder,
  swapWorkspacePanes,
} from "./workspace.ts";

const root: WorkspaceNode = {
  id: "split-1",
  type: "split",
  direction: "vertical",
  children: [
    { id: "pane-1", type: "pane", sessionId: "s1" },
    { id: "pane-2", type: "pane", sessionId: "s2" },
    { id: "pane-3", type: "pane", sessionId: "s3" },
  ],
};

test("resolveWorkspaceFocusSessionOrder follows tree order when no saved order exists", () => {
  assert.deepEqual(resolveWorkspaceFocusSessionOrder(root), ["s1", "s2", "s3"]);
});

test("resolveWorkspaceFocusSessionOrder drops stale ids and appends new panes", () => {
  assert.deepEqual(
    resolveWorkspaceFocusSessionOrder(root, ["stale", "s3", "s1"]),
    ["s3", "s1", "s2"],
  );
});

test("reorderWorkspaceFocusSessionOrder moves a session before a target", () => {
  assert.deepEqual(
    reorderWorkspaceFocusSessionOrder(root, undefined, "s3", "s1", "before"),
    ["s3", "s1", "s2"],
  );
});

test("reorderWorkspaceFocusSessionOrder moves a session after a target", () => {
  assert.deepEqual(
    reorderWorkspaceFocusSessionOrder(root, ["s1", "s2", "s3"], "s1", "s3", "after"),
    ["s2", "s3", "s1"],
  );
});

test("appendPaneToWorkspaceRoot ignores an existing session pane", () => {
  assert.equal(appendPaneToWorkspaceRoot(root, "s2"), root);
});

test("insertPaneIntoWorkspace ignores an existing session pane", () => {
  assert.equal(
    insertPaneIntoWorkspace(root, "s2", {
      direction: "vertical",
      position: "right",
      targetSessionId: "s1",
    }),
    root,
  );
});

const nestedRoot: WorkspaceNode = {
  id: "split-root",
  type: "split",
  direction: "vertical",
  sizes: [0.8, 0.2],
  children: [
    { id: "pane-a", type: "pane", sessionId: "s1" },
    {
      id: "split-inner",
      type: "split",
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [
        { id: "pane-b", type: "pane", sessionId: "s2" },
        { id: "pane-c", type: "pane", sessionId: "s3" },
      ],
    },
  ],
};

test("cloneWorkspaceTree remaps every sessionId and preserves direction/sizes", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);

  assert.equal(clone.type, "split");
  if (clone.type !== "split") return;
  assert.equal(clone.direction, "vertical");
  assert.deepEqual(clone.sizes, [0.8, 0.2]);
  const inner = clone.children[1];
  assert.equal(inner.type, "split");
  if (inner.type !== "split") return;
  assert.equal(inner.direction, "horizontal");
  assert.deepEqual(inner.sizes, [0.5, 0.5]);

  const collect = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collect);
  assert.deepEqual(collect(clone), ["n1", "n2", "n3"]);
});

test("cloneWorkspaceTree mints fresh node ids and does not mutate the source", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);
  assert.notEqual(clone.id, nestedRoot.id);
  assert.equal(nestedRoot.id, "split-root");
  const collectSrc = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collectSrc);
  assert.deepEqual(collectSrc(nestedRoot), ["s1", "s2", "s3"]);

  const collectIds = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.id] : [n.id, ...n.children.flatMap(collectIds)];
  const srcIds = new Set(collectIds(nestedRoot));
  assert.ok(collectIds(clone).every(id => !srcIds.has(id)));
});

test("cloneWorkspaceTree uses pre-minted node ids when supplied", () => {
  const clone = cloneWorkspaceTree(
    nestedRoot,
    new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]),
    new Map([["split-root", "new-root"], ["pane-a", "new-a"], ["split-inner", "new-inner"], ["pane-b", "new-b"], ["pane-c", "new-c"]]),
  );
  assert.equal(clone.id, "new-root");
  if (clone.type !== "split") return;
  assert.equal(clone.children[0].id, "new-a");
  assert.equal(clone.children[1].id, "new-inner");
});

test("cloneWorkspaceTree keeps original sessionId when the map lacks it", () => {
  const clone = cloneWorkspaceTree(
    { id: "p", type: "pane", sessionId: "s1" },
    new Map(),
  );
  assert.equal(clone.type === "pane" && clone.sessionId, "s1");
});

// ---------------------------------------------------------------------------
// Pane-to-pane rearrangement (swap / move existing pane)
// ---------------------------------------------------------------------------

const sizesOf = (node: WorkspaceNode): number[] | undefined => (
  node.type === "split" ? node.sizes : undefined
);

test("swapWorkspacePanes exchanges the two panes and keeps the tree shape", () => {
  const swapped = swapWorkspacePanes(nestedRoot, "s1", "s3");

  assert.deepEqual(collectSessionIds(swapped), ["s3", "s2", "s1"]);
  assert.equal(swapped.type, "split");
  if (swapped.type !== "split") return;
  // Root shape / ratios untouched by a swap.
  assert.equal(swapped.id, "split-root");
  assert.deepEqual(sizesOf(swapped), [0.8, 0.2]);
  assert.deepEqual(sizesOf(swapped.children[1]), [0.5, 0.5]);
  // Original tree is not mutated.
  assert.deepEqual(collectSessionIds(nestedRoot), ["s1", "s2", "s3"]);
});

test("swapWorkspacePanes is a no-op for unknown or identical ids", () => {
  assert.equal(swapWorkspacePanes(nestedRoot, "s1", "s1"), nestedRoot);
  assert.equal(swapWorkspacePanes(nestedRoot, "s1", "missing"), nestedRoot);
  assert.equal(swapWorkspacePanes(nestedRoot, "missing", "s2"), nestedRoot);
});

test("movePaneInWorkspace with a center hint swaps instead of splitting", () => {
  const moved = movePaneInWorkspace(root, "s1", {
    direction: "vertical",
    position: "center",
    targetSessionId: "s3",
  });

  assert.deepEqual(collectSessionIds(moved), ["s3", "s2", "s1"]);
  assert.equal(moved.type, "split");
  if (moved.type !== "split") return;
  assert.equal(moved.children.length, 3, "a swap must not add a split level");
});

test("movePaneInWorkspace moves a pane onto an edge of another pane", () => {
  const moved = movePaneInWorkspace(root, "s1", {
    direction: "horizontal",
    position: "bottom",
    targetSessionId: "s3",
  });

  // s1 left its first slot and now sits below s3; nothing lost or duplicated.
  assert.deepEqual(collectSessionIds(moved).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(collectSessionIds(moved), ["s2", "s3", "s1"]);
  assert.equal(moved.type, "split");
  if (moved.type !== "split") return;
  const nested = moved.children[1];
  assert.equal(nested.type, "split");
  if (nested.type !== "split") return;
  assert.equal(nested.direction, "horizontal");
  assert.deepEqual(collectSessionIds(nested), ["s3", "s1"]);
});

test("movePaneInWorkspace places the pane before the target for left/top", () => {
  const moved = movePaneInWorkspace(root, "s3", {
    direction: "vertical",
    position: "left",
    targetSessionId: "s1",
  });

  assert.deepEqual(collectSessionIds(moved), ["s3", "s1", "s2"]);
  assert.equal(moved.type, "split");
  if (moved.type !== "split") return;
  assert.equal(moved.children[0].type, "split");
  assert.deepEqual(collectSessionIds(moved.children[0]), ["s3", "s1"]);
});

test("movePaneInWorkspace keeps nested sibling ratios when the drag starts deep", () => {
  const moved = movePaneInWorkspace(nestedRoot, "s2", {
    direction: "horizontal",
    position: "bottom",
    targetSessionId: "s1",
  });

  assert.deepEqual(collectSessionIds(moved).sort(), ["s1", "s2", "s3"]);
  assert.equal(moved.type, "split");
  if (moved.type !== "split") return;
  // The outer split lost its inner branch (which collapsed to s3) and the
  // surviving direct child keeps the slot; s1 was wrapped by the new split.
  const s1Branch = moved.children.find(child => collectSessionIds(child).includes("s1"));
  assert.ok(s1Branch);
  assert.deepEqual(collectSessionIds(s1Branch!), ["s1", "s2"]);
});

test("movePaneInWorkspace is a no-op without a usable target", () => {
  assert.equal(movePaneInWorkspace(root, "s1", { direction: "vertical", position: "right" }), root);
  assert.equal(
    movePaneInWorkspace(root, "s1", { direction: "vertical", position: "right", targetSessionId: "s1" }),
    root,
  );
  assert.equal(
    movePaneInWorkspace(root, "s1", { direction: "vertical", position: "right", targetSessionId: "missing" }),
    root,
  );
  assert.equal(
    movePaneInWorkspace(root, "missing", { direction: "vertical", position: "right", targetSessionId: "s1" }),
    root,
  );
  const single: WorkspaceNode = { id: "only", type: "pane", sessionId: "s1" };
  assert.equal(
    movePaneInWorkspace(single, "s1", {
      direction: "vertical",
      position: "right",
      targetSessionId: "s1",
    }),
    single,
  );
});

test("movePaneInWorkspace on a single-pane workspace never drops the pane", () => {
  const single: WorkspaceNode = { id: "only", type: "pane", sessionId: "s1" };
  assert.equal(pruneWorkspaceNode(single, "s1"), null);
  assert.equal(
    movePaneInWorkspace(single, "s1", { direction: "vertical", position: "right", targetSessionId: "s2" }),
    single,
  );
});
