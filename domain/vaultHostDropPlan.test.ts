import assert from "node:assert/strict";
import test from "node:test";

import {
  isVaultOrderedSectionKey,
  resolveVaultHostDropPlan,
} from "./vaultHostDropPlan";

const host = (overrides: {
  hostIds?: string[];
  sourceGroup?: string;
  sourceOrderedSection?: boolean;
}) => ({
  kind: "host" as const,
  hostIds: overrides.hostIds ?? ["a"],
  sourceGroup: overrides.sourceGroup ?? "",
  sourceOrderedSection: overrides.sourceOrderedSection ?? false,
});

const targetHost = (overrides: { hostId?: string; group?: string; orderedSection?: boolean }) => ({
  kind: "host" as const,
  hostId: overrides.hostId ?? "b",
  group: overrides.group ?? "",
  orderedSection: overrides.orderedSection ?? false,
});

test("same-group host drop reorders before or after the target", () => {
  for (const position of ["before", "after"] as const) {
    const plan = resolveVaultHostDropPlan({
      payload: host({ sourceGroup: "串口设备" }),
      target: targetHost({ group: "串口设备" }),
      position,
    });
    assert.deepEqual(plan, { kind: "reorder", hostId: "a", targetHostId: "b", position });
  }
});

test("cross-group host drop moves the host into the target group", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ sourceGroup: "独立设备" }),
    target: targetHost({ group: "光线设备" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "move", hostIds: ["a"], groupPath: "光线设备" });
});

test("dropping onto the dragged host itself is a no-op", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ hostIds: ["a"], sourceGroup: "g" }),
    target: targetHost({ hostId: "a", group: "g" }),
    position: "after",
  });
  assert.deepEqual(plan, { kind: "none" });
});

test("derived sections (pinned / recent) never reorder", () => {
  const fromOrderedSource = resolveVaultHostDropPlan({
    payload: host({ sourceGroup: "g", sourceOrderedSection: true }),
    target: targetHost({ group: "g" }),
    position: "before",
  });
  const ontoOrderedTarget = resolveVaultHostDropPlan({
    payload: host({ sourceGroup: "g" }),
    target: targetHost({ group: "g", orderedSection: true }),
    position: "before",
  });
  assert.deepEqual(fromOrderedSource, { kind: "none" });
  assert.deepEqual(ontoOrderedTarget, { kind: "none" });
});

test("a multi-host selection moves onto a host row instead of silently failing", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ hostIds: ["a", "b", "c"], sourceGroup: "独立设备" }),
    target: targetHost({ group: "串口设备" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "move", hostIds: ["a", "b", "c"], groupPath: "串口设备" });
});

test("a multi-host selection inside one group does not attempt a positional reorder", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ hostIds: ["a", "b"], sourceGroup: "g" }),
    target: targetHost({ group: "g" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "none" });
});

test("a multi selection is detected from the drag type even when the ids are unreadable", () => {
  const plan = resolveVaultHostDropPlan({
    payload: { kind: "host", hostIds: ["a"], sourceGroup: "g", sourceOrderedSection: false, multi: true },
    target: targetHost({ group: "g" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "none" });
});

test("the tree root drop zone ungroups hosts", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ sourceGroup: "串口设备" }),
    target: { kind: "root" },
    position: "before",
  });
  assert.deepEqual(plan, { kind: "move", hostIds: ["a"], groupPath: null });
});

test("a dragged group is never dropped onto a host row", () => {
  const plan = resolveVaultHostDropPlan({
    payload: { kind: "group", path: "开发板" },
    target: targetHost({ group: "开发板" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "none" });
});

test("an empty payload plans nothing", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ hostIds: [] }),
    target: targetHost({}),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "none" });
});

test("root group is the same group as an ungrouped host", () => {
  const plan = resolveVaultHostDropPlan({
    payload: host({ sourceGroup: "", hostIds: ["a"] }),
    target: targetHost({ group: "" }),
    position: "before",
  });
  assert.deepEqual(plan, { kind: "reorder", hostId: "a", targetHostId: "b", position: "before" });
});

test("only the pinned and recent grid item keys count as derived sections", () => {
  assert.equal(isVaultOrderedSectionKey("pinned:abc"), true);
  assert.equal(isVaultOrderedSectionKey("recent:abc"), true);
  assert.equal(isVaultOrderedSectionKey("main:abc"), false);
  assert.equal(isVaultOrderedSectionKey("grouped:组:abc"), false);
  assert.equal(isVaultOrderedSectionKey(null), false);
});
