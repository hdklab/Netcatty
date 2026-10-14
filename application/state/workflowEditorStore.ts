/**
 * Editor state for the workflow canvas: which workflow is open, which node is
 * selected, and the undo/redo stacks.
 *
 * Edits always go through `workflowStore`, which persists them; the stacks here
 * hold pre-edit snapshots so Ctrl+Z restores the previous graph.
 */

import { useSyncExternalStore } from 'react';
import type { Workflow } from '@/domain/workflow/types.ts';
import { workflowStore } from './workflowStore.ts';

const MAX_HISTORY = 50;

export interface WorkflowEditorState {
  workflowId: string | null;
  selectedNodeId: string | null;
  past: readonly Workflow[];
  future: readonly Workflow[];
}

const EMPTY_STATE: WorkflowEditorState = {
  workflowId: null,
  selectedNodeId: null,
  past: [],
  future: [],
};

class WorkflowEditorStore {
  private state: WorkflowEditorState = EMPTY_STATE;

  private listeners = new Set<() => void>();

  getSnapshot = (): WorkflowEditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<WorkflowEditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  open(workflowId: string): void {
    if (this.state.workflowId === workflowId) return;
    this.setState({ workflowId, selectedNodeId: null, past: [], future: [] });
  }

  close(): void {
    this.setState(EMPTY_STATE);
  }

  selectNode(nodeId: string | null): void {
    if (this.state.selectedNodeId === nodeId) return;
    this.setState({ selectedNodeId: nodeId });
  }

  /**
   * Apply an edit to the open workflow. Returns the saved workflow, or null
   * when nothing is open.
   */
  edit(updater: (workflow: Workflow) => Workflow): Workflow | null {
    const { workflowId } = this.state;
    if (!workflowId) return null;
    const before = workflowStore.getById(workflowId);
    if (!before) return null;
    const next = workflowStore.mutate(workflowId, updater);
    if (!next) return null;
    this.setState({ past: [...this.state.past, before].slice(-MAX_HISTORY), future: [] });
    return next;
  }

  undo(): void {
    const { workflowId, past, future } = this.state;
    if (!workflowId || past.length === 0) return;
    const previous = past[past.length - 1] as Workflow;
    const current = workflowStore.getById(workflowId);
    const restored = workflowStore.mutate(workflowId, () => previous);
    if (!restored) return;
    this.setState({
      past: past.slice(0, -1),
      future: current ? [current, ...future].slice(0, MAX_HISTORY) : future,
    });
  }

  redo(): void {
    const { workflowId, past, future } = this.state;
    if (!workflowId || future.length === 0) return;
    const next = future[0] as Workflow;
    const current = workflowStore.getById(workflowId);
    const restored = workflowStore.mutate(workflowId, () => next);
    if (!restored) return;
    this.setState({
      past: current ? [...past, current].slice(-MAX_HISTORY) : past,
      future: future.slice(1),
    });
  }

  /** Forget the history for the open workflow (used after a run/import). */
  resetHistory(): void {
    this.setState({ past: [], future: [] });
  }
}

export const workflowEditorStore = new WorkflowEditorStore();

export function useWorkflowEditorState(): WorkflowEditorState {
  return useSyncExternalStore(
    workflowEditorStore.subscribe,
    workflowEditorStore.getSnapshot,
    workflowEditorStore.getSnapshot,
  );
}
