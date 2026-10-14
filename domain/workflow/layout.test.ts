import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_SLOT, findFreeNodePosition } from './layout.ts';

test('the centre is used when nothing is there yet', () => {
  assert.deepEqual(findFreeNodePosition({ x: 100, y: 50 }, []), { x: 100, y: 50 });
});

test('an occupied centre pushes the node to the next slot', () => {
  const position = findFreeNodePosition({ x: 100, y: 50 }, [{ x: 100, y: 50 }]);
  assert.notDeepEqual(position, { x: 100, y: 50 });
  assert.equal(position.y, 50);
  assert.equal(position.x, 100 + NODE_SLOT.width);
});

test('a whole ring of neighbours is skipped', () => {
  const occupied = [
    { x: 0, y: 0 },
    { x: NODE_SLOT.width, y: 0 },
    { x: -NODE_SLOT.width, y: 0 },
    { x: 0, y: NODE_SLOT.height },
    { x: 0, y: -NODE_SLOT.height },
  ];
  const position = findFreeNodePosition({ x: 0, y: 0 }, occupied);
  assert.ok(Math.abs(position.x) === NODE_SLOT.width && Math.abs(position.y) === NODE_SLOT.height);
});

test('nodes that are close but not overlapping still count as collisions', () => {
  const position = findFreeNodePosition({ x: 0, y: 0 }, [{ x: 40, y: 20 }]);
  assert.notDeepEqual(position, { x: 0, y: 0 });
});

test('a crowded canvas falls back to the centre instead of throwing', () => {
  const occupied: Array<{ x: number; y: number }> = [];
  for (let ring = 0; ring < 6; ring += 1) {
    for (const [dx, dy] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
      occupied.push({ x: dx * NODE_SLOT.width, y: dy * NODE_SLOT.height });
    }
  }
  assert.deepEqual(findFreeNodePosition({ x: 0, y: 0 }, occupied), { x: 0, y: 0 });
});
