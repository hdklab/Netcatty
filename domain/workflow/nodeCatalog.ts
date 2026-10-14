/**
 * Node type catalog: the single description of every node kind, its ports and
 * its default configuration. The canvas palette, the inspector defaults and the
 * runner all read from here so a new node kind is added in one place.
 */

import type {
  ConditionNodeConfig,
  DelayNodeConfig,
  HostCommandNodeConfig,
  ManualNodeConfig,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowNodeKind,
  WorkflowOutputPort,
} from './types.ts';

export interface WorkflowNodeTypeDescriptor {
  kind: WorkflowNodeKind;
  /** i18n key for the palette entry and node title. */
  labelKey: string;
  /** i18n key for the palette subtitle. */
  descriptionKey: string;
  /** lucide-react icon name, resolved by the UI. */
  icon: 'terminal' | 'git-branch' | 'timer' | 'hand';
  category: 'host' | 'flow';
  /** Outputs the type can offer; `error` is rendered only with the errorPort policy. */
  outputs: WorkflowOutputPort[];
  createConfig: () => WorkflowNodeConfig;
}

export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeTypeDescriptor[] = [
  {
    kind: 'hostCommand',
    labelKey: 'workflow.nodeType.hostCommand',
    descriptionKey: 'workflow.nodeType.hostCommand.description',
    icon: 'terminal',
    category: 'host',
    outputs: ['main', 'error'],
    createConfig: (): HostCommandNodeConfig => ({
      kind: 'hostCommand',
      targets: { mode: 'hosts', hostIds: [] },
      command: '',
    }),
  },
  {
    kind: 'condition',
    labelKey: 'workflow.nodeType.condition',
    descriptionKey: 'workflow.nodeType.condition.description',
    icon: 'git-branch',
    category: 'flow',
    outputs: ['true', 'false'],
    createConfig: (): ConditionNodeConfig => ({
      kind: 'condition',
      left: '',
      operator: 'contains',
      right: '',
    }),
  },
  {
    kind: 'delay',
    labelKey: 'workflow.nodeType.delay',
    descriptionKey: 'workflow.nodeType.delay.description',
    icon: 'timer',
    category: 'flow',
    outputs: ['main'],
    createConfig: (): DelayNodeConfig => ({ kind: 'delay', ms: 5000 }),
  },
  {
    kind: 'manual',
    labelKey: 'workflow.nodeType.manual',
    descriptionKey: 'workflow.nodeType.manual.description',
    icon: 'hand',
    category: 'flow',
    outputs: ['main'],
    createConfig: (): ManualNodeConfig => ({ kind: 'manual', message: '' }),
  },
];

export function getNodeType(kind: WorkflowNodeKind): WorkflowNodeTypeDescriptor | undefined {
  return WORKFLOW_NODE_TYPES.find((entry) => entry.kind === kind);
}

/**
 * Ports a concrete node renders. An `error` output only exists while the node
 * is configured to route failures there.
 */
export function nodeOutputPorts(node: WorkflowNode): WorkflowOutputPort[] {
  if (node.kind === 'condition') return ['true', 'false'];
  if (node.onError === 'errorPort') return ['main', 'error'];
  return ['main'];
}

export function createWorkflowNode(params: {
  kind: WorkflowNodeKind;
  id: string;
  name: string;
  position: { x: number; y: number };
}): WorkflowNode | null {
  const descriptor = getNodeType(params.kind);
  if (!descriptor) return null;
  return {
    id: params.id,
    kind: params.kind,
    name: params.name,
    position: params.position,
    config: descriptor.createConfig(),
  };
}

/** Name unique inside the workflow, e.g. "Command 2". */
export function nextNodeName(workflow: { nodes: WorkflowNode[] }, kind: WorkflowNodeKind): string {
  const descriptor = getNodeType(kind);
  const base = descriptor ? descriptor.labelKey.split('.').pop() ?? kind : kind;
  const suffix = base.charAt(0).toUpperCase() + base.slice(1);
  const used = new Set(workflow.nodes.map((node) => node.name));
  if (!used.has(suffix)) return suffix;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${suffix} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${suffix} ${Date.now()}`;
}
