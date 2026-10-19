import assert from 'node:assert/strict';
import test from 'node:test';

import { isSubagentToolName, isTodoToolName, parseTodoToolPayload } from './externalAgentSignals';

test('isTodoToolName recognises Netcatty and external todo tools', () => {
  for (const name of ['manage_todo_list', 'todo_write', 'TodoWrite', 'update_plan']) {
    assert.equal(isTodoToolName(name), true, name);
  }
  for (const name of ['bash', 'terminal_execute', 'read', '', undefined]) {
    assert.equal(isTodoToolName(name), false, String(name));
  }
});

test('parseTodoToolPayload normalises Netcatty manage_todo_list', () => {
  const todos = parseTodoToolPayload('manage_todo_list', {
    todoList: [
      { id: 1, title: 'Inspect layout', status: 'completed' },
      { id: 2, title: 'Fix spacing', status: 'in-progress' },
      { id: 3, title: 'Verify in app', status: 'not-started' },
    ],
  });
  assert.deepEqual(todos, [
    { id: 1, title: 'Inspect layout', status: 'completed' },
    { id: 2, title: 'Fix spacing', status: 'in-progress' },
    { id: 3, title: 'Verify in app', status: 'not-started' },
  ]);
});

test('parseTodoToolPayload normalises Claude Code todo_write', () => {
  const todos = parseTodoToolPayload('todo_write', {
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading' },
      { content: 'Patch it', status: 'in_progress', activeForm: 'Patching' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
  });
  assert.deepEqual(todos?.map((todo) => todo.status), ['completed', 'in-progress', 'not-started']);
  assert.deepEqual(todos?.map((todo) => todo.title), ['Read the code', 'Patch it', 'Ship']);
  assert.deepEqual(todos?.map((todo) => todo.id), [1, 2, 3]);
});

test('parseTodoToolPayload normalises Codex update_plan and JSON-string args', () => {
  const payload = JSON.stringify({
    plan: [
      { step: 'Investigate', status: 'completed' },
      { step: 'Implement', status: 'in_progress' },
    ],
  });
  const todos = parseTodoToolPayload('update_plan', payload);
  assert.deepEqual(todos, [
    { id: 1, title: 'Investigate', status: 'completed' },
    { id: 2, title: 'Implement', status: 'in-progress' },
  ]);
});

test('parseTodoToolPayload ignores non-todo tools and empty payloads', () => {
  assert.equal(parseTodoToolPayload('bash', { todoList: [{ id: 1, title: 'x', status: 'completed' }] }), null);
  assert.equal(parseTodoToolPayload('todo_write', { todos: [] }), null);
  assert.equal(parseTodoToolPayload('todo_write', { todos: [{ status: 'pending' }] }), null);
  assert.equal(parseTodoToolPayload('todo_write', undefined), null);
  assert.equal(parseTodoToolPayload('todo_write', 'not json'), null);
});

test('parseTodoToolPayload caps long titles and keeps explicit ids', () => {
  const longTitle = 'x'.repeat(400);
  const todos = parseTodoToolPayload('todo_write', {
    todos: [{ id: 7, content: longTitle, status: 'completed' }],
  });
  assert.equal(todos?.[0]?.id, 7);
  assert.equal(todos?.[0]?.title.length, 120);
});

test('isSubagentToolName recognises delegation tools and requires payload for generic "agent"', () => {
  assert.equal(isSubagentToolName('run_subagent'), true);
  assert.equal(isSubagentToolName('delegate_task'), true);
  assert.equal(isSubagentToolName('Task'), true);
  assert.equal(isSubagentToolName('agent'), false);
  assert.equal(isSubagentToolName('agent', { prompt: 'research this' }), true);
  assert.equal(isSubagentToolName('agent', { description: 'research' }), true);
  assert.equal(isSubagentToolName('bash'), false);
  assert.equal(isSubagentToolName(undefined), false);
});
