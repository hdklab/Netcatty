/**
 * Mapping between the workflow domain model and the React Flow graph the canvas
 * renders. Pure, so the node summary/status wiring is unit-testable.
 */

import type { Edge, Node } from '@xyflow/react';
import type { Host } from '@/domain/models';
import { nodeOutputPorts } from '@/domain/workflow/nodeCatalog.ts';
import { findBackEdges } from '@/domain/workflow/loops.ts';
import type { NodeRunStatus, Workflow, WorkflowNode, WorkflowRun } from '@/domain/workflow/types.ts';
import { resolveNodeHosts, type WorkflowIssue } from '@/domain/workflow/validate.ts';

export interface WorkflowFlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status: NodeRunStatus;
  /** One-line description of what the node will do. */
  summary: string;
  outputs: ReturnType<typeof nodeOutputPorts>;
  errorCount: number;
  warningCount: number;
}

export type WorkflowFlowNode = Node<WorkflowFlowNodeData, 'workflowNode'>;

function truncate(text: string, limit = 72): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

export function summarizeNode(node: WorkflowNode, hosts: Host[], translate: (key: string, fallback: string) => string): string {
  switch (node.config.kind) {
    case 'hostCommand': {
      const resolved = resolveNodeHosts(node, hosts);
      const scope = node.config.targets.mode === 'all'
        ? translate('workflow.node.summary.allHosts', 'All hosts')
        : resolved.length === 0
          ? translate('workflow.node.summary.noHosts', 'No host selected')
          : resolved.length === 1
            ? resolved[0]?.label ?? resolved[0]?.hostname ?? ''
            : `${resolved.length} ${translate('workflow.node.summary.hosts', 'hosts')}`;
      const command = truncate(node.config.command, 48);
      return command ? `${scope} · ${command}` : scope;
    }
    case 'condition': {
      const right = node.config.right ? ` ${truncate(node.config.right, 24)}` : '';
      return `${truncate(node.config.left, 32)} ${node.config.operator}${right}`;
    }
    case 'delay':
      return `${node.config.ms} ms`;
    case 'manual':
      return truncate(node.config.message || translate('workflow.node.summary.manualDefault', 'Waits for confirmation'), 60);
    default:
      return '';
  }
}

export function toFlowNodes(params: {
  workflow: Workflow;
  hosts: Host[];
  run?: WorkflowRun | null;
  issues: readonly WorkflowIssue[];
  translate: (key: string, fallback: string) => string;
}): WorkflowFlowNode[] {
  const { workflow, hosts, run, issues, translate } = params;
  return workflow.nodes.map((node) => {
    const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
    return {
      id: node.id,
      type: 'workflowNode' as const,
      position: node.position,
      selected: false,
      data: {
        node,
        status: run?.nodeRuns[node.id]?.status ?? 'pending',
        summary: summarizeNode(node, hosts, translate),
        outputs: nodeOutputPorts(node),
        errorCount: nodeIssues.filter((issue) => issue.severity === 'error').length,
        warningCount: nodeIssues.filter((issue) => issue.severity === 'warning').length,
      },
    };
  });
}

export function toFlowEdges(workflow: Workflow, run?: WorkflowRun | null): Edge[] {
  const backEdgeIds = findBackEdges(workflow);
  return workflow.edges.map((edge) => {
    const sourceStatus = run?.nodeRuns[edge.from.nodeId]?.status;
    const isActive = sourceStatus === 'running' || sourceStatus === 'waiting';
    const failed = sourceStatus === 'failed';
    const isLoop = backEdgeIds.has(edge.id);
    return {
      id: edge.id,
      source: edge.from.nodeId,
      sourceHandle: edge.from.output,
      target: edge.to.nodeId,
      targetHandle: 'main',
      type: 'workflow',
      animated: isActive,
      style: {
        strokeWidth: 2,
        // A loop edge means "on failure, restart here": dashed amber.
        ...(isLoop ? { strokeDasharray: '6 4' } : {}),
        stroke: failed
          ? 'hsl(var(--destructive))'
          : isActive
            ? 'hsl(var(--primary))'
            : isLoop
              ? 'hsl(38 92% 50%)'
              : 'hsl(var(--border))',
      },
    };
  });
}

/** Status colour used by both the node card and the run drawer. */
export function statusClassName(status: NodeRunStatus): string {
  switch (status) {
    case 'running':
      return 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]';
    case 'waiting':
      return 'border-amber-500/70';
    case 'success':
      return 'border-emerald-500/70';
    case 'failed':
      return 'border-destructive';
    case 'skipped':
      return 'border-dashed border-border opacity-70';
    default:
      return 'border-border';
  }
}
