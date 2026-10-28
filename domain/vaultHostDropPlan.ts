/**
 * Vault host-list drag destination planning.
 *
 * The list/tree renders several sections that do NOT share one ordering model:
 * the "pinned" and "recently connected" sections are derived (sorted by label /
 * lastConnectedAt) and therefore cannot be reordered by drag, while the main and
 * grouped sections are manual-order lists. A host row is also a legal place to
 * drop a host from another group: the expected result there is "move into that
 * group", not the cross-group reorder the old handler silently dropped.
 *
 * Everything here is pure so the drop decision (and the indicator drawn before
 * the drop) can be tested without a DOM.
 */

export type VaultDropPosition = "before" | "after";

export type VaultDropPayload =
  | {
      kind: "host";
      /** Every host carried by the payload (one for a plain card drag). */
      hostIds: readonly string[];
      /** Group of the host the drag started on ("" = root). */
      sourceGroup: string;
      /** True when the drag started in a derived, non-orderable section. */
      sourceOrderedSection: boolean;
      /**
       * True when the drag carries a multi-host selection. The DataTransfer
       * exposes that as a type during dragover, where the ids themselves are
       * still unreadable, so the flag has to travel separately.
       */
      multi?: boolean;
    }
  | { kind: "group"; path: string };

export type VaultDropTarget =
  | {
      kind: "host";
      hostId: string;
      /** Group of the target row ("" = root). */
      group: string;
      /** True when the target row lives in a derived, non-orderable section. */
      orderedSection: boolean;
    }
  | { kind: "root" };

export type VaultHostDropPlan =
  /** Drop is not actionable: draw nothing and do not accept the drop. */
  | { kind: "none" }
  /** Insert the dragged host before/after the target host. */
  | { kind: "reorder"; hostId: string; targetHostId: string; position: VaultDropPosition }
  /** Move every dragged host into the target group (null = root). */
  | { kind: "move"; hostIds: readonly string[]; groupPath: string | null };

const normalizeGroup = (group: string | null | undefined) => group ?? "";

export function resolveVaultHostDropPlan(input: {
  payload: VaultDropPayload;
  target: VaultDropTarget;
  position: VaultDropPosition;
}): VaultHostDropPlan {
  const { payload, target, position } = input;

  // A group dragged onto a host row has no meaning: groups move onto group rows
  // or the root drop zone, never onto a single host.
  if (payload.kind === "group") return { kind: "none" };

  if (target.kind === "root") {
    return { kind: "move", hostIds: payload.hostIds, groupPath: null };
  }

  const hostIds = payload.hostIds.filter((id) => id.length > 0);
  if (hostIds.length === 0) return { kind: "none" };
  if (hostIds.length === 1 && hostIds[0] === target.hostId) return { kind: "none" };

  const sameGroup = normalizeGroup(payload.sourceGroup) === normalizeGroup(target.group);
  const isMulti = payload.multi ?? hostIds.length > 1;

  // Derived sections (pinned / recent) are not ordered by the stored order, so a
  // reorder there would rewrite order values without moving anything.
  if (sameGroup) {
    if (payload.sourceOrderedSection || target.orderedSection) return { kind: "none" };
    if (isMulti || hostIds.length !== 1) return { kind: "none" };
    return { kind: "reorder", hostId: hostIds[0], targetHostId: target.hostId, position };
  }

  // Cross-group: dropping onto a host row of another group means "move there".
  return { kind: "move", hostIds, groupPath: normalizeGroup(target.group) };
}

export function isVaultOrderedSectionKey(gridItemKey: string | null | undefined): boolean {
  return Boolean(gridItemKey && (gridItemKey.startsWith("pinned:") || gridItemKey.startsWith("recent:")));
}
