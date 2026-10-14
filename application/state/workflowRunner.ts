/**
 * Workflow runner: drives the pure scheduler in domain/workflow/runPlan.ts and
 * calls an injected executor for the actual work.
 *
 * Everything that touches the outside world (SSH, timers, dialogs) arrives
 * through `WorkflowExecutor`, so the ordering, retry, branch and cancellation
 * semantics can be tested with a fake executor — see workflowRunner.test.ts.
 */

import type { Host } from '@/domain/models';
import { evaluateCommandOutcome } from '@/domain/workflow/commandOutcome.ts';
import { mapWithConcurrency } from '@/domain/workflow/concurrency.ts';
import { evaluateCondition } from '@/domain/workflow/conditions.ts';
import { collectDownstreamNodeIds, findBackEdges, restartTargetsFor } from '@/domain/workflow/loops.ts';
import { interpolateTemplate, type InterpolationContext } from '@/domain/workflow/expression.ts';
import {
  collectBusyHostIds,
  computeReadyNodes,
  isRunSettled,
  summarizeRun,
} from '@/domain/workflow/runPlan.ts';
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  DEFAULT_NODE_TIMEOUT_MS,
  type HostCommandNodeConfig,
  type HostRunResult,
  type NodeRunResult,
  type NodeRunStatus,
  type NodeSkipReason,
  type NodeState,
  type Workflow,
  type WorkflowNode,
  type WorkflowRun,
} from '@/domain/workflow/types.ts';
import { resolveNodeHosts } from '@/domain/workflow/validate.ts';

/** stdout/stderr kept per host in the run record. */
export const MAX_HOST_OUTPUT_CHARS = 64000;

export interface WorkflowCommandRequest {
  node: WorkflowNode;
  config: HostCommandNodeConfig;
  host: Host;
  /** Already interpolated. */
  command: string;
  timeoutMs: number;
  /** 1-based attempt number. */
  attempt: number;
  signal: AbortSignal;
}

export interface WorkflowCommandResult {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** Transport-level failure. */
  error?: string;
}

export interface WorkflowExecutor {
  runCommand(request: WorkflowCommandRequest): Promise<WorkflowCommandResult>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Resolve false to decline; a missing implementation counts as declined. */
  confirm?(request: { node: WorkflowNode; message: string }): Promise<boolean>;
}

export interface RunWorkflowParams {
  workflow: Workflow;
  hosts: Host[];
  executor: WorkflowExecutor;
  runId?: string;
  /** Injectable clock so tests are deterministic. */
  now?: () => number;
  /** Successful results from a previous run, reused instead of re-executing. */
  previousResults?: Record<string, NodeRunResult>;
  /** Called on every state change with an immutable snapshot. */
  onUpdate?: (run: WorkflowRun) => void;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function snapshotRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    nodeRuns: { ...run.nodeRuns },
    log: [...run.log],
  };
}

export async function runWorkflow(params: RunWorkflowParams): Promise<WorkflowRun> {
  const now = params.now ?? (() => Date.now());
  const workflow = params.workflow;
  const signal = params.signal ?? new AbortController().signal;
  const maxOutputChars = params.maxOutputChars ?? MAX_HOST_OUTPUT_CHARS;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

  const run: WorkflowRun = {
    runId: params.runId ?? (globalThis.crypto?.randomUUID?.() ?? `run-${now()}`),
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    workflowName: workflow.name,
    status: 'running',
    startedAt: now(),
    nodeRuns: {},
    log: [],
  };

  const log = (level: 'info' | 'warn' | 'error', message: string, nodeId?: string): void => {
    run.log.push({ at: now(), level, message, nodeId });
  };

  const states: Record<string, NodeState> = {};
  for (const node of workflow.nodes) {
    const previous = params.previousResults?.[node.id];
    if (previous && previous.status === 'success') {
      states[node.id] = { status: 'success', outputPort: previous.outputPort ?? 'main' };
      run.nodeRuns[node.id] = { ...previous };
      log('info', `Reused the previous result of "${node.name}"`, node.id);
      continue;
    }
    states[node.id] = { status: 'pending' };
    run.nodeRuns[node.id] = { nodeId: node.id, status: 'pending', hosts: [] };
  }

  const emit = (): void => {
    params.onUpdate?.(snapshotRun(run));
  };
  emit();

  const resolveHostIds = (node: WorkflowNode): string[] =>
    resolveNodeHosts(node, params.hosts).map((host) => host.id);

  // Loop edges are excluded from scheduling; they only drive restarts on failure.
  const backEdgeIds = findBackEdges(workflow);
  const maxLoopIterations = Math.max(
    1,
    Math.floor(workflow.settings.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS),
  );
  let iteration = 1;

  const concurrency = Math.max(1, Math.floor(workflow.settings.concurrency) || 1);
  const running = new Map<string, Promise<void>>();

  const settle = (nodeId: string, patch: Partial<NodeRunResult> & { status: NodeRunStatus }): void => {
    const existing: NodeRunResult = run.nodeRuns[nodeId] ?? { nodeId, status: 'pending', hosts: [] };
    run.nodeRuns[nodeId] = { ...existing, ...patch };
    states[nodeId] = { status: patch.status, outputPort: patch.outputPort };
  };

  const settleSkipped = (nodeId: string, reason: NodeSkipReason): void => {
    const node = nodeById.get(nodeId);
    settle(nodeId, {
      status: 'skipped',
      skippedReason: reason,
      endedAt: now(),
    });
    if (node) log('info', `Skipped "${node.name}": ${reason}`, nodeId);
  };

  const buildContext = (): InterpolationContext => ({
    nodeResults: run.nodeRuns,
    variables: workflow.settings.variables ?? {},
    runId: run.runId,
    runStartedAt: run.startedAt,
    iteration,
  });

  const runSingleHost = async (
    node: WorkflowNode,
    config: HostCommandNodeConfig,
    host: Host,
    command: string,
  ): Promise<HostRunResult> => {
    const hostLabel = host.label || host.hostname || host.id;
    const startedAt = now();
    const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
    const retryDelayMs = Math.max(0, node.retry?.delayMs ?? 0);
    const timeoutMs = node.timeoutMs ?? config.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
    let attempts = 0;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      if (signal.aborted) {
        return { hostId: host.id, hostLabel, ok: false, error: 'Cancelled', durationMs: now() - startedAt, attempts };
      }
      try {
        const result = await params.executor.runCommand({
          node,
          config,
          host,
          command,
          timeoutMs,
          attempt,
          signal,
        });
        const outcome = evaluateCommandOutcome(config, result);
        if (outcome.ok) {
          return {
            hostId: host.id,
            hostLabel,
            ok: true,
            exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
            stdout: truncate(result.stdout, maxOutputChars),
            stderr: truncate(result.stderr, maxOutputChars),
            durationMs: now() - startedAt,
            attempts,
          };
        }
        lastError = outcome.reason;
      } catch (err) {
        lastError = errorMessage(err);
      }
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await params.executor.sleep(retryDelayMs, signal);
      }
    }

    return { hostId: host.id, hostLabel, ok: false, error: lastError, durationMs: now() - startedAt, attempts };
  };

  const executeHostCommand = async (node: WorkflowNode, result: NodeRunResult): Promise<void> => {
    if (node.config.kind !== 'hostCommand') return;
    const config = node.config;
    const targets = resolveNodeHosts(node, params.hosts);
    if (targets.length === 0) {
      result.status = 'failed';
      result.error = 'No target host resolved';
      return;
    }

    const interpolated = interpolateTemplate(config.command, buildContext());
    if (!interpolated.ok) {
      result.status = 'failed';
      result.error = interpolated.issues.map((issue) => `${issue.token}: ${issue.message}`).join('; ');
      return;
    }

    if (config.requiresConfirm) {
      const approved = await (params.executor.confirm?.({
        node,
        message: config.command,
      }) ?? Promise.resolve(false));
      if (!approved) {
        result.status = 'skipped';
        result.skippedReason = 'manual-declined';
        return;
      }
    }

    const hostResults = new Array<HostRunResult | undefined>(targets.length);
    const outcomes = await mapWithConcurrency(
      targets,
      config.concurrency ?? concurrency,
      async (host, index) => {
        const hostResult = await runSingleHost(node, config, host, interpolated.value);
        hostResults[index] = hostResult;
        result.hosts = hostResults.filter((entry): entry is HostRunResult => entry !== undefined);
        emit();
        return hostResult;
      },
      { failFast: config.failFast, signal, shouldStop: (entry: HostRunResult) => !entry.ok },
    );

    // Hosts that never started (fail-fast or cancellation) are recorded as skipped.
    for (const outcome of outcomes) {
      if (!outcome.skipped) continue;
      const host = targets[outcome.index];
      if (!host) continue;
      hostResults[outcome.index] = {
        hostId: host.id,
        hostLabel: host.label || host.hostname || host.id,
        ok: false,
        error: signal.aborted ? 'Cancelled' : 'Skipped after a failing host',
        durationMs: 0,
        attempts: 0,
      };
    }
    result.hosts = hostResults.filter((entry): entry is HostRunResult => entry !== undefined);

    const failures = result.hosts.filter((host) => !host.ok);
    if (failures.length > 0) {
      result.status = 'failed';
      result.error = failures
        .map((host) => `${host.hostLabel}: ${host.error ?? 'failed'}`)
        .join('; ');
    }
  };

  const executeCondition = (node: WorkflowNode, result: NodeRunResult): void => {
    if (node.config.kind !== 'condition') return;
    const config = node.config;
    const left = interpolateTemplate(config.left, buildContext());
    const right = config.right === undefined || config.right === ''
      ? { value: '', ok: true, issues: [] }
      : interpolateTemplate(config.right, buildContext());
    const issues = [...left.issues, ...right.issues];
    if (issues.length > 0) {
      result.status = 'failed';
      result.error = issues.map((issue) => `${issue.token}: ${issue.message}`).join('; ');
      return;
    }
    const evaluated = evaluateCondition(left.value, right.value, config);
    result.status = 'success';
    result.outputPort = evaluated.result ? 'true' : 'false';
    result.detail = evaluated.detail;
  };

  const executeNode = async (nodeId: string): Promise<void> => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const result: NodeRunResult = run.nodeRuns[nodeId] ?? { nodeId, status: 'pending', hosts: [] };
    run.nodeRuns[nodeId] = result;
    result.status = 'running';
    result.startedAt = now();
    states[nodeId] = { status: 'running' };
    log('info', `Running "${node.name}"`, nodeId);
    emit();

    try {
      switch (node.kind) {
        case 'hostCommand':
          await executeHostCommand(node, result);
          break;
        case 'condition':
          executeCondition(node, result);
          break;
        case 'delay': {
          const ms = node.config.kind === 'delay' ? Math.max(0, node.config.ms) : 0;
          states[nodeId] = { status: 'waiting' };
          result.status = 'waiting';
          emit();
          await params.executor.sleep(ms, signal);
          result.status = 'success';
          break;
        }
        case 'manual': {
          const message = node.config.kind === 'manual' && node.config.message
            ? node.config.message
            : `Continue workflow "${workflow.name}"?`;
          states[nodeId] = { status: 'waiting' };
          result.status = 'waiting';
          emit();
          const approved = await (params.executor.confirm?.({ node, message }) ?? Promise.resolve(false));
          if (approved) {
            result.status = 'success';
          } else {
            result.status = 'skipped';
            result.skippedReason = 'manual-declined';
          }
          break;
        }
        default:
          result.status = 'failed';
          result.error = `Unsupported node kind "${String(node.kind)}"`;
      }
    } catch (err) {
      if (signal.aborted) {
        result.status = 'skipped';
        result.skippedReason = 'cancelled';
      } else {
        result.status = 'failed';
        result.error = errorMessage(err);
      }
    }

    result.endedAt = now();
    // A node kind that finished without an explicit verdict succeeded; without
    // this the state would stay "running" and every downstream node would wait
    // forever.
    if (result.status === 'running') result.status = 'success';
    const policy = node.onError ?? workflow.settings.onError;
    if (result.status === 'failed') {
      result.outputPort = policy === 'errorPort' ? 'error' : policy === 'continue' ? 'main' : undefined;
      log('error', `"${node.name}" failed: ${result.error ?? 'unknown error'}`, nodeId);
    } else if (result.status === 'skipped') {
      result.outputPort = undefined;
      log('warn', `"${node.name}" was skipped: ${result.skippedReason ?? 'unknown reason'}`, nodeId);
    } else if (!result.outputPort) {
      result.outputPort = 'main';
    }
    states[nodeId] = { status: result.status, outputPort: result.outputPort };
    emit();

    // Loop support: a failing node that points back at an earlier step restarts
    // from there — every node in between is reset — while attempts remain.
    if (result.status === 'failed' && !signal.aborted) {
      const restartFrom = restartTargetsFor(workflow, nodeId, backEdgeIds);
      if (restartFrom.length > 0) {
        if (iteration < maxLoopIterations) {
          const resetIds = collectDownstreamNodeIds(workflow, restartFrom, { excludedEdgeIds: backEdgeIds });
          for (const id of resetIds) {
            states[id] = { status: 'pending' };
            run.nodeRuns[id] = { nodeId: id, status: 'pending', hosts: [] };
          }
          iteration += 1;
          const names = restartFrom.map((id) => nodeById.get(id)?.name ?? id).join(', ');
          log(
            'warn',
            `"${node.name}" failed — restarting from ${names} (attempt ${iteration} of ${maxLoopIterations})`,
            nodeId,
          );
          emit();
          return;
        }
        log(
          'error',
          `"${node.name}" failed and the loop budget (${maxLoopIterations}) is used up`,
          nodeId,
        );
      }
    }
  };

  while (true) {
    if (signal.aborted) {
      for (const node of workflow.nodes) {
        if (states[node.id]?.status === 'pending') settleSkipped(node.id, 'cancelled');
      }
      run.status = 'cancelled';
      log('warn', 'Run cancelled');
      break;
    }

    const busyHostIds = collectBusyHostIds(workflow, states, resolveHostIds);
    const plan = computeReadyNodes({
      workflow,
      states,
      busyHostIds,
      resolveHostIds,
      maxParallel: Math.max(0, concurrency - running.size),
      backEdgeIds,
    });
    for (const skip of plan.skips) settleSkipped(skip.nodeId, skip.reason);
    if (plan.skips.length > 0) {
      // Skipping changes node states, which can release or skip further nodes.
      // Re-plan instead of treating the round as finished.
      emit();
      continue;
    }

    if (plan.ready.length > 0) {
      // Start one node per round: the next round recomputes which hosts are
      // busy, so two nodes touching the same host can never start together.
      const nodeId = plan.ready[0] as string;
      const promise = executeNode(nodeId)
        .catch((err) => {
          log('error', `Node execution crashed: ${errorMessage(err)}`, nodeId);
        })
        .finally(() => {
          running.delete(nodeId);
        });
      running.set(nodeId, promise);
      continue;
    }

    if (running.size === 0) {
      if (!isRunSettled(workflow, states)) {
        log('warn', 'Run stalled: no runnable node and nothing in flight');
        for (const node of workflow.nodes) {
          if (states[node.id]?.status === 'pending') settleSkipped(node.id, 'cancelled');
        }
      }
      break;
    }

    await Promise.race([...running.values()]);
  }

  if (run.status !== 'cancelled') {
    run.status = signal.aborted ? 'cancelled' : summarizeRun(workflow, states);
  }
  run.endedAt = now();
  log('info', `Run ${run.status}`);
  emit();
  return run;
}
