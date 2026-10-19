import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentTodoPanel from './AgentTodoPanel';
import type { AgentTodo } from '../../infrastructure/ai/harness/agentTodo';

const MESSAGES: Record<string, string> = {
  'ai.todo.title': 'Task list',
  'ai.todo.empty': 'No tasks yet',
  'ai.todo.progress': '{done}/{total} done',
};

const t = (
  key: string,
  values?: Record<string, string | number | boolean | null | undefined>,
): string => {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    values[name] === null || values[name] === undefined ? '' : String(values[name]),
  );
};

test('renders the title, progress, and each todo status', () => {
  const todos: AgentTodo[] = [
    { id: 1, title: 'Inspect the workspace', status: 'completed' },
    { id: 2, title: 'Patch the handler', status: 'in-progress' },
    { id: 3, title: 'Run scoped tests', status: 'not-started' },
  ];

  const html = renderToStaticMarkup(<AgentTodoPanel todos={todos} t={t} />);

  assert.match(html, /Task list/);
  assert.match(html, /1\/3 done/);
  assert.match(html, /Inspect the workspace/);
  assert.match(html, /Patch the handler/);
  assert.match(html, /Run scoped tests/);
  assert.match(html, /line-through/, 'completed items are struck through');
  assert.match(html, /animate-spin/, 'the in-progress item shows a spinner');
  assert.match(html, /bg-primary\/10/, 'the in-progress row is highlighted');
});

test('renders nothing when the list is empty', () => {
  const html = renderToStaticMarkup(<AgentTodoPanel todos={[]} t={t} />);
  assert.equal(html, '');
});
