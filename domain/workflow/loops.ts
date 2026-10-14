/**
 * Loop support: a workflow graph may contain cycles as long as they are
 * bounded. A cycle is expressed the way the user draws it — a connection from a
 * later node back to an earlier one — and is treated as "when this node fails,
 * restart from there, at most `maxLoopIterations` times".
 *
 * Scheduling happens on the DAG that remains after removing the back edges
 * (depth-first search marks an edge as a back edge when it points at a node
 * still on the recursion stack).
 */

import type { Workflow, WorkflowEdge } from './types.ts';

/** Edge ids that close a loop, in a deterministic order. */
export function findBackEdges(workflow: Workflow): Set<string> {
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const node of workflow.nodes) outgoing.set(node.id, []);
  for (const edge of workflow.edges) {
    if (!outgoing.has(edge.from.nodeId) || !outgoing.has(edge.to.nodeId)) continue;
    outgoing.get(edge.from.nodeId)?.push(edge);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of workflow.nodes) color.set(node.id, WHITE);
  const backEdges = new Set<string>();

  const visit = (startId: string): void => {
    const stack: Array<{ nodeId: string; edges: WorkflowEdge[]; index: number }> = [];
    color.set(startId, GRAY);
    stack.push({ nodeId: startId, edges: outgoing.get(startId) ?? [], index: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      if (frame.index >= frame.edges.length) {
        color.set(frame.nodeId, BLACK);
        stack.pop();
        continue;
      }
      const edge = frame.edges[frame.index] as WorkflowEdge;
      frame.index += 1;
      const targetColor = color.get(edge.to.nodeId);
      if (targetColor === GRAY) {
        backEdges.add(edge.id);
        continue;
      }
      if (targetColor === WHITE) {
        color.set(edge.to.nodeId, GRAY);
        stack.push({ nodeId: edge.to.nodeId, edges: outgoing.get(edge.to.nodeId) ?? [], index: 0 });
      }
    }
  };

  for (const node of workflow.nodes) {
    if (color.get(node.id) === WHITE) visit(node.id);
  }
  return backEdges;
}

export function findBackEdgesFrom(workflow: Workflow, nodeId: string, backEdgeIds: ReadonlySet<string>): WorkflowEdge[] {
  return workflow.edges.filter((edge) => backEdgeIds.has(edge.id) && edge.from.nodeId === nodeId);
}

/**
 * `startNodeIds` plus everything reachable from them following non-back edges —
 * the part of the graph to reset when a loop restarts.
 */
export function collectDownstreamNodeIds(
  workflow: Workflow,
  startNodeIds: readonly string[],
  options: { excludedEdgeIds?: ReadonlySet<string> } = {},
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const node of workflow.nodes) outgoing.set(node.id, []);
  for (const edge of workflow.edges) {
    if (options.excludedEdgeIds?.has(edge.id)) continue;
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }

  const result = new Set<string>();
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || result.has(current)) continue;
    result.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return result;
}

/** Back-edge targets that a failing node can restart from. */
export function restartTargetsFor(
  workflow: Workflow,
  failedNodeId: string,
  backEdgeIds: ReadonlySet<string>,
): string[] {
  return [...new Set(
    findBackEdgesFrom(workflow, failedNodeId, backEdgeIds).map((edge) => edge.to.nodeId),
  )];
}
