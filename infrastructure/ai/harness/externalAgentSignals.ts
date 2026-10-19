/**
 * Signals emitted by *external* agent CLIs (Hermes, dsh, Claude Code, Codex …)
 * that map onto the VS Code-style planning surfaces Netcatty renders.
 *
 * Catty publishes its todo list through `manage_todo_list` (see
 * `agentTodoStore.ts`). External agents cannot be handed Netcatty tools, but
 * they emit their own todo / delegation tool calls, which arrive as ordinary
 * tool calls in the message stream. Recognising those names lets the same
 * panel and the same subagent card work for every agent instead of Catty only.
 *
 * Everything here is pure: no store access, no React.
 */

import type { AgentTodo, AgentTodoStatus } from './agentTodo';

type ToolArgs = Record<string, unknown> | undefined;

/** Tool names that mean "here is my complete task list". */
const TODO_TOOL_NAMES = new Set([
  'manage_todo_list',
  'todo_write',
  'TodoWrite',
  'todo',
  'update_plan',
  'todos',
]);

/** Tool names that mean "I delegated this to a subagent". */
const SUBAGENT_TOOL_NAMES = new Set([
  'run_subagent',
  'delegate_task',
  'Task',
  'task',
  'task_agent',
  'spawn_agent',
]);

export function isTodoToolName(name: string | undefined | null): boolean {
  return typeof name === 'string' && TODO_TOOL_NAMES.has(name.trim());
}

export function isSubagentToolName(name: string | undefined | null, args?: ToolArgs): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (SUBAGENT_TOOL_NAMES.has(trimmed)) return true;
  // Bare `agent` is too ambiguous to trust by name alone; require the payload
  // to look like a delegation (a prompt/goal/task string).
  if (trimmed === 'agent') {
    return typeof args?.prompt === 'string'
      || typeof args?.goal === 'string'
      || typeof args?.description === 'string';
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return asRecord(parsed);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.items)) return record.items;
  return null;
}

const STATUS_MAP: Record<string, AgentTodoStatus> = {
  'not-started': 'not-started',
  'not_started': 'not-started',
  'pending': 'not-started',
  'todo': 'not-started',
  'open': 'not-started',
  'in-progress': 'in-progress',
  'in_progress': 'in-progress',
  'inProgress': 'in-progress',
  'active': 'in-progress',
  'doing': 'in-progress',
  'completed': 'completed',
  'complete': 'completed',
  'done': 'completed',
  'closed': 'completed',
};

function normalizeStatus(value: unknown): AgentTodoStatus {
  return typeof value === 'string' ? STATUS_MAP[value.trim()] ?? 'not-started' : 'not-started';
}

function readText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readId(source: Record<string, unknown>, fallback: number): number {
  const value = source.id ?? source.index;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Normalise a todo payload from any supported shape into `AgentTodo[]`.
 * Returns null when the call is not a todo tool or carries no usable items.
 *
 * Supported shapes:
 * - Netcatty `manage_todo_list`: `{ todoList: [{ id, title, status }] }`
 * - Claude Code `todo_write` / `TodoWrite`: `{ todos: [{ content|activeForm, status }] }`
 * - Codex `update_plan`: `{ plan: [{ step, status }] }`
 */
export function parseTodoToolPayload(name: string | undefined | null, args: unknown): AgentTodo[] | null {
  if (!isTodoToolName(name)) return null;
  const record = asRecord(args);
  if (!record) return null;

  const items = asArray(record.todoList)
    ?? asArray(record.todos)
    ?? asArray(record.plan)
    ?? asArray(record.items);
  if (!items || items.length === 0) return null;

  const todos: AgentTodo[] = [];
  items.forEach((entry, index) => {
    const item = asRecord(entry);
    if (!item) return;
    const title = readText(item, ['title', 'content', 'step', 'text', 'task', 'label']);
    if (!title) return;
    todos.push({
      id: readId(item, index + 1),
      title: title.slice(0, 120),
      status: normalizeStatus(item.status ?? item.state),
    });
  });

  return todos.length > 0 ? todos : null;
}
