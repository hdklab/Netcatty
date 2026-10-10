import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canHostAiPanelForTab,
  resolveAiPanelTerminalTab,
} from './resolveAiPanelTerminalTab.ts';

const session = (id: string, overrides: { workspaceId?: string | null; hiddenFromTabs?: boolean } = {}) => ({
  id,
  ...overrides,
});
const workspace = (id: string) => ({ id });

test('only terminal sessions and workspaces can host the AI panel', () => {
  const candidates = {
    sessions: [session('s1'), session('s2')],
    workspaces: [workspace('w1')],
  };
  assert.equal(canHostAiPanelForTab('s1', candidates), true);
  assert.equal(canHostAiPanelForTab('w1', candidates), true);
  // The Vaults pseudo-tab (and editor tabs) never host the AI panel.
  assert.equal(canHostAiPanelForTab('vault', candidates), false);
  assert.equal(canHostAiPanelForTab('editor:1', candidates), false);
  assert.equal(canHostAiPanelForTab(null, candidates), false);
});

test('prefers the workspace the user is currently inside', () => {
  assert.equal(
    resolveAiPanelTerminalTab({
      sessions: [session('s1'), session('s2', { workspaceId: 'w1' })],
      workspaces: [workspace('w1')],
      activeWorkspaceId: 'w1',
    }),
    'w1',
  );
});

test('falls back to the focused session that owns its own tab', () => {
  assert.equal(
    resolveAiPanelTerminalTab({
      sessions: [session('s1'), session('s2'), session('s3', { hiddenFromTabs: true })],
      workspaces: [],
      focusedSessionId: 's1',
    }),
    's1',
  );
});

test('ignores sessions owned by a workspace or hidden from tabs', () => {
  // s9 is the newest session but belongs to a workspace tab, and s8 is hidden:
  // neither can be the AI panel host on its own.
  assert.equal(
    resolveAiPanelTerminalTab({
      sessions: [
        session('s7'),
        session('s8', { hiddenFromTabs: true }),
        session('s9', { workspaceId: 'w1' }),
      ],
      workspaces: [workspace('w1')],
      focusedSessionId: 's9',
    }),
    's7',
  );
});

test('uses the most recent standalone session when nothing is focused', () => {
  assert.equal(
    resolveAiPanelTerminalTab({
      sessions: [session('s1'), session('s2')],
      workspaces: [],
    }),
    's2',
  );
});

test('falls back to a workspace, then reports "no terminal"', () => {
  assert.equal(
    resolveAiPanelTerminalTab({
      sessions: [session('s1', { workspaceId: 'w1' })],
      workspaces: [workspace('w1')],
    }),
    'w1',
  );
  assert.equal(resolveAiPanelTerminalTab({ sessions: [], workspaces: [] }), null);
});
