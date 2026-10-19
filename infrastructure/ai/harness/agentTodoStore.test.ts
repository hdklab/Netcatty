import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAgentTodo,
  getAgentTodo,
  setAgentTodo,
  subscribeAgentTodo,
} from './agentTodoStore';

const SESSION_A = 'chat-session-a';
const SESSION_B = 'chat-session-b';

describe('agentTodoStore', () => {
  it('keeps one list per chat session', () => {
    clearAgentTodo(SESSION_A);
    clearAgentTodo(SESSION_B);

    setAgentTodo(SESSION_A, [{ id: 1, title: 'Task A', status: 'in-progress' }]);
    setAgentTodo(SESSION_B, [{ id: 1, title: 'Task B', status: 'not-started' }]);

    assert.deepEqual(getAgentTodo(SESSION_A), [{ id: 1, title: 'Task A', status: 'in-progress' }]);
    assert.deepEqual(getAgentTodo(SESSION_B), [{ id: 1, title: 'Task B', status: 'not-started' }]);

    clearAgentTodo(SESSION_A);
    clearAgentTodo(SESSION_B);
  });

  it('returns a stable empty list for unknown or missing sessions', () => {
    const first = getAgentTodo('never-seen');
    const second = getAgentTodo(undefined);
    assert.equal(first, second);
    assert.deepEqual(first, []);
  });

  it('replaces the list instead of appending', () => {
    setAgentTodo(SESSION_A, [{ id: 1, title: 'Task A', status: 'not-started' }]);
    setAgentTodo(SESSION_A, [{ id: 1, title: 'Task A', status: 'completed' }]);
    assert.deepEqual(getAgentTodo(SESSION_A), [{ id: 1, title: 'Task A', status: 'completed' }]);
    clearAgentTodo(SESSION_A);
  });

  it('clears on an empty list and notifies subscribers on set and clear', () => {
    clearAgentTodo(SESSION_A);
    let notifications = 0;
    const unsubscribe = subscribeAgentTodo(() => {
      notifications += 1;
    });

    setAgentTodo(SESSION_A, [{ id: 1, title: 'Task A', status: 'not-started' }]);
    assert.equal(notifications, 1);

    setAgentTodo(SESSION_A, []);
    assert.equal(notifications, 2);
    assert.deepEqual(getAgentTodo(SESSION_A), []);

    clearAgentTodo(SESSION_A);
    assert.equal(notifications, 2, 'clearing an absent entry does not notify');

    unsubscribe();
    setAgentTodo(SESSION_A, [{ id: 2, title: 'Task B', status: 'not-started' }]);
    assert.equal(notifications, 2, 'unsubscribed listeners are not called');
    clearAgentTodo(SESSION_A);
  });

  it('bounds the number of retained sessions, dropping the oldest first', () => {
    const sessionIds = Array.from({ length: 101 }, (_, index) => `bounded-session-${index}`);
    for (const sessionId of sessionIds) {
      setAgentTodo(sessionId, [{ id: 1, title: 'Task', status: 'not-started' }]);
    }

    assert.deepEqual(getAgentTodo(sessionIds[0]), []);
    assert.equal(getAgentTodo(sessionIds[1]).length, 1);
    assert.equal(getAgentTodo(sessionIds[100]).length, 1);

    for (const sessionId of sessionIds) {
      clearAgentTodo(sessionId);
    }
  });
});
