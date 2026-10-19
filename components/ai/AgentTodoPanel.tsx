/**
 * AgentTodoPanel - compact task list shown above the AI composer.
 *
 * Rendered from `manage_todo_list` results for the active chat session. Pure
 * presentation: the store subscription lives in the sidebar host, so this
 * component only receives the list and the translator.
 */

import { Check, ChevronDown, ChevronRight, Circle, ListChecks, Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import type { AgentTodo } from '../../infrastructure/ai/harness/agentTodo';
import { cn } from '../../lib/utils';

export interface AgentTodoPanelProps {
  todos: AgentTodo[];
  t: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
}

const AgentTodoPanel: React.FC<AgentTodoPanelProps> = ({ todos, t }) => {
  const [expanded, setExpanded] = useState(true);

  // Turn-scoped state: no list yet means no chrome above the composer.
  if (todos.length === 0) {
    return null;
  }

  const done = todos.filter((todo) => todo.status === 'completed').length;

  return (
    <section
      aria-label={t('ai.todo.title')}
      className="mx-3 mb-1.5 overflow-hidden rounded-md border border-border/60 bg-secondary/40 text-xs"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary/60"
      >
        <ListChecks size={12} className="shrink-0 text-muted-foreground/70" />
        <span className="font-medium text-foreground/80">{t('ai.todo.title')}</span>
        <span className="ml-auto tabular-nums text-[11px] text-muted-foreground/70">
          {t('ai.todo.progress', { done, total: todos.length })}
        </span>
        {expanded ? (
          <ChevronDown size={12} className="shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted-foreground/50" />
        )}
      </button>
      {expanded && (
        <div className="space-y-0.5 border-t border-border/60 px-1.5 py-1">
          {todos.length === 0 ? (
            <div className="px-1 py-0.5 text-muted-foreground/70">{t('ai.todo.empty')}</div>
          ) : (
            todos.map((todo, index) => (
              <div
                key={`${todo.id}-${index}`}
                className={cn(
                  'flex items-start gap-1.5 rounded px-1 py-0.5 leading-4',
                  todo.status === 'in-progress' && 'bg-primary/10 text-foreground',
                  todo.status === 'not-started' && 'text-muted-foreground',
                  todo.status === 'completed' && 'text-muted-foreground/60',
                )}
              >
                {todo.status === 'completed' ? (
                  <Check size={11} className="mt-0.5 shrink-0 text-emerald-500" />
                ) : todo.status === 'in-progress' ? (
                  <Loader2 size={11} className="mt-0.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle size={11} className="mt-0.5 shrink-0 text-muted-foreground/50" />
                )}
                <span
                  className={cn(
                    'min-w-0 break-words',
                    todo.status === 'in-progress' && 'font-medium',
                    todo.status === 'completed' && 'line-through',
                  )}
                >
                  {todo.title}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
};

export default AgentTodoPanel;
