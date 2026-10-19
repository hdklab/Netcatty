/**
 * Agent todo list model and validation.
 *
 * The Catty `manage_todo_list` tool accepts the complete todo array on every
 * call (never a delta). This module owns the pure rules: shape, size, unique
 * ids, title bounds, and the "at most one item in progress" invariant.
 */

export const AGENT_TODO_STATUSES = ['not-started', 'in-progress', 'completed'] as const;

export type AgentTodoStatus = (typeof AGENT_TODO_STATUSES)[number];

export interface AgentTodo {
  id: number;
  title: string;
  status: AgentTodoStatus;
}

export const AGENT_TODO_MIN_ITEMS = 1;
export const AGENT_TODO_MAX_ITEMS = 50;
export const AGENT_TODO_MAX_TITLE_LENGTH = 120;

export type AgentTodoValidationResult =
  | { ok: true; todoList: AgentTodo[] }
  | { ok: false; error: string };

const AGENT_TODO_STATUS_SET: ReadonlySet<string> = new Set(AGENT_TODO_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(error: string): AgentTodoValidationResult {
  return { ok: false, error };
}

/**
 * Validate the raw `manage_todo_list` arguments.
 *
 * Accepts the tool arguments object (`{ todoList: [...] }`) and never throws:
 * malformed input always comes back as `{ ok: false, error }` so the model can
 * correct itself in the next tool call.
 */
export function validateTodoList(input: unknown): AgentTodoValidationResult {
  if (!isRecord(input)) {
    return invalid('Expected an object with a "todoList" array.');
  }

  const rawList = input.todoList;
  if (!Array.isArray(rawList)) {
    return invalid('"todoList" is required and must be an array.');
  }
  if (rawList.length < AGENT_TODO_MIN_ITEMS || rawList.length > AGENT_TODO_MAX_ITEMS) {
    return invalid(
      `"todoList" must contain between ${AGENT_TODO_MIN_ITEMS} and ${AGENT_TODO_MAX_ITEMS} items (received ${rawList.length}).`,
    );
  }

  const todoList: AgentTodo[] = [];
  const seenIds = new Set<number>();
  let inProgressCount = 0;

  for (let index = 0; index < rawList.length; index += 1) {
    const rawItem: unknown = rawList[index];
    const position = index + 1;

    if (!isRecord(rawItem)) {
      return invalid(`Item ${position} must be an object with "id", "title", and "status".`);
    }

    const { id, title, status } = rawItem;

    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      return invalid(`Item ${position} has an invalid "id"; expected a unique non-negative integer.`);
    }
    if (seenIds.has(id)) {
      return invalid(`Item ${position} repeats id ${id}; ids must be unique.`);
    }
    seenIds.add(id);

    if (typeof title !== 'string') {
      return invalid(`Item ${position} has an invalid "title"; expected a non-empty string.`);
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      return invalid(`Item ${position} has an empty "title"; use a short action-oriented label.`);
    }
    if (trimmedTitle.length > AGENT_TODO_MAX_TITLE_LENGTH) {
      return invalid(
        `Item ${position} has a ${trimmedTitle.length}-character "title"; keep it at or under ${AGENT_TODO_MAX_TITLE_LENGTH} characters.`,
      );
    }

    if (typeof status !== 'string' || !AGENT_TODO_STATUS_SET.has(status)) {
      return invalid(
        `Item ${position} has an invalid "status"; expected one of: ${AGENT_TODO_STATUSES.join(', ')}.`,
      );
    }
    if (status === 'in-progress') {
      inProgressCount += 1;
      if (inProgressCount > 1) {
        return invalid('Only one item may be "in-progress" at a time.');
      }
    }

    todoList.push({ id, title: trimmedTitle, status: status as AgentTodoStatus });
  }

  return { ok: true, todoList };
}
