/**
 * Workflow definitions store: the localStorage-backed collection every UI
 * surface reads through `useWorkflows()`.
 *
 * Persisted entries are re-validated on read (see domain/workflow/serialize.ts)
 * so a corrupted or hand-edited value cannot crash the view.
 */

import { useSyncExternalStore } from 'react';
import { STORAGE_KEY_WORKFLOWS } from '@/infrastructure/config/storageKeys.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import { normalizeWorkflowList } from '@/domain/workflow/serialize.ts';
import { createEmptyWorkflow, type Workflow } from '@/domain/workflow/types.ts';

const MAX_WORKFLOWS = 200;

function readFromStorage(): Workflow[] {
  return normalizeWorkflowList(localStorageAdapter.read<unknown>(STORAGE_KEY_WORKFLOWS));
}

class WorkflowStore {
  private snapshot: readonly Workflow[] = readFromStorage();

  private listeners = new Set<() => void>();

  getSnapshot = (): readonly Workflow[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private commit(next: readonly Workflow[]): void {
    this.snapshot = next;
    localStorageAdapter.write(STORAGE_KEY_WORKFLOWS, next);
    for (const listener of this.listeners) listener();
  }

  getById(id: string | null | undefined): Workflow | undefined {
    if (!id) return undefined;
    return this.snapshot.find((workflow) => workflow.id === id);
  }

  create(name: string, now: number = Date.now()): Workflow {
    const workflow = createEmptyWorkflow(crypto.randomUUID(), now, name);
    this.commit([workflow, ...this.snapshot].slice(0, MAX_WORKFLOWS));
    return workflow;
  }

  /** Insert or replace, keeping the stored order stable on updates. */
  save(workflow: Workflow, now: number = Date.now()): Workflow {
    const next = { ...workflow, updatedAt: now };
    const exists = this.snapshot.some((entry) => entry.id === workflow.id);
    this.commit(
      exists
        ? this.snapshot.map((entry) => (entry.id === workflow.id ? next : entry))
        : [next, ...this.snapshot].slice(0, MAX_WORKFLOWS),
    );
    return next;
  }

  /**
   * Apply an edit. `revision` is bumped so a run record always refers to a
   * specific version of the graph.
   */
  mutate(
    id: string,
    updater: (workflow: Workflow) => Workflow,
    now: number = Date.now(),
  ): Workflow | null {
    const current = this.getById(id);
    if (!current) return null;
    const updated = updater(current);
    const next: Workflow = {
      ...updated,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
      revision: current.revision + 1,
    };
    this.commit(this.snapshot.map((entry) => (entry.id === id ? next : entry)));
    return next;
  }

  remove(id: string): void {
    this.commit(this.snapshot.filter((workflow) => workflow.id !== id));
  }

  duplicate(id: string, now: number = Date.now()): Workflow | null {
    const source = this.getById(id);
    if (!source) return null;
    const copy: Workflow = {
      ...structuredClone(source),
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.commit([copy, ...this.snapshot].slice(0, MAX_WORKFLOWS));
    return copy;
  }
}

export const workflowStore = new WorkflowStore();

export function useWorkflows(): readonly Workflow[] {
  return useSyncExternalStore(
    workflowStore.subscribe,
    workflowStore.getSnapshot,
    workflowStore.getSnapshot,
  );
}
