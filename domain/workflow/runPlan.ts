/**
 * Workflow scheduling: pure graph logic that decides what may run next.
 *
 * The runner in application/state feeds this function the current node states
 * and executes whatever comes back. Keeping the decision here means the
 * dependency, branch and host-conflict rules are testable without SSH.
 */

import type {
  NodeRunStatus,
  NodeSkipReason,
  NodeState,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from './types.ts';

export interface ReadyNodePlan {
  /** Nodes that may start now, in a deterministic order. */
  ready: string[];
  /** Nodes whose dependencies are settled but that touch a busy host. */
  blockedByHost: string[];
  /** Nodes that should be settled as skipped right away. */
  skips: Array<{ nodeId: string; reason: NodeSkipReason }>;
}

export interface ComputeReadyNodesParams {
  workflow: Workflow;
  states: Readonly<Record<string, NodeState>>;
  /** Hosts currently executing in another node. */
  busyHostIds?: ReadonlySet<string>;
  /** Resolve the hosts a node will touch (group targets need the vault). */
  resolveHostIds?: (node: WorkflowNode) => readonly string[];
  /** Cap on how many nodes this call may return as ready. */
  maxParallel?: number;
  /**
   * Loop-closing edges. They are ignored for scheduling: a node must not wait
   * for a step that only runs after a retry.
   */
  backEdgeIds?: ReadonlySet<string>;
}

const SETTLED_STATUSES: ReadonlySet<NodeRunStatus> = new Set<NodeRunStatus>([
  'success',
  'failed',
  'skipped',
]);

export function isNodeSettled(state: NodeState | undefined): boolean {
  return state !== undefined && SETTLED_STATUSES.has(state.status);
}

/**
 * A settled source activates an edge only when its output port matches the
 * edge's declared port. `outputPort` is set by the runner from the node's error
 * policy, which is why a failed node can still activate `main` (policy
 * `continue`) or `error` (policy `errorPort`) but not both.
 */
function isEdgeActive(edge: WorkflowEdge, sourceState: NodeState | undefined): boolean {
  if (!isNodeSettled(sourceState)) return false;
  if (!sourceState?.outputPort) return false;
  return edge.from.output === sourceState.outputPort;
}

/** Topological order; falls back to declaration order when the graph has a cycle. */
export function orderWorkflowNodes(workflow: Workflow): { order: string[]; cyclic: boolean } {
  const nodes = workflow.nodes;
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.from.nodeId) || !indegree.has(edge.to.nodeId)) continue;
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    order.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length === nodes.length) return { order, cyclic: false };
  return { order: nodes.map((node) => node.id), cyclic: true };
}

/** Node ids that participate in a cycle, for UI highlighting. */
export function findCycleNodeIds(workflow: Workflow): string[] {
  const { cyclic } = orderWorkflowNodes(workflow);
  if (!cyclic) return [];
  const reachable = new Set<string>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.from.nodeId) || !indegree.has(edge.to.nodeId)) continue;
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }
  const queue = workflow.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    reachable.add(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // Everything the acyclic peel never reached sits on (or downstream of) a cycle.
  const notCyclic = new Set(
    workflow.nodes.filter((node) => reachable.has(node.id)).map((node) => node.id),
  );
  const candidates = workflow.nodes.filter((node) => !notCyclic.has(node.id)).map((node) => node.id);
  if (candidates.length === 0) return [];
  // Narrow to nodes that can reach themselves, i.e. real cycle members.
  const adjacency = new Map<string, string[]>();
  for (const id of candidates) adjacency.set(id, []);
  for (const edge of workflow.edges) {
    if (adjacency.has(edge.from.nodeId) && adjacency.has(edge.to.nodeId)) {
      adjacency.get(edge.from.nodeId)?.push(edge.to.nodeId);
    }
  }
  const onCycle: string[] = [];
  for (const id of candidates) {
    const stack = [...(adjacency.get(id) ?? [])];
    const seen = new Set<string>();
    let found = false;
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      if (current === id) {
        found = true;
        break;
      }
      seen.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }
    if (found) onCycle.push(id);
  }
  return onCycle;
}

export function computeReadyNodes(params: ComputeReadyNodesParams): ReadyNodePlan {
  const { workflow, states, busyHostIds, resolveHostIds, maxParallel, backEdgeIds } = params;
  const { order } = orderWorkflowNodes(workflow);
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    if (backEdgeIds?.has(edge.id)) continue;
    if (!incoming.has(edge.to.nodeId)) incoming.set(edge.to.nodeId, []);
    incoming.get(edge.to.nodeId)?.push(edge);
  }
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));

  const skips: ReadyNodePlan['skips'] = [];
  const eligible: string[] = [];

  for (const nodeId of order) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const state = states[nodeId];
    if (state && state.status !== 'pending') continue;

    if (node.disabled) {
      skips.push({ nodeId, reason: 'disabled' });
      continue;
    }

    const incomingEdges = incoming.get(nodeId) ?? [];
    if (incomingEdges.length === 0) {
      eligible.push(nodeId);
      continue;
    }

    const sources = incomingEdges.map((edge) => states[edge.from.nodeId]);
    if (sources.some((source) => !isNodeSettled(source))) continue;

    const activeCount = incomingEdges.filter((edge) => isEdgeActive(edge, states[edge.from.nodeId])).length;
    if (activeCount === incomingEdges.length) {
      eligible.push(nodeId);
      continue;
    }

    const failedSource = sources.some((source) => source?.status === 'failed');
    const skippedSource = sources.some((source) => source?.status === 'skipped');
    skips.push({
      nodeId,
      reason: failedSource ? 'upstream-failed' : skippedSource ? 'upstream-skipped' : 'condition-false',
    });
  }

  const blockedByHost: string[] = [];
  const ready: string[] = [];
  for (const nodeId of eligible) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    if (busyHostIds && busyHostIds.size > 0 && resolveHostIds) {
      const hosts = resolveHostIds(node);
      if (hosts.some((hostId) => busyHostIds.has(hostId))) {
        blockedByHost.push(nodeId);
        continue;
      }
    }
    ready.push(nodeId);
  }

  const limited = typeof maxParallel === 'number' && maxParallel >= 0 ? ready.slice(0, maxParallel) : ready;
  const deferred = ready.slice(limited.length);
  return { ready: limited, blockedByHost: [...blockedByHost, ...deferred], skips };
}

export function collectBusyHostIds(
  workflow: Workflow,
  states: Readonly<Record<string, NodeState>>,
  resolveHostIds: (node: WorkflowNode) => readonly string[],
): Set<string> {
  const busy = new Set<string>();
  for (const node of workflow.nodes) {
    if (states[node.id]?.status !== 'running' && states[node.id]?.status !== 'waiting') continue;
    for (const hostId of resolveHostIds(node)) busy.add(hostId);
  }
  return busy;
}

/** True when every node has a settled status. */
export function isRunSettled(workflow: Workflow, states: Readonly<Record<string, NodeState>>): boolean {
  return workflow.nodes.every((node) => isNodeSettled(states[node.id]));
}

/**
 * Aggregate run outcome from node states. Cancellation is tracked by the
 * runner itself (`run.status = 'cancelled'`), because a cancelled run can have
 * skips that would otherwise look like a normal failure-free completion.
 */
export function summarizeRun(
  workflow: Workflow,
  states: Readonly<Record<string, NodeState>>,
): 'success' | 'failed' {
  const failed = workflow.nodes.some((node) => states[node.id]?.status === 'failed');
  return failed ? 'failed' : 'success';
}
