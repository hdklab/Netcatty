import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TODO_MAX_ITEMS,
  AGENT_TODO_MAX_TITLE_LENGTH,
  validateTodoList,
} from './agentTodo';

describe('validateTodoList', () => {
  it('accepts a valid list and trims titles', () => {
    const result = validateTodoList({
      todoList: [
        { id: 1, title: '  Inspect the workspace  ', status: 'completed' },
        { id: 2, title: 'Patch the handler', status: 'in-progress' },
        { id: 3, title: 'Run scoped tests', status: 'not-started' },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.todoList, [
      { id: 1, title: 'Inspect the workspace', status: 'completed' },
      { id: 2, title: 'Patch the handler', status: 'in-progress' },
      { id: 3, title: 'Run scoped tests', status: 'not-started' },
    ]);
  });

  it('rejects non-object input and a missing or non-array todoList', () => {
    for (const input of [null, undefined, 'todo', 42, [], [{ id: 1 }]]) {
      const result = validateTodoList(input);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    }
    assert.match(
      (validateTodoList({}) as { error: string }).error,
      /todoList/,
    );
    assert.match(
      (validateTodoList({ todoList: 'nope' }) as { error: string }).error,
      /array/,
    );
  });

  it('enforces the item-count bounds', () => {
    const empty = validateTodoList({ todoList: [] });
    assert.equal(empty.ok, false);
    assert.match((empty as { error: string }).error, /between 1 and 50/);

    const tooMany = validateTodoList({
      todoList: Array.from({ length: AGENT_TODO_MAX_ITEMS + 1 }, (_, index) => ({
        id: index + 1,
        title: `Task ${index + 1}`,
        status: 'not-started',
      })),
    });
    assert.equal(tooMany.ok, false);
    assert.match((tooMany as { error: string }).error, /between 1 and 50/);

    const atLimit = validateTodoList({
      todoList: Array.from({ length: AGENT_TODO_MAX_ITEMS }, (_, index) => ({
        id: index,
        title: `Task ${index + 1}`,
        status: 'not-started',
      })),
    });
    assert.equal(atLimit.ok, true);
  });

  it('rejects duplicate ids', () => {
    const result = validateTodoList({
      todoList: [
        { id: 7, title: 'First task', status: 'not-started' },
        { id: 7, title: 'Second task', status: 'not-started' },
      ],
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /repeats id 7/);
  });

  it('rejects more than one in-progress item', () => {
    const result = validateTodoList({
      todoList: [
        { id: 1, title: 'First task', status: 'in-progress' },
        { id: 2, title: 'Second task', status: 'in-progress' },
      ],
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /one item may be "in-progress"/);
  });

  it('rejects invalid ids, titles, and statuses with positional errors', () => {
    const badId = validateTodoList({
      todoList: [
        { id: 1, title: 'First task', status: 'not-started' },
        { id: 1.5, title: 'Second task', status: 'not-started' },
      ],
    });
    assert.equal(badId.ok, false);
    assert.match((badId as { error: string }).error, /Item 2.*"id"/);

    const badTitle = validateTodoList({
      todoList: [{ id: 1, title: '   ', status: 'not-started' }],
    });
    assert.equal(badTitle.ok, false);
    assert.match((badTitle as { error: string }).error, /empty "title"/);

    const longTitle = validateTodoList({
      todoList: [{ id: 1, title: 'x'.repeat(AGENT_TODO_MAX_TITLE_LENGTH + 1), status: 'not-started' }],
    });
    assert.equal(longTitle.ok, false);
    assert.match((longTitle as { error: string }).error, /keep it at or under 120 characters/);

    const badStatus = validateTodoList({
      todoList: [{ id: 1, title: 'First task', status: 'done' }],
    });
    assert.equal(badStatus.ok, false);
    assert.match((badStatus as { error: string }).error, /not-started, in-progress, completed/);

    const badItem = validateTodoList({ todoList: ['not an item'] });
    assert.equal(badItem.ok, false);
    assert.match((badItem as { error: string }).error, /Item 1 must be an object/);
  });
});
