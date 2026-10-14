/**
 * Tolerant (de)serialization for workflows loaded from storage or an import
 * file. A malformed entry must never take the whole list down, so every field
 * is checked and dropped rather than trusted.
 */

import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  DEFAULT_WORKFLOW_CONCURRENCY,
  type ConditionOperator,
  type NodeErrorPolicy,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeConfig,
  type WorkflowNodeKind,
  type WorkflowOutputPort,
  type WorkflowTargetSelection,
} from './types.ts';

const NODE_KINDS: readonly WorkflowNodeKind[] = ['hostCommand', 'condition', 'delay', 'manual'];
const OUTPUT_PORTS: readonly WorkflowOutputPort[] = ['main', 'true', 'false', 'error'];
const ERROR_POLICIES: readonly NodeErrorPolicy[] = ['stop', 'continue', 'errorPort'];
const CONDITION_OPERATORS: readonly ConditionOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'regex',
  'truthy',
  'falsy',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTargets(value: unknown): WorkflowTargetSelection {
  if (!isRecord(value)) return { mode: 'hosts', hostIds: [] };
  const mode = value.mode === 'groups' || value.mode === 'all' ? value.mode : 'hosts';
  const hostIds = Array.isArray(value.hostIds)
    ? value.hostIds.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const groupPaths = Array.isArray(value.groupPaths)
    ? value.groupPaths.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return { mode, hostIds, groupPaths };
}

function normalizeConfig(kind: WorkflowNodeKind, value: unknown): WorkflowNodeConfig | null {
  if (!isRecord(value)) return null;
  switch (kind) {
    case 'hostCommand':
      return {
        kind: 'hostCommand',
        targets: normalizeTargets(value.targets),
        command: asString(value.command),
        expectedExitCodes: Array.isArray(value.expectedExitCodes)
          ? value.expectedExitCodes.filter((entry): entry is number => typeof entry === 'number')
          : undefined,
        successPattern: asOptionalString(value.successPattern),
        failurePattern: asOptionalString(value.failurePattern),
        failFast: value.failFast === true ? true : undefined,
        concurrency: asOptionalNumber(value.concurrency),
        requiresConfirm: value.requiresConfirm === true ? true : undefined,
        timeoutMs: asOptionalNumber(value.timeoutMs),
      };
    case 'condition':
      return {
        kind: 'condition',
        left: asString(value.left),
        operator: CONDITION_OPERATORS.find((candidate) => candidate === value.operator) ?? 'contains',
        right: asOptionalString(value.right),
        caseSensitive: value.caseSensitive === true ? true : undefined,
      };
    case 'delay':
      return { kind: 'delay', ms: asFiniteNumber(value.ms, 0) };
    case 'manual':
      return { kind: 'manual', message: asOptionalString(value.message) };
    default:
      return null;
  }
}

function normalizeNode(value: unknown): WorkflowNode | null {
  if (!isRecord(value)) return null;
  const kind = NODE_KINDS.find((candidate) => candidate === value.kind);
  if (!kind) return null;
  const id = asString(value.id);
  if (!id) return null;
  const config = normalizeConfig(kind, value.config);
  if (!config) return null;
  const position = isRecord(value.position) ? value.position : {};
  const retry = isRecord(value.retry) && asFiniteNumber(value.retry.maxAttempts, 0) > 0
    ? {
      maxAttempts: asFiniteNumber(value.retry.maxAttempts, 1),
      delayMs: asFiniteNumber(value.retry.delayMs, 0),
    }
    : undefined;
  const onError = ERROR_POLICIES.find((candidate) => candidate === value.onError);
  return {
    id,
    kind,
    name: asString(value.name, id),
    position: {
      x: asFiniteNumber(position.x, 0),
      y: asFiniteNumber(position.y, 0),
    },
    config,
    onError,
    retry,
    timeoutMs: asOptionalNumber(value.timeoutMs),
    disabled: value.disabled === true ? true : undefined,
  };
}

function normalizeEdge(value: unknown, nodeIds: ReadonlySet<string>): WorkflowEdge | null {
  if (!isRecord(value)) return null;
  const from = isRecord(value.from) ? value.from : null;
  const to = isRecord(value.to) ? value.to : null;
  if (!from || !to) return null;
  const fromNodeId = asString(from.nodeId);
  const toNodeId = asString(to.nodeId);
  if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) return null;
  const output = OUTPUT_PORTS.find((candidate) => candidate === from.output) ?? 'main';
  const id = asString(value.id) || `${fromNodeId}->${toNodeId}:${output}`;
  return { id, from: { nodeId: fromNodeId, output }, to: { nodeId: toNodeId, input: 'main' } };
}

/** Returns null when the entry cannot be salvaged at all. */
export function normalizeWorkflow(raw: unknown, fallbackId: string): Workflow | null {
  if (!isRecord(raw)) return null;
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .map(normalizeNode)
    .filter((node): node is WorkflowNode => node !== null);
  if (nodes.length === 0) return null;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((edge) => normalizeEdge(edge, nodeIds))
    .filter((edge): edge is WorkflowEdge => edge !== null);

  const settings = isRecord(raw.settings) ? raw.settings : {};
  const variables = isRecord(settings.variables)
    ? Object.fromEntries(
      Object.entries(settings.variables).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    : undefined;
  const now = asFiniteNumber(raw.updatedAt, 0);

  return {
    id: asString(raw.id) || fallbackId,
    name: asString(raw.name, 'Workflow'),
    description: asOptionalString(raw.description),
    nodes,
    edges,
    settings: {
      concurrency: Math.max(1, asFiniteNumber(settings.concurrency, DEFAULT_WORKFLOW_CONCURRENCY)),
      onError: settings.onError === 'continue' ? 'continue' : 'stop',
      maxLoopIterations: settings.maxLoopIterations === undefined
        ? undefined
        : Math.max(1, asFiniteNumber(settings.maxLoopIterations, DEFAULT_MAX_LOOP_ITERATIONS)),
      variables,
    },
    createdAt: asFiniteNumber(raw.createdAt, now),
    updatedAt: now,
    revision: Math.max(1, asFiniteNumber(raw.revision, 1)),
    schema: 1,
  };
}

export function normalizeWorkflowList(raw: unknown): Workflow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: Workflow[] = [];
  for (const entry of raw) {
    const workflow = normalizeWorkflow(entry, `workflow-${result.length + 1}`);
    if (!workflow || seen.has(workflow.id)) continue;
    seen.add(workflow.id);
    result.push(workflow);
  }
  return result;
}
