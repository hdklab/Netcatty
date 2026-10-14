/**
 * Workflow validation, split into graph shape (no vault needed) and target
 * checks (needs the host inventory). Both run before a run starts so the
 * canvas can block the Run button and point at the offending node.
 */

import type { Host, Snippet } from '../models';
import { getRunnableHostsForSnippet } from '../snippetTargets.ts';
import { resolveEffectiveTerminalProtocol } from '../terminalProtocol.ts';
import { validateTemplate } from './expression.ts';
import { findCycleNodeIds } from './runPlan.ts';
import { DEFAULT_MAX_LOOP_ITERATIONS, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowTargetSelection } from './types.ts';

export type WorkflowIssueCode =
  | 'empty-graph'
  | 'duplicate-node-id'
  | 'duplicate-node-name'
  | 'kind-mismatch'
  | 'dangling-edge'
  | 'self-edge'
  | 'cycle'
  | 'invalid-port'
  | 'condition-port-missing'
  | 'invalid-config'
  | 'template-invalid'
  | 'orphan-node'
  | 'disabled-node-with-downstream'
  | 'unknown-host'
  | 'no-target-host'
  | 'unknown-group'
  | 'unsupported-protocol'
  | 'transport-warning'
  | 'jump-chain-unsupported'
  | 'blocked-command';

export interface WorkflowIssue {
  severity: 'error' | 'warning';
  code: WorkflowIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowTargetValidationOptions {
  hosts: Host[];
  /** User-configured destructive-command patterns (see domain/commandBlocklist). */
  blockedPatterns?: readonly string[];
}

const NODE_KINDS = new Set(['hostCommand', 'condition', 'delay', 'manual']);

/** Translate a node's target selection into the snippet target shape. */
export function selectionToSnippetTargets(
  selection: WorkflowTargetSelection,
): Pick<Snippet, 'targets' | 'targetGroups' | 'targetsAllHosts'> {
  return {
    targets: selection.mode === 'hosts' ? selection.hostIds ?? [] : [],
    targetGroups: selection.mode === 'groups' ? selection.groupPaths ?? [] : undefined,
    targetsAllHosts: selection.mode === 'all',
  };
}

/** Hosts a node will run against. Shared by validation, the runner and the UI. */
export function resolveNodeHosts(node: WorkflowNode, hosts: Host[]): Host[] {
  if (node.config.kind !== 'hostCommand') return [];
  return getRunnableHostsForSnippet(selectionToSnippetTargets(node.config.targets), hosts);
}

/** First user-configured pattern that matches the command, or null. */
export function findBlockedCommandPattern(command: string, patterns: readonly string[]): string | null {
  const value = String(command ?? '');
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(value)) return pattern;
    } catch {
      // A pattern the user typed by hand that does not compile cannot match.
      continue;
    }
  }
  return null;
}

function isNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function templateFields(node: WorkflowNode): string[] {
  switch (node.config.kind) {
    case 'hostCommand':
      return [node.config.command];
    case 'condition':
      return [node.config.left, node.config.right ?? ''];
    default:
      return [];
  }
}

function validateNodeConfig(node: WorkflowNode, issues: WorkflowIssue[]): void {
  const push = (message: string) => issues.push({
    severity: 'error',
    code: 'invalid-config',
    message,
    nodeId: node.id,
  });

  if (node.retry && (!Number.isFinite(node.retry.maxAttempts) || node.retry.maxAttempts < 1)) {
    push(`Node "${node.name}" retry count must be at least 1`);
  }
  if (node.retry && (!Number.isFinite(node.retry.delayMs) || node.retry.delayMs < 0)) {
    push(`Node "${node.name}" retry delay must not be negative`);
  }
  if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0)) {
    push(`Node "${node.name}" timeout must be greater than 0`);
  }

  switch (node.config.kind) {
    case 'hostCommand': {
      const config = node.config;
      if (!isNonEmptyText(config.command)) push(`Node "${node.name}" has no command`);
      if (config.concurrency !== undefined && (!Number.isFinite(config.concurrency) || config.concurrency < 1)) {
        push(`Node "${node.name}" concurrency must be at least 1`);
      }
      if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
        push(`Node "${node.name}" timeout must be greater than 0`);
      }
      if (config.expectedExitCodes && config.expectedExitCodes.some((code) => !Number.isFinite(code))) {
        push(`Node "${node.name}" expected exit codes must be numbers`);
      }
      for (const [field, pattern] of [
        ['successPattern', config.successPattern],
        ['failurePattern', config.failurePattern],
      ] as const) {
        if (pattern === undefined || pattern === '') continue;
        try {
          new RegExp(pattern);
        } catch {
          push(`Node "${node.name}" ${field} is not a valid regex`);
        }
      }
      const selection = config.targets;
      if (selection.mode === 'hosts' && (selection.hostIds ?? []).length === 0) {
        push(`Node "${node.name}" targets no host`);
      }
      if (selection.mode === 'groups' && (selection.groupPaths ?? []).length === 0) {
        push(`Node "${node.name}" targets no group`);
      }
      break;
    }
    case 'condition': {
      if (!isNonEmptyText(node.config.left)) push(`Node "${node.name}" condition has no value to test`);
      const operator = node.config.operator;
      if (operator !== 'truthy' && operator !== 'falsy' && node.config.right === undefined) {
        push(`Node "${node.name}" condition needs a comparison value`);
      }
      break;
    }
    case 'delay': {
      if (!Number.isFinite(node.config.ms) || node.config.ms < 0) {
        push(`Node "${node.name}" delay must be 0 or more milliseconds`);
      }
      break;
    }
    case 'manual':
      break;
  }
}

function validateNodePorts(node: WorkflowNode, outgoing: WorkflowEdge[], issues: WorkflowIssue[]): void {
  const isCondition = node.kind === 'condition';
  const outputs = new Set(outgoing.map((edge) => edge.from.output));
  for (const edge of outgoing) {
    if (isCondition && edge.from.output === 'main') {
      issues.push({
        severity: 'error',
        code: 'invalid-port',
        message: `Condition node "${node.name}" cannot use the "main" output; use true/false`,
        nodeId: node.id,
        edgeId: edge.id,
      });
    }
    if (!isCondition && (edge.from.output === 'true' || edge.from.output === 'false')) {
      issues.push({
        severity: 'error',
        code: 'invalid-port',
        message: `Node "${node.name}" has no ${edge.from.output} output`,
        nodeId: node.id,
        edgeId: edge.id,
      });
    }
  }
  if (isCondition) {
    for (const port of ['true', 'false'] as const) {
      if (!outputs.has(port)) {
        issues.push({
          severity: 'warning',
          code: 'condition-port-missing',
          message: `Condition node "${node.name}" has no ${port} branch connected`,
          nodeId: node.id,
        });
      }
    }
  }
}

/** Graph-only checks: no host inventory required. */
export function validateWorkflowShape(workflow: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodes = workflow.nodes ?? [];
  const edges = workflow.edges ?? [];

  if (nodes.length === 0) {
    issues.push({ severity: 'error', code: 'empty-graph', message: 'Workflow has no nodes' });
    return issues;
  }

  const maxLoopIterations = workflow.settings?.maxLoopIterations;
  if (maxLoopIterations !== undefined
    && (!Number.isFinite(maxLoopIterations) || maxLoopIterations < 1)) {
    issues.push({
      severity: 'error',
      code: 'invalid-config',
      message: 'maxLoopIterations must be at least 1',
    });
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-node-id',
        message: `Duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
    }
    seenIds.add(node.id);
    const name = node.name.trim();
    if (seenNames.has(name)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-node-name',
        message: `Duplicate node name "${name}"`,
        nodeId: node.id,
      });
    }
    seenNames.add(name);
    if (!NODE_KINDS.has(node.kind)) {
      issues.push({
        severity: 'error',
        code: 'kind-mismatch',
        message: `Node "${node.name}" has unknown kind "${node.kind}"`,
        nodeId: node.id,
      });
      continue;
    }
    if (node.config.kind !== node.kind) {
      issues.push({
        severity: 'error',
        code: 'kind-mismatch',
        message: `Node "${node.name}" kind and configuration disagree`,
        nodeId: node.id,
      });
      continue;
    }
    validateNodeConfig(node, issues);
    for (const field of templateFields(node)) {
      for (const issue of validateTemplate(field)) {
        issues.push({
          severity: 'error',
          code: 'template-invalid',
          message: `Node "${node.name}": {{ ${issue.token} }} — ${issue.message}`,
          nodeId: node.id,
        });
      }
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.from.nodeId) || !nodeIds.has(edge.to.nodeId)) {
      issues.push({
        severity: 'error',
        code: 'dangling-edge',
        message: 'Edge references a node that is not in the workflow',
        edgeId: edge.id,
      });
      continue;
    }
    if (edge.from.nodeId === edge.to.nodeId) {
      issues.push({
        severity: 'error',
        code: 'self-edge',
        message: 'A node cannot depend on itself',
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
      });
      continue;
    }
    outgoing.get(edge.from.nodeId)?.push(edge);
    incoming.get(edge.to.nodeId)?.push(edge);
  }

  const cycleNodes = findCycleNodeIds(workflow);
  if (cycleNodes.length > 0) {
    const maxIterations = workflow.settings?.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
    const bounded = Number.isFinite(maxIterations) && maxIterations >= 1;
    // A cycle is how a user draws "on failure, go back to this step": it is
    // legal as long as the restart count is bounded.
    issues.push({
      severity: bounded ? 'warning' : 'error',
      code: 'cycle',
      message: bounded
        ? `Loop through ${cycleNodes.length} node(s): a failing node restarts it, at most ${maxIterations} time(s)`
        : `Loop through ${cycleNodes.length} node(s) needs maxLoopIterations >= 1`,
      nodeId: cycleNodes[0],
    });
  }

  for (const node of nodes) {
    if (!NODE_KINDS.has(node.kind)) continue;
    validateNodePorts(node, outgoing.get(node.id) ?? [], issues);
    const hasIncoming = (incoming.get(node.id) ?? []).length > 0;
    const hasOutgoing = (outgoing.get(node.id) ?? []).length > 0;
    if (nodes.length > 1 && !hasIncoming && !hasOutgoing) {
      issues.push({
        severity: 'warning',
        code: 'orphan-node',
        message: `Node "${node.name}" is not connected to anything`,
        nodeId: node.id,
      });
    }
    if (node.disabled && hasOutgoing) {
      issues.push({
        severity: 'warning',
        code: 'disabled-node-with-downstream',
        message: `Disabled node "${node.name}" will skip its downstream nodes`,
        nodeId: node.id,
      });
    }
  }

  return issues;
}

/** Target checks: needs the host inventory (and optionally the command blocklist). */
export function validateWorkflowTargets(
  workflow: Workflow,
  options: WorkflowTargetValidationOptions,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const hosts = options.hosts ?? [];
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const blockedPatterns = options.blockedPatterns ?? [];

  for (const node of workflow.nodes ?? []) {
    if (node.config.kind !== 'hostCommand') continue;
    const selection = node.config.targets;

    for (const hostId of selection.mode === 'hosts' ? selection.hostIds ?? [] : []) {
      if (!hostById.has(hostId)) {
        issues.push({
          severity: 'error',
          code: 'unknown-host',
          message: `Node "${node.name}" targets a host that no longer exists`,
          nodeId: node.id,
        });
      }
    }

    const resolved = resolveNodeHosts(node, hosts);
    if (resolved.length === 0) {
      const isGroupTarget = selection.mode === 'groups';
      issues.push({
        severity: isGroupTarget ? 'warning' : 'error',
        code: isGroupTarget ? 'unknown-group' : 'no-target-host',
        message: isGroupTarget
          ? `Node "${node.name}" group selection currently resolves to no host`
          : `Node "${node.name}" has no connectable target host`,
        nodeId: node.id,
      });
    }

    let sawJumpChain = false;
    let sawNonSsh = false;
    for (const host of resolved) {
      const protocol = resolveEffectiveTerminalProtocol(host);
      if (protocol !== 'ssh') sawNonSsh = true;
      if ((host.hostChain?.hostIds ?? []).length > 0) sawJumpChain = true;
    }
    if (sawNonSsh) {
      issues.push({
        severity: 'warning',
        code: 'unsupported-protocol',
        message: `Node "${node.name}" runs over a non-SSH transport: it will be typed into that host's open terminal, so open it before running`,
        nodeId: node.id,
      });
    }
    if (sawJumpChain) {
      issues.push({
        severity: 'warning',
        code: 'jump-chain-unsupported',
        message: `Node "${node.name}" targets a host behind a jump chain: it will run inside that host's open terminal, so open it before running`,
        nodeId: node.id,
      });
    }

    if (blockedPatterns.length > 0) {
      const hit = findBlockedCommandPattern(node.config.command, blockedPatterns);
      if (hit) {
        issues.push({
          severity: 'warning',
          code: 'blocked-command',
          message: `Node "${node.name}" matches a blocked command pattern`,
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

export function validateWorkflow(
  workflow: Workflow,
  options?: WorkflowTargetValidationOptions,
): WorkflowIssue[] {
  const issues = validateWorkflowShape(workflow);
  if (options) issues.push(...validateWorkflowTargets(workflow, options));
  return issues;
}

export function hasBlockingIssues(issues: readonly WorkflowIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function issuesForNode(issues: readonly WorkflowIssue[], nodeId: string): WorkflowIssue[] {
  return issues.filter((issue) => issue.nodeId === nodeId);
}
