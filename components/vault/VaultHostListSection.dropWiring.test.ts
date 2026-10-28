import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level contract for the vault host drop path.
 *
 * The behaviour itself lives in `domain/vaultHostDropPlan.ts` (unit-tested) and
 * is exercised against the packaged app; these assertions pin the wiring that
 * used to be missing: the drop destination is planned, cross-group drops move
 * the host, derived sections are excluded, and the tree keeps a root drop zone.
 */
const source = readFileSync(new URL("./VaultHostListSection.tsx", import.meta.url), "utf8");

test("host drops resolve a plan instead of assuming a reorder", () => {
  assert.match(source, /resolveVaultHostDropPlan\(/);
  assert.match(source, /payload: buildHostDragPayload\(e\.dataTransfer\)/);
});

test("a planned move goes through the batched group move", () => {
  assert.match(source, /moveHostsIntoGroup\(plan\.hostIds, plan\.groupPath\)/);
});

test("a host dropped on another group's row shows the move indicator", () => {
  assert.match(source, /markVaultInsideDropIndicator\(target\)/);
});

test("derived sections (pinned / recent) are recognised on the drop target", () => {
  assert.match(source, /isVaultOrderedSectionKey\(target\.dataset\.vaultGridItem\)/);
});

test("the tree's empty area is a root drop zone that ungroups hosts", () => {
  assert.match(source, /moveHostsIntoGroup\(dropHostIds, null\)/);
});

test("tree-originated drags register with the same drag state", () => {
  assert.match(source, /document\.addEventListener\("dragstart", handleDragStartCapture, true\)/);
});

test("a multi-host selection is no longer forced to drop on group rows only", () => {
  assert.doesNotMatch(source, /hasVaultDragType\(e\.dataTransfer, VAULT_HOST_DRAG_IDS\)\)\s*\{\s*const groupTarget/);
});

test("group rows keep their own drop handling", () => {
  assert.match(source, /Group rows keep their own drop handlers/);
});
