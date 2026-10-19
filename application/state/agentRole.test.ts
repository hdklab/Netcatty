import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEY_AI_AGENT_ROLE } from '../../infrastructure/config/storageKeys';
import {
  AGENT_ROLES,
  DEFAULT_AGENT_ROLE,
  PLAN_EXECUTION_CONTINUATION_MESSAGE,
  getAgentRole,
  isAgentRole,
  loadAgentRole,
  normalizeAgentRole,
  resolveEffectivePermissionMode,
  resultingSystemPromptRoleSection,
  saveAgentRole,
  subscribeAgentRole,
} from './agentRole';

/**
 * The scoped suites run under plain Node, where `localStorage` is either absent
 * or a stub without storage methods. Install a real in-memory implementation so
 * the persistence assertions exercise the adapter instead of its fallback.
 */
function installMemoryStorage(): void {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

installMemoryStorage();

test('defaults to the agent role and rejects unknown values', () => {
  globalThis.localStorage.removeItem(STORAGE_KEY_AI_AGENT_ROLE);
  assert.equal(loadAgentRole(), 'agent');
  assert.equal(DEFAULT_AGENT_ROLE, 'agent');
  assert.equal(normalizeAgentRole('plan'), 'plan');
  assert.equal(normalizeAgentRole('research'), 'agent');
  assert.equal(normalizeAgentRole(null), 'agent');
  assert.equal(normalizeAgentRole(undefined), 'agent');
  assert.equal(isAgentRole('ask'), true);
  assert.equal(isAgentRole('Ask'), false);
});

test('persists every role and reads it back through the storage adapter', () => {
  for (const role of AGENT_ROLES) {
    saveAgentRole(role);
    assert.equal(loadAgentRole(), role);
    assert.equal(getAgentRole(), role);
    assert.equal(globalThis.localStorage.getItem(STORAGE_KEY_AI_AGENT_ROLE), role);
  }

  globalThis.localStorage.setItem(STORAGE_KEY_AI_AGENT_ROLE, 'bogus');
  assert.equal(loadAgentRole(), 'agent', 'an unknown stored value must not leak through');
});

test('save notifies subscribers only when the role actually changes', () => {
  saveAgentRole('agent');
  let notifications = 0;
  const unsubscribe = subscribeAgentRole(() => {
    notifications += 1;
  });

  saveAgentRole('agent');
  assert.equal(notifications, 0, 'same role must not re-notify');

  saveAgentRole('plan');
  assert.equal(notifications, 1);

  saveAgentRole('ask');
  assert.equal(notifications, 2);

  unsubscribe();
  saveAgentRole('agent');
  assert.equal(notifications, 2, 'unsubscribed listeners must not fire');
});

test('ask and plan force the observer permission mode without touching other modes', () => {
  assert.equal(resolveEffectivePermissionMode('ask', 'auto'), 'observer');
  assert.equal(resolveEffectivePermissionMode('ask', 'confirm'), 'observer');
  assert.equal(resolveEffectivePermissionMode('plan', 'auto'), 'observer');
  assert.equal(resolveEffectivePermissionMode('plan', 'confirm'), 'observer');
  assert.equal(resolveEffectivePermissionMode('agent', 'auto'), 'auto');
  assert.equal(resolveEffectivePermissionMode('agent', 'confirm'), 'confirm');
  assert.equal(resolveEffectivePermissionMode('agent', 'observer'), 'observer');
});

test('the ask role section forbids actions and points at the Agent role', () => {
  const section = resultingSystemPromptRoleSection('ask');
  assert.match(section, /## Agent Role: Ask/);
  assert.match(section, /read-only/i);
  assert.match(section, /do not run commands/i);
  assert.match(section, /switch the role to \*\*Agent\*\*/);
});

test('the plan role section requires a numbered plan and forbids execution', () => {
  const section = resultingSystemPromptRoleSection('plan');
  assert.match(section, /## Agent Role: Plan/);
  assert.match(section, /read-only/i);
  assert.match(section, /numbered, ordered plan/i);
  assert.match(section, /do not execute the plan/i);
});

test('the agent role section defers to the permission mode', () => {
  const section = resultingSystemPromptRoleSection('agent');
  assert.match(section, /## Agent Role: Agent/);
  assert.match(section, /permission mode below decides/i);
  assert.doesNotMatch(section, /read-only/i);
});

test('the plan continuation message is a non-empty pointer at the plan', () => {
  assert.ok(PLAN_EXECUTION_CONTINUATION_MESSAGE.trim().length > 0);
  assert.match(PLAN_EXECUTION_CONTINUATION_MESSAGE, /plan/i);
});

test('saving a role never rewrites the stored permission mode', async () => {
  const { STORAGE_KEY_AI_PERMISSION_MODE } = await import('../../infrastructure/config/storageKeys');
  globalThis.localStorage.setItem(STORAGE_KEY_AI_PERMISSION_MODE, 'auto');
  saveAgentRole('plan');
  assert.equal(
    globalThis.localStorage.getItem(STORAGE_KEY_AI_PERMISSION_MODE),
    'auto',
    'ask/plan are per-turn overrides; the user setting must survive',
  );
  saveAgentRole('agent');
});

test('the Catty turn context resolves the role into the observer permission mode', async () => {
  const { createInitialCattyRuntimeContext } = await import(
    '../../infrastructure/ai/harness/cattyRuntimeContext'
  );
  const input = {
    chatSessionId: 'chat-1',
    turnId: 'turn-1',
    permissionMode: 'auto' as const,
    scopeType: 'terminal' as const,
  };

  saveAgentRole('ask');
  assert.equal(createInitialCattyRuntimeContext(input).permissionMode, 'observer');

  saveAgentRole('plan');
  assert.equal(createInitialCattyRuntimeContext(input).permissionMode, 'observer');

  saveAgentRole('agent');
  assert.equal(
    createInitialCattyRuntimeContext(input).permissionMode,
    'auto',
    'agent keeps the permission mode the caller passed in',
  );

  assert.equal(
    createInitialCattyRuntimeContext({ ...input, permissionMode: 'confirm' }).permissionMode,
    'confirm',
  );
});
