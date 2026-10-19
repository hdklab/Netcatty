import { useSyncExternalStore } from 'react';
import { STORAGE_KEY_AI_AGENT_ROLE } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import type { AIPermissionMode } from '../../infrastructure/ai/types';

/**
 * Catty's agent role, modelled on VS Code's chat modes: a stance the user picks
 * for the assistant, stored per user rather than per conversation. It is
 * orthogonal to the permission mode:
 *
 * - `ask` and `plan` are read-only. They map onto the existing `observer`
 *   permission mode at turn time, so every write/execute tool keeps its current
 *   gating (no second permission system, no weakened rules).
 * - `agent` keeps today's behaviour: the stored permission mode decides.
 */
export type AgentRole = 'ask' | 'agent' | 'plan';

export const AGENT_ROLES: readonly AgentRole[] = ['ask', 'agent', 'plan'];
export const DEFAULT_AGENT_ROLE: AgentRole = 'agent';

/**
 * Sent through the normal composer send path when the user accepts a plan.
 * The plan itself is already in the conversation, so the continuation only has
 * to point at it.
 */
export const PLAN_EXECUTION_CONTINUATION_MESSAGE = 'Start executing the plan above.';

export function isAgentRole(value: unknown): value is AgentRole {
  return value === 'ask' || value === 'agent' || value === 'plan';
}

/** Unknown/corrupt stored values fall back to `agent` (today's behaviour). */
export function normalizeAgentRole(value: unknown): AgentRole {
  return isAgentRole(value) ? value : DEFAULT_AGENT_ROLE;
}

/**
 * Read the persisted role. Storage access is best-effort: a missing/blocked
 * localStorage (SSR, tests, hardened webviews) must not break the chat.
 */
export function loadAgentRole(): AgentRole {
  try {
    return normalizeAgentRole(localStorageAdapter.readString(STORAGE_KEY_AI_AGENT_ROLE));
  } catch {
    return DEFAULT_AGENT_ROLE;
  }
}

let currentRole: AgentRole | null = null;
const listeners = new Set<() => void>();

export function getAgentRole(): AgentRole {
  return currentRole ?? loadAgentRole();
}

export function subscribeAgentRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Persist the role and notify subscribers. The permission mode is untouched. */
export function saveAgentRole(role: AgentRole): void {
  const next = normalizeAgentRole(role);
  const previous = getAgentRole();
  currentRole = next;
  try {
    localStorageAdapter.writeString(STORAGE_KEY_AI_AGENT_ROLE, next);
  } catch {
    // Persisting is best-effort; the in-memory role still drives this session.
  }
  if (previous === next) return;
  for (const listener of listeners) listener();
}

export function useAgentRole(): AgentRole {
  return useSyncExternalStore(subscribeAgentRole, getAgentRole, getAgentRole);
}

/**
 * The permission mode a turn must actually run with. `ask`/`plan` are forced to
 * `observer`; the user's stored mode is never rewritten, so switching back to
 * `agent` restores it.
 */
export function resolveEffectivePermissionMode(
  role: AgentRole,
  permissionMode: AIPermissionMode,
): AIPermissionMode {
  return normalizeAgentRole(role) === 'agent' ? permissionMode : 'observer';
}

/**
 * System-prompt section describing what the role may do. Kept short: the
 * permission mode still carries the operational rules, this only explains the
 * stance and (for plan) the required closing plan.
 */
export function resultingSystemPromptRoleSection(role: AgentRole): string {
  switch (normalizeAgentRole(role)) {
    case 'ask':
      return [
        '## Agent Role: Ask',
        '',
        'Read-only question answering. Do not run commands, write or transfer files, change vault entries, or call any tool that acts on a host — even if the permission mode below would allow it. Investigate with read-only tools, answer clearly, and when the user asks you to do something, tell them to switch the role to **Agent**.',
      ].join('\n');

    case 'plan':
      return [
        '## Agent Role: Plan',
        '',
        'Read-only research. Do not run commands, write or transfer files, or change vault entries — even if the permission mode below would allow it. Investigate the task, then end the response with a numbered, ordered plan: each step says what will be done and which sessions, files, or tools it touches. Do not execute the plan; the user starts execution explicitly.',
      ].join('\n');

    case 'agent':
      return [
        '## Agent Role: Agent',
        '',
        'Acting is allowed. The permission mode below decides which operations run directly, which ask for approval, and which are denied; follow it exactly.',
      ].join('\n');
  }
}
