/**
 * Bridges the editor UI to the runner: validates first, wires the SSH executor
 * to the vault, and keeps `workflowRunStore` up to date while a run is live.
 */

import { useCallback, useRef, useState } from 'react';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '@/domain/models';
import type { NodeRunResult, Workflow, WorkflowNode, WorkflowRun } from '@/domain/workflow/types.ts';
import { hasBlockingIssues, validateWorkflow, type WorkflowIssue } from '@/domain/workflow/validate.ts';
import { runWorkflow } from './workflowRunner.ts';
import { workflowRunStore } from './workflowRunStore.ts';
import { createWorkflowExecutor } from './workflowExecutor.ts';
import type { WorkflowSessionRef } from './workflowSessionExecutor.ts';

export interface UseWorkflowRunnerParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  terminalSettings?: Pick<TerminalSettings, 'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'>;
  /** Open terminal sessions; the session channel (telnet/serial/jump chain) needs them. */
  sessions?: readonly WorkflowSessionRef[];
  /** Destructive-command patterns from AI settings; matching nodes warn. */
  blockedPatterns?: readonly string[];
  confirm?: (request: { node: WorkflowNode; message: string }) => Promise<boolean>;
}

export type WorkflowRunAttempt =
  | { ok: true; run: WorkflowRun; issues: WorkflowIssue[] }
  | { ok: false; issues: WorkflowIssue[] };

export interface UseWorkflowRunnerResult {
  run: (
    workflow: Workflow,
    options?: { previousResults?: Record<string, NodeRunResult> },
  ) => Promise<WorkflowRunAttempt>;
  stop: () => void;
  running: boolean;
}

export function useWorkflowRunner(params: UseWorkflowRunnerParams): UseWorkflowRunnerResult {
  // Read the latest vault snapshot at run time without re-creating `run` on
  // every vault change (the canvas would otherwise remount mid-drag).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [running, setRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async (
    workflow: Workflow,
    options?: { previousResults?: Record<string, NodeRunResult> },
  ): Promise<WorkflowRunAttempt> => {
    const current = paramsRef.current;
    const issues = validateWorkflow(workflow, {
      hosts: current.hosts,
      blockedPatterns: current.blockedPatterns,
    });
    if (hasBlockingIssues(issues)) {
      return { ok: false, issues };
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    workflowRunStore.startRun({
      runId,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      workflowName: workflow.name,
      status: 'running',
      startedAt,
      nodeRuns: Object.fromEntries(
        workflow.nodes.map((node) => [node.id, { nodeId: node.id, status: 'pending' as const, hosts: [] }]),
      ),
      log: [],
    });

    try {
      const executor = createWorkflowExecutor({
        hosts: current.hosts,
        keys: current.keys,
        identities: current.identities,
        knownHosts: current.knownHosts,
        terminalSettings: current.terminalSettings,
        sessions: current.sessions,
        confirm: current.confirm,
      });
      const finalRun = await runWorkflow({
        workflow,
        hosts: current.hosts,
        executor,
        runId,
        previousResults: options?.previousResults,
        signal: controller.signal,
        onUpdate: (snapshot) => workflowRunStore.updateRun(snapshot),
      });
      workflowRunStore.finishRun(finalRun);
      return { ok: true, run: finalRun, issues };
    } finally {
      controllerRef.current = null;
      setRunning(false);
    }
  }, []);

  const stop = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  return { run, stop, running };
}
