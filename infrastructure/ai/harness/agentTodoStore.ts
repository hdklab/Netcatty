/**
 * Per-chat-session agent todo store.
 *
 * `manage_todo_list` runs in the renderer, so the tool executor publishes the
 * validated list here and the AI sidebar renders it directly. State is
 * intentionally in-memory only: a todo list is turn-scoped UI state, not chat
 * history. Entries are bounded (oldest session dropped first) and removed when
 * a session is cleared, so a long-lived window cannot accumulate lists.
 */

import { useSyncExternalStore } from 'react';
import type { AgentTodo } from './agentTodo';

/** Upper bound on retained sessions; oldest entries are dropped first. */
const MAX_TRACKED_SESSIONS = 100;

const EMPTY_TODO_LIST: AgentTodo[] = [];

const todoListBySession = new Map<string, AgentTodo[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function normalizeSessionId(sessionId: string | null | undefined): string | null {
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Current todo list for a chat session; a stable empty array when unknown. */
export function getAgentTodo(sessionId: string | null | undefined): AgentTodo[] {
  const key = normalizeSessionId(sessionId);
  if (!key) return EMPTY_TODO_LIST;
  return todoListBySession.get(key) ?? EMPTY_TODO_LIST;
}

/** Replace the list for a session. An empty list clears the entry. */
export function setAgentTodo(
  sessionId: string | null | undefined,
  todoList: readonly AgentTodo[],
): void {
  const key = normalizeSessionId(sessionId);
  if (!key) return;

  if (todoList.length === 0) {
    clearAgentTodo(key);
    return;
  }

  // Re-insert so the map's insertion order tracks recent use.
  todoListBySession.delete(key);
  todoListBySession.set(key, [...todoList]);

  while (todoListBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = todoListBySession.keys().next();
    if (oldest.done) break;
    todoListBySession.delete(oldest.value);
  }

  notify();
}

/** Drop a chat session's list (session deleted or explicitly reset). */
export function clearAgentTodo(sessionId: string | null | undefined): void {
  const key = normalizeSessionId(sessionId);
  if (!key) return;
  if (todoListBySession.delete(key)) {
    notify();
  }
}

export function subscribeAgentTodo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to one chat session's todo list. */
export function useAgentTodo(sessionId: string | null | undefined): AgentTodo[] {
  return useSyncExternalStore(
    subscribeAgentTodo,
    () => getAgentTodo(sessionId),
    () => EMPTY_TODO_LIST,
  );
}
