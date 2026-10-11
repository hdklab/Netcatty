import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_SIDEBAR_DEFAULT_WIDTH,
  AI_SIDEBAR_MAX_WIDTH,
  AI_SIDEBAR_MIN_WIDTH,
  clampAiSidebarWidth,
  getAiSidebarMaxWidth,
} from './aiSidebarWidth.ts';

test('AI sidebar keeps the 5%-wider default', () => {
  assert.equal(AI_SIDEBAR_DEFAULT_WIDTH, 399);
  assert.equal(clampAiSidebarWidth(AI_SIDEBAR_DEFAULT_WIDTH, 1920), AI_SIDEBAR_DEFAULT_WIDTH);
});

test('AI sidebar clamps to its own min/max', () => {
  assert.equal(clampAiSidebarWidth(120, 1920), AI_SIDEBAR_MIN_WIDTH);
  assert.equal(clampAiSidebarWidth(4000, 1920), AI_SIDEBAR_MAX_WIDTH);
  assert.equal(clampAiSidebarWidth(Number.NaN, 1920), AI_SIDEBAR_DEFAULT_WIDTH);
  assert.equal(clampAiSidebarWidth(399.4, 1920), 399);
});

test('AI sidebar never takes more than 70% of the window', () => {
  assert.equal(getAiSidebarMaxWidth(1000), 700);
  assert.equal(clampAiSidebarWidth(900, 1000), 700);
  // A very narrow window still leaves the column usable at the minimum width:
  // the rendered element keeps its own 70vw cap.
  assert.equal(getAiSidebarMaxWidth(320), AI_SIDEBAR_MIN_WIDTH);
  assert.equal(clampAiSidebarWidth(900, 320), AI_SIDEBAR_MIN_WIDTH);
});
