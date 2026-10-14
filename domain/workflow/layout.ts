/**
 * Canvas layout helpers. Pure so the placement rules can be unit-tested
 * (component test files live outside the repo's test globs).
 */

/** Node footprint used when looking for a free slot (the card is 220px wide). */
export const NODE_SLOT = { width: 260, height: 150 };

/**
 * First slot around `center` that does not collide with an existing node.
 * Palette clicks land near the middle of the viewport, and stacking several
 * cards on top of each other makes them unreadable.
 */
export function findFreeNodePosition(
  center: { x: number; y: number },
  existing: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  const collides = (candidate: { x: number; y: number }): boolean =>
    existing.some((node) => (
      Math.abs(node.x - candidate.x) < NODE_SLOT.width
      && Math.abs(node.y - candidate.y) < NODE_SLOT.height
    ));

  const rings = 6;
  for (let ring = 0; ring < rings; ring += 1) {
    const offsets: Array<[number, number]> = ring === 0
      ? [[0, 0]]
      : [
        // Right and below first: the palette sits on the left and the toolbar
        // above the canvas, so slots in those directions stay visible.
        [ring, 0],
        [0, ring],
        [-ring, 0],
        [0, -ring],
        [ring, ring],
        [-ring, ring],
        [ring, -ring],
        [-ring, -ring],
      ];
    for (const [dx, dy] of offsets) {
      const candidate = {
        x: Math.round(center.x + dx * NODE_SLOT.width),
        y: Math.round(center.y + dy * NODE_SLOT.height),
      };
      if (!collides(candidate)) return candidate;
    }
  }
  return { x: Math.round(center.x), y: Math.round(center.y) };
}
