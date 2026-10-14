/**
 * Workflow orchestration domain types.
 *
 * A workflow is a node graph: nodes are actions (mostly "run this on that
 * host"), edges are dependencies. This module stays free of React and
 * infrastructure imports so the scheduler can be unit-tested directly.
 *
 * See docs/designs/workflow-orchestration.md for the full design.
 */

export type WorkflowNodeKind = 'hostCommand' | 'condition' | 'delay' | 'manual';

/** Output ports a node can activate. `main` is the default single port. */
export type WorkflowOutputPort = 'main' | 'true' | 'false' | 'error';

export type WorkflowInputPort = 'main';

/**
 * What a failure means for the rest of the graph:
 * - `stop`: downstream nodes are skipped (default).
 * - `continue`: the node is marked failed but its `main` edges stay active.
 * - `errorPort`: `main` edges stay inactive and the `error` port activates.
 */
export type NodeErrorPolicy = 'stop' | 'continue' | 'errorPort';

/** Host selection, mirroring the snippet target shape so the same resolver works. */
export interface WorkflowTargetSelection {
  mode: 'hosts' | 'groups' | 'all';
  hostIds?: string[];
  groupPaths?: string[];
}

export interface HostCommandNodeConfig {
  kind: 'hostCommand';
  targets: WorkflowTargetSelection;
  /** Shell command; supports {{ ... }} interpolation. */
  command: string;
  /** Exit codes treated as success. Defaults to [0]. */
  expectedExitCodes?: number[];
  /** Optional stdout regex; when set it overrides the exit-code check. */
  successPattern?: string;
  /** Optional stdout regex that fails the host even on a successful exit code. */
  failurePattern?: string;
  /** Stop this node's remaining hosts after the first failure. */
  failFast?: boolean;
  /** Overrides the workflow concurrency for this node. */
  concurrency?: number;
  /** Always ask the user before this node runs. */
  requiresConfirm?: boolean;
  /** Per-attempt timeout in ms. Defaults to 60000. */
  timeoutMs?: number;
}

export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'truthy'
  | 'falsy';

export interface ConditionNodeConfig {
  kind: 'condition';
  /** Interpolated left-hand value, e.g. "{{ nodes.check.stdout }}". */
  left: string;
  operator: ConditionOperator;
  /** Interpolated right-hand value; ignored by truthy/falsy. */
  right?: string;
  caseSensitive?: boolean;
}

export interface DelayNodeConfig {
  kind: 'delay';
  /** Wait duration in ms. */
  ms: number;
}

export interface ManualNodeConfig {
  kind: 'manual';
  /** Prompt shown in the confirmation dialog. */
  message?: string;
}

export type WorkflowNodeConfig =
  | HostCommandNodeConfig
  | ConditionNodeConfig
  | DelayNodeConfig
  | ManualNodeConfig;

export interface WorkflowNodeRetry {
  maxAttempts: number;
  delayMs: number;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Unique display name inside the workflow; used in run logs. */
  name: string;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
  onError?: NodeErrorPolicy;
  retry?: WorkflowNodeRetry;
  /** Per-attempt timeout override in ms. */
  timeoutMs?: number;
  /** Kept on the canvas but skipped at run time. */
  disabled?: boolean;
}

export interface WorkflowEdge {
  id: string;
  from: { nodeId: string; output: WorkflowOutputPort };
  to: { nodeId: string; input: WorkflowInputPort };
}

export interface WorkflowSettings {
  /** Max hosts executed in parallel when a node has no override. */
  concurrency: number;
  /** Workflow-level default for nodes without their own onError. */
  onError: 'stop' | 'continue';
  /**
   * How many times a failing node may restart the loop it points back into.
   * Any cycle in the graph is bounded by this (default 3).
   */
  maxLoopIterations?: number;
  variables?: Record<string, string>;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every structural edit; runs record the revision they ran. */
  revision: number;
  schema: 1;
}

export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
export const DEFAULT_NODE_TIMEOUT_MS = 60000;
/** Attempts allowed when a node restarts the loop it points back into. */
export const DEFAULT_MAX_LOOP_ITERATIONS = 3;

/* ------------------------------------------------------------------ */
/* Run state                                                          */
/* ------------------------------------------------------------------ */

export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'skipped';

export type NodeSkipReason =
  | 'disabled'
  | 'condition-false'
  | 'upstream-failed'
  | 'upstream-skipped'
  | 'host-conflict'
  | 'cancelled'
  | 'fail-fast'
  | 'manual-declined';

export interface HostRunResult {
  hostId: string;
  hostLabel: string;
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  attempts: number;
  error?: string;
}

export interface NodeRunResult {
  nodeId: string;
  status: NodeRunStatus;
  startedAt?: number;
  endedAt?: number;
  hosts: HostRunResult[];
  /** Which output port the node activated; drives downstream readiness. */
  outputPort?: WorkflowOutputPort;
  error?: string;
  skippedReason?: NodeSkipReason;
  /** Condition evaluation detail, for the run drawer. */
  detail?: string;
}

export interface WorkflowRunLogEntry {
  at: number;
  nodeId?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  /** Human-readable workflow name captured at run time. */
  workflowName: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  nodeRuns: Record<string, NodeRunResult>;
  log: WorkflowRunLogEntry[];
}

/** A node's lightweight state as the scheduler sees it. */
export interface NodeState {
  status: NodeRunStatus;
  outputPort?: WorkflowOutputPort;
}

export function createEmptyWorkflow(id: string, now: number, name = 'New workflow'): Workflow {
  return {
    id,
    name,
    nodes: [],
    edges: [],
    settings: { concurrency: DEFAULT_WORKFLOW_CONCURRENCY, onError: 'stop' },
    createdAt: now,
    updatedAt: now,
    revision: 1,
    schema: 1,
  };
}
