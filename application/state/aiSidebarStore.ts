import { useSyncExternalStore } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_AI_SIDEBAR } from '../../infrastructure/config/storageKeys';

/**
 * Global AI side panel state (VS Code style): one sidebar in the app shell that
 * follows the active view instead of living inside the terminal layer, plus a
 * collapsed rail. Persisted so the layout survives restarts, and shared through
 * a tiny store because the toggle lives in the top bar while the panel renders
 * from the terminal-layer AI context tree.
 */
export type AiSidebarState = {
  /** Panel visible (expanded or collapsed). */
  open: boolean;
  /** Open but narrowed to the icon rail. */
  collapsed: boolean;
};

/** DOM id of the app-shell node the sidebar portals into (see AppView). */
export const AI_SIDEBAR_HOST_ID = 'ai-sidebar-host';

/**
 * Scope target for sidebar chats that have no terminal/workspace behind them.
 * Orphan AI sessions are only removed through deleteSessionsByTarget (called when
 * a terminal/workspace closes), so a private id like this is never pruned and the
 * conversation survives restarts.
 */
export const AI_SIDEBAR_SCOPE_ID = 'ai-sidebar';

const DEFAULT_STATE: AiSidebarState = { open: false, collapsed: false };

function readStoredState(): AiSidebarState {
  try {
    const raw = localStorageAdapter.readString(STORAGE_KEY_AI_SIDEBAR);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<AiSidebarState> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STATE;
    return { open: Boolean(parsed.open), collapsed: Boolean(parsed.collapsed) };
  } catch {
    return DEFAULT_STATE;
  }
}

let state: AiSidebarState = readStoredState();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAiSidebarState(): AiSidebarState {
  return state;
}

export function setAiSidebarState(patch: Partial<AiSidebarState>): void {
  const next: AiSidebarState = { ...state, ...patch };
  // A collapsed panel is always open, and an open panel keeps a valid width.
  if (next.collapsed) next.open = true;
  if (next.open === state.open && next.collapsed === state.collapsed) return;
  state = next;
  try {
    localStorageAdapter.writeString(STORAGE_KEY_AI_SIDEBAR, JSON.stringify(next));
  } catch {
    // Persisting is best-effort; the in-memory state still drives the UI.
  }
  emit();
}

/** Top-bar button behaviour: open (expanded) or hide entirely. */
export function toggleAiSidebar(): void {
  setAiSidebarState({ open: !state.open, collapsed: false });
}

export function subscribeAiSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiSidebarState(): AiSidebarState {
  return useSyncExternalStore(subscribeAiSidebar, getAiSidebarState, getAiSidebarState);
}
