import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host } from '../models';
import {
  findBlockedCommandPattern,
  hasBlockingIssues,
  resolveNodeHosts,
  validateWorkflow,
  validateWorkflowShape,
  validateWorkflowTargets,
} from './validate.ts';
import type { Workflow, WorkflowEdge, WorkflowNode, WorkflowTargetSelection } from './types.ts';

function host(id: string, extra: Partial<Host> = {}): Host {
  return {
    id,
    label: id,
    hostname: `${id}.example`,
    username: 'root',
    os: 'linux',
    protocol: 'ssh',
    tags: [],
    ...extra,
  };
}

const hosts: Host[] = [
  host('h1', { group: 'Production/Web' }),
  host('h2', { group: 'Production/Web' }),
  host('h9', { group: 'Staging' }),
  host('serial1', { protocol: 'serial' }),
  host('telnet1', { protocol: 'telnet' }),
  host('mosh1', { protocol: 'mosh' }),
  host('behind-jump', { hostChain: { hostIds: ['h1'] } }),
];

function commandNode(id: string, selection: WorkflowTargetSelection, command = 'echo hi'): WorkflowNode {
  return {
    id,
    kind: 'hostCommand',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'hostCommand', targets: selection, command },
  };
}

function conditionNode(id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    kind: 'condition',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'condition', left: '{{ nodes.a.stdout }}', operator: 'truthy' },
    ...extra,
  };
}

function link(from: string, to: string, output: WorkflowEdge['from']['output'] = 'main'): WorkflowEdge {
  return { id: `${from}->${to}:${output}`, from: { nodeId: from, output }, to: { nodeId: to, input: 'main' } };
}

function graph(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): Workflow {
  return {
    id: 'w1',
    name: 'w1',
    nodes,
    edges,
    settings: { concurrency: 4, onError: 'stop' },
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    schema: 1,
  };
}

const codes = (issues: ReturnType<typeof validateWorkflowShape>): string[] => issues.map((issue) => issue.code);

test('an empty workflow is an error', () => {
  const issues = validateWorkflowShape(graph([]));
  assert.deepEqual(codes(issues), ['empty-graph']);
  assert.equal(hasBlockingIssues(issues), true);
});

test('duplicate node names and dangling edges are errors', () => {
  const duplicated = validateWorkflowShape(graph([
    commandNode('a', { mode: 'hosts', hostIds: ['h1'] }),
    { ...commandNode('b', { mode: 'hosts', hostIds: ['h1'] }), name: 'a' },
  ], [link('a', 'b')]));
  assert.ok(codes(duplicated).includes('duplicate-node-name'));

  const dangling = validateWorkflowShape(graph(
    [commandNode('a', { mode: 'hosts', hostIds: ['h1'] })],
    [link('a', 'ghost')],
  ));
  assert.ok(codes(dangling).includes('dangling-edge'));
  assert.equal(hasBlockingIssues(dangling), true);
});

test('a bounded loop is a warning, an unbounded one is an error', () => {
  const loop = graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['h1'] }),
      commandNode('b', { mode: 'hosts', hostIds: ['h1'] }),
    ],
    [link('a', 'b'), link('b', 'a')],
  );
  const issues = validateWorkflowShape(loop);
  const cycle = issues.find((issue) => issue.code === 'cycle');
  assert.equal(cycle?.severity, 'warning');
  assert.match(cycle?.message ?? '', /at most 3 time/);
  assert.ok(cycle?.nodeId === 'a' || cycle?.nodeId === 'b');
  assert.equal(hasBlockingIssues(issues), false);

  const unbounded = {
    ...loop,
    settings: { ...loop.settings, maxLoopIterations: 0 },
  };
  const unboundedIssues = validateWorkflowShape(unbounded);
  assert.ok(unboundedIssues.some((issue) => issue.code === 'cycle' && issue.severity === 'error'));
  assert.ok(unboundedIssues.some((issue) => issue.code === 'invalid-config'));
  assert.equal(hasBlockingIssues(unboundedIssues), true);
});

test('self edges are rejected', () => {
  const issues = validateWorkflowShape(graph(
    [commandNode('a', { mode: 'hosts', hostIds: ['h1'] })],
    [link('a', 'a')],
  ));
  assert.ok(codes(issues).includes('self-edge'));
});

test('condition ports must be true/false and both branches are encouraged', () => {
  const issues = validateWorkflowShape(graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['h1'] }),
      conditionNode('check'),
      commandNode('yes', { mode: 'hosts', hostIds: ['h1'] }),
    ],
    [link('a', 'check'), link('check', 'yes')],
  ));
  assert.ok(codes(issues).includes('invalid-port'));
  const missing = issues.filter((issue) => issue.code === 'condition-port-missing');
  assert.deepEqual(missing.map((issue) => issue.severity), ['warning', 'warning']);
  assert.match(missing[0]?.message ?? '', /true branch/);
  assert.match(missing[1]?.message ?? '', /false branch/);
});

test('only condition nodes may use true/false outputs', () => {
  const issues = validateWorkflowShape(graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['h1'] }),
      commandNode('b', { mode: 'hosts', hostIds: ['h1'] }),
    ],
    [link('a', 'b', 'true')],
  ));
  assert.ok(codes(issues).includes('invalid-port'));
});

test('bad templates and missing configuration are errors', () => {
  const issues = validateWorkflowShape(graph([
    commandNode('bad-template', { mode: 'hosts', hostIds: ['h1'] }, 'run {{ nodes.nope.whatever }}'),
    commandNode('no-command', { mode: 'hosts', hostIds: ['h1'] }, '   '),
    commandNode('no-targets', { mode: 'hosts', hostIds: [] }),
    { ...conditionNode('no-right'), config: { kind: 'condition', left: 'x', operator: 'equals' } },
    {
      id: 'bad-delay',
      kind: 'delay',
      name: 'bad-delay',
      position: { x: 0, y: 0 },
      config: { kind: 'delay', ms: -1 },
    },
  ]));
  assert.ok(codes(issues).includes('template-invalid'));
  const invalid = issues.filter((issue) => issue.code === 'invalid-config');
  assert.equal(invalid.length, 4);
});

test('kind and configuration must agree', () => {
  const issues = validateWorkflowShape(graph([
    { ...conditionNode('mismatch'), kind: 'delay' },
  ]));
  assert.ok(codes(issues).includes('kind-mismatch'));
});

test('unconnected nodes and disabled nodes with downstream edges warn', () => {
  const issues = validateWorkflowShape(graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['h1'] }, 'echo hi'),
      { ...commandNode('b', { mode: 'hosts', hostIds: ['h1'] }), disabled: true },
      commandNode('c', { mode: 'hosts', hostIds: ['h1'] }),
    ],
    [link('b', 'c')],
  ));
  assert.ok(codes(issues).includes('orphan-node'));
  const disabled = issues.find((issue) => issue.code === 'disabled-node-with-downstream');
  assert.equal(disabled?.severity, 'warning');
});

test('node hosts resolve through explicit ids and group paths', () => {
  const explicit = commandNode('a', { mode: 'hosts', hostIds: ['h1'] });
  assert.deepEqual(resolveNodeHosts(explicit, hosts).map((entry) => entry.id), ['h1']);

  const grouped = commandNode('b', { mode: 'groups', groupPaths: ['Production/Web'] });
  assert.deepEqual(resolveNodeHosts(grouped, hosts).map((entry) => entry.id).sort(), ['h1', 'h2']);

  const all = commandNode('c', { mode: 'all' });
  assert.equal(resolveNodeHosts(all, hosts).some((entry) => entry.id === 'serial1'), false);

  const condition = conditionNode('d');
  assert.deepEqual(resolveNodeHosts(condition, hosts), []);
});

test('target validation flags unknown hosts and empty scopes', () => {
  const workflow = graph([
    commandNode('unknown', { mode: 'hosts', hostIds: ['ghost'] }),
    commandNode('serial-only', { mode: 'hosts', hostIds: ['serial1'] }),
    commandNode('empty-group', { mode: 'groups', groupPaths: ['Nobody'] }),
  ]);
  const issues = validateWorkflowTargets(workflow, { hosts });
  const unknown = issues.find((issue) => issue.code === 'unknown-host');
  assert.equal(unknown?.severity, 'error');
  assert.match(unknown?.message ?? '', /no longer exists/);

  const noTarget = issues.find((issue) => issue.code === 'no-target-host' && issue.nodeId === 'serial-only');
  assert.equal(noTarget?.severity, 'error');

  const group = issues.find((issue) => issue.code === 'unknown-group');
  assert.equal(group?.severity, 'warning');
});

test('target validation warns about hosts the exec channel cannot reach', () => {
  const workflow = graph([
    commandNode('jump', { mode: 'hosts', hostIds: ['behind-jump'] }),
    commandNode('telnet', { mode: 'hosts', hostIds: ['telnet1'] }),
    commandNode('mosh', { mode: 'hosts', hostIds: ['mosh1'] }),
  ]);
  const issues = validateWorkflowTargets(workflow, { hosts });
  // These now run inside an open terminal session, so they warn instead of
  // blocking the run outright.
  const chain = issues.find((issue) => issue.code === 'jump-chain-unsupported');
  assert.equal(chain?.nodeId, 'jump');
  assert.equal(chain?.severity, 'warning');
  const protocols = issues.filter((issue) => issue.code === 'unsupported-protocol');
  assert.deepEqual(protocols.map((issue) => issue.nodeId), ['telnet', 'mosh']);
  assert.ok(protocols.every((issue) => issue.severity === 'warning'));
});

test('commands matching a blocked pattern warn', () => {
  const workflow = graph([
    commandNode('restart', { mode: 'hosts', hostIds: ['h1'] }, 'sudo shutdown -r now'),
    commandNode('safe', { mode: 'hosts', hostIds: ['h1'] }, 'uptime'),
  ]);
  const issues = validateWorkflowTargets(workflow, { hosts, blockedPatterns: ['\\bshutdown\\b'] });
  const blocked = issues.filter((issue) => issue.code === 'blocked-command');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.nodeId, 'restart');
  assert.equal(blocked[0]?.severity, 'warning');
});

test('findBlockedCommandPattern ignores patterns that do not compile', () => {
  assert.equal(findBlockedCommandPattern('rm -rf /', ['\\brm\\s+-rf', '(']), '\\brm\\s+-rf');
  assert.equal(findBlockedCommandPattern('uptime', ['\\brm\\s+-rf']), null);
  assert.equal(findBlockedCommandPattern('SHUTDOWN now', ['\\bshutdown\\b']), '\\bshutdown\\b');
});

test('validateWorkflow merges shape and target checks', () => {
  const workflow = graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['ghost'] }),
      conditionNode('check'),
    ],
    [link('a', 'check')],
  );
  const shapeOnly = validateWorkflowShape(workflow);
  assert.equal(codes(shapeOnly).includes('unknown-host'), false);

  const combined = validateWorkflow(workflow, { hosts });
  assert.ok(codes(combined).includes('unknown-host'));
  assert.ok(codes(combined).includes('condition-port-missing'));
  assert.equal(hasBlockingIssues(combined), true);
});
