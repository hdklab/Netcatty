import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectBusyHostIds,
  computeReadyNodes,
  findCycleNodeIds,
  isRunSettled,
  orderWorkflowNodes,
  summarizeRun,
} from './runPlan.ts';
import type {
  NodeState,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowOutputPort,
} from './types.ts';

function commandNode(id: string, hostIds: string[] = [], extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    kind: 'hostCommand',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'hostCommand', targets: { mode: 'hosts', hostIds }, command: 'echo hi' },
    ...extra,
  };
}

function conditionNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'condition',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'condition', left: '{{ nodes.a.stdout }}', operator: 'truthy' },
  };
}

function link(from: string, to: string, output: WorkflowOutputPort = 'main'): WorkflowEdge {
  return { id: `${from}->${to}:${output}`, from: { nodeId: from, output }, to: { nodeId: to, input: 'main' } };
}

function graph(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
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

const resolveHostIds = (node: WorkflowNode): string[] =>
  node.config.kind === 'hostCommand' ? node.config.targets.hostIds ?? [] : [];

const pending = (ids: string[]): Record<string, NodeState> =>
  Object.fromEntries(ids.map((id) => [id, { status: 'pending' as const }]));

test('a linear chain releases one node per settled step', () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c')],
    [link('a', 'b'), link('b', 'c')],
  );

  const first = computeReadyNodes({ workflow, states: pending(['a', 'b', 'c']), resolveHostIds });
  assert.deepEqual(first.ready, ['a']);
  assert.deepEqual(first.skips, []);

  const second = computeReadyNodes({
    workflow,
    states: { a: { status: 'success', outputPort: 'main' }, b: { status: 'pending' }, c: { status: 'pending' } },
    resolveHostIds,
  });
  assert.deepEqual(second.ready, ['b']);
});

test('independent branches become ready together', () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c'), commandNode('d')],
    [link('a', 'b'), link('a', 'c'), link('a', 'd')],
  );
  const plan = computeReadyNodes({
    workflow,
    states: { ...pending(['b', 'c', 'd']), a: { status: 'success', outputPort: 'main' } },
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, ['b', 'c', 'd']);
});

test('a condition only releases the branch it took', () => {
  const workflow = graph(
    [commandNode('a'), conditionNode('check'), commandNode('yes'), commandNode('no')],
    [link('a', 'check'), link('check', 'yes', 'true'), link('check', 'no', 'false')],
  );
  const plan = computeReadyNodes({
    workflow,
    states: {
      a: { status: 'success', outputPort: 'main' },
      check: { status: 'success', outputPort: 'true' },
      yes: { status: 'pending' },
      no: { status: 'pending' },
    },
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, ['yes']);
  assert.deepEqual(plan.skips, [{ nodeId: 'no', reason: 'condition-false' }]);
});

test('a failing node skips its downstream when the policy is stop', () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  const plan = computeReadyNodes({
    workflow,
    states: { a: { status: 'failed' }, b: { status: 'pending' } },
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, []);
  assert.deepEqual(plan.skips, [{ nodeId: 'b', reason: 'upstream-failed' }]);
});

test('errorPort routes a failure to the error branch and skips main', () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('handler')],
    [link('a', 'b'), link('a', 'handler', 'error')],
  );
  const plan = computeReadyNodes({
    workflow,
    states: { a: { status: 'failed', outputPort: 'error' }, b: { status: 'pending' }, handler: { status: 'pending' } },
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, ['handler']);
  assert.deepEqual(plan.skips, [{ nodeId: 'b', reason: 'upstream-failed' }]);
});

test('the continue policy keeps main active after a failure', () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  const plan = computeReadyNodes({
    workflow,
    states: { a: { status: 'failed', outputPort: 'main' }, b: { status: 'pending' } },
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, ['b']);
  assert.deepEqual(plan.skips, []);
});

test('disabled nodes are skipped and cascade as upstream-skipped', () => {
  const workflow = graph(
    [commandNode('a', [], { disabled: true }), commandNode('b')],
    [link('a', 'b')],
  );
  const first = computeReadyNodes({ workflow, states: pending(['a', 'b']), resolveHostIds });
  assert.deepEqual(first.ready, []);
  assert.deepEqual(first.skips, [{ nodeId: 'a', reason: 'disabled' }]);

  const second = computeReadyNodes({
    workflow,
    states: { a: { status: 'skipped' }, b: { status: 'pending' } },
    resolveHostIds,
  });
  assert.deepEqual(second.skips, [{ nodeId: 'b', reason: 'upstream-skipped' }]);
});

test('a node touching a busy host waits instead of running', () => {
  const workflow = graph(
    [commandNode('a', ['h1']), commandNode('b', ['h1']), commandNode('c', ['h2'])],
    [link('a', 'b'), link('a', 'c')],
  );
  const plan = computeReadyNodes({
    workflow,
    states: { ...pending(['b', 'c']), a: { status: 'success', outputPort: 'main' } },
    busyHostIds: new Set(['h1']),
    resolveHostIds,
  });
  assert.deepEqual(plan.ready, ['c']);
  assert.deepEqual(plan.blockedByHost, ['b']);
});

test('maxParallel caps how many nodes start at once', () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c'), commandNode('d')],
    [link('a', 'b'), link('a', 'c'), link('a', 'd')],
  );
  const plan = computeReadyNodes({
    workflow,
    states: { ...pending(['b', 'c', 'd']), a: { status: 'success', outputPort: 'main' } },
    resolveHostIds,
    maxParallel: 2,
  });
  assert.deepEqual(plan.ready, ['b', 'c']);
  assert.deepEqual(plan.blockedByHost, ['d']);
});

test('nodes without incoming edges are start nodes', () => {
  const workflow = graph([commandNode('a'), commandNode('b'), commandNode('c')], [link('a', 'c')]);
  const plan = computeReadyNodes({ workflow, states: pending(['a', 'b', 'c']), resolveHostIds });
  assert.deepEqual(plan.ready, ['a', 'b']);
});

test('a loop edge is ignored when deciding what may run', () => {
  // a -> b is the chain, b -> a is the retry edge the user drew.
  const workflow = graph(
    [commandNode('a'), commandNode('b')],
    [link('a', 'b'), link('b', 'a')],
  );
  const backEdgeIds = new Set(['b->a:main']);
  const first = computeReadyNodes({
    workflow,
    states: pending(['a', 'b']),
    resolveHostIds,
    backEdgeIds,
  });
  assert.deepEqual(first.ready, ['a']);

  const second = computeReadyNodes({
    workflow,
    states: { a: { status: 'success', outputPort: 'main' }, b: { status: 'pending' } },
    resolveHostIds,
    backEdgeIds,
  });
  assert.deepEqual(second.ready, ['b']);
});

test('collectBusyHostIds covers running and waiting nodes', () => {
  const workflow = graph([commandNode('a', ['h1']), commandNode('b', ['h2']), commandNode('c', ['h3'])], []);
  const busy = collectBusyHostIds(
    workflow,
    { a: { status: 'running' }, b: { status: 'waiting' }, c: { status: 'success', outputPort: 'main' } },
    resolveHostIds,
  );
  assert.deepEqual([...busy].sort(), ['h1', 'h2']);
});

test('orderWorkflowNodes reports cycles and names their members', () => {
  const acyclic = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  assert.deepEqual(orderWorkflowNodes(acyclic), { order: ['a', 'b'], cyclic: false });
  assert.deepEqual(findCycleNodeIds(acyclic), []);

  const cyclic = graph(
    [commandNode('a'), commandNode('b'), commandNode('c')],
    [link('a', 'b'), link('b', 'c'), link('c', 'a')],
  );
  assert.equal(orderWorkflowNodes(cyclic).cyclic, true);
  assert.deepEqual(findCycleNodeIds(cyclic).sort(), ['a', 'b', 'c']);
});

test('run settlement and summary follow node states', () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  assert.equal(isRunSettled(workflow, { a: { status: 'success', outputPort: 'main' } }), false);
  assert.equal(
    isRunSettled(workflow, { a: { status: 'success', outputPort: 'main' }, b: { status: 'skipped' } }),
    true,
  );
  assert.equal(summarizeRun(workflow, { a: { status: 'success', outputPort: 'main' }, b: { status: 'skipped' } }), 'success');
  assert.equal(summarizeRun(workflow, { a: { status: 'failed' }, b: { status: 'skipped' } }), 'failed');
});
