/**
 * Run state for workflow executions: the in-flight run plus a small local
 * history. Kept out of the workflow definition so edits never touch run data.
 */

import { useSyncExternalStore } from 'react';
import { STORAGE_KEY_WORKFLOW_RUNS } from '@/infrastructure/config/storageKeys.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import type { WorkflowRun, WorkflowRunLogEntry } from '@/domain/workflow/types.ts';

const MAX_RUNS = 25;
const MAX_LOG_ENTRIES = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRun(raw: unknown): WorkflowRun | null {
  if (!isRecord(raw)) return null;
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  const workflowId = typeof raw.workflowId === 'string' ? raw.workflowId : '';
  if (!runId || !workflowId) return null;
  const status = raw.status === 'failed' || raw.status === 'cancelled' || raw.status === 'success'
    ? raw.status
    : 'success';
  const nodeRuns = isRecord(raw.nodeRuns)
    ? (raw.nodeRuns as WorkflowRun['nodeRuns'])
    : {};
  const log: WorkflowRunLogEntry[] = Array.isArray(raw.log)
    ? raw.log.filter((entry): entry is WorkflowRunLogEntry => (
      isRecord(entry) && typeof entry.message === 'string' && typeof entry.at === 'number'
    ))
    : [];
  return {
    runId,
    workflowId,
    workflowRevision: typeof raw.workflowRevision === 'number' ? raw.workflowRevision : 1,
    workflowName: typeof raw.workflowName === 'string' ? raw.workflowName : '',
    status,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : undefined,
    nodeRuns,
    log: log.slice(-MAX_LOG_ENTRIES),
  };
}

function readFromStorage(): WorkflowRun[] {
  const raw = localStorageAdapter.read<unknown>(STORAGE_KEY_WORKFLOW_RUNS);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRun)
    .filter((run): run is WorkflowRun => run !== null)
    .slice(0, MAX_RUNS);
}

class WorkflowRunStore {
  private active: WorkflowRun | null = null;

  private history: readonly WorkflowRun[] = readFromStorage();

  private listeners = new Set<() => void>();

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getActive = (): WorkflowRun | null => this.active;

  getHistory = (): readonly WorkflowRun[] => this.history;

  startRun(run: WorkflowRun): void {
    this.active = run;
    this.notify();
  }

  /** Ignores updates from a run that was already replaced or finished. */
  updateRun(run: WorkflowRun): void {
    if (!this.active || this.active.runId !== run.runId) return;
    this.active = run;
    this.notify();
  }

  finishRun(run: WorkflowRun): void {
    if (this.active?.runId === run.runId) this.active = null;
    const trimmed: WorkflowRun = { ...run, log: run.log.slice(-MAX_LOG_ENTRIES) };
    this.history = [trimmed, ...this.history.filter((entry) => entry.runId !== run.runId)].slice(0, MAX_RUNS);
    localStorageAdapter.write(STORAGE_KEY_WORKFLOW_RUNS, this.history);
    this.notify();
  }

  getRunsForWorkflow(workflowId: string): readonly WorkflowRun[] {
    return this.history.filter((run) => run.workflowId === workflowId);
  }

  clearHistory(workflowId?: string): void {
    this.history = workflowId
      ? this.history.filter((run) => run.workflowId !== workflowId)
      : [];
    localStorageAdapter.write(STORAGE_KEY_WORKFLOW_RUNS, this.history);
    this.notify();
  }
}

export const workflowRunStore = new WorkflowRunStore();

export function useActiveWorkflowRun(): WorkflowRun | null {
  return useSyncExternalStore(workflowRunStore.subscribe, workflowRunStore.getActive, workflowRunStore.getActive);
}

export function useWorkflowRunHistory(): readonly WorkflowRun[] {
  return useSyncExternalStore(
    workflowRunStore.subscribe,
    workflowRunStore.getHistory,
    workflowRunStore.getHistory,
  );
}
