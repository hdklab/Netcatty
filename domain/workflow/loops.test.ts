import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDownstreamNodeIds, findBackEdges, findBackEdgesFrom, restartTargetsFor } from './loops.ts';
import type { Workflow, WorkflowEdge, WorkflowNode } from './types.ts';

function node(id: string): WorkflowNode {
  return {
    id,
    kind: 'hostCommand',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'hostCommand', targets: { mode: 'hosts', hostIds: ['h1'] }, command: 'echo' },
  };
}

function link(from: string, to: string): WorkflowEdge {
  return { id: `${from}->${to}`, from: { nodeId: from, output: 'main' }, to: { nodeId: to, input: 'main' } };
}

function graph(nodes: string[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'w',
    name: 'w',
    nodes: nodes.map(node),
    edges,
    settings: { concurrency: 4, onError: 'stop', maxLoopIterations: 3 },
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    schema: 1,
  };
}

test('an acyclic graph has no back edges', () => {
  const workflow = graph(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c')]);
  assert.deepEqual([...findBackEdges(workflow)], []);
});

test('the edge that closes a loop is the back edge', () => {
  const workflow = graph(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c'), link('c', 'a')]);
  assert.deepEqual([...findBackEdges(workflow)], ['c->a']);
});

test('a loop inside a bigger graph keeps its unrelated edges forward', () => {
  const workflow = graph(
    ['a', 'b', 'c', 'd'],
    [link('a', 'b'), link('b', 'c'), link('c', 'b'), link('b', 'd')],
  );
  assert.deepEqual([...findBackEdges(workflow)], ['c->b']);
});

test('restart targets come from the failing node only', () => {
  const workflow = graph(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c'), link('c', 'a')]);
  const backEdges = findBackEdges(workflow);
  assert.deepEqual(restartTargetsFor(workflow, 'c', backEdges), ['a']);
  assert.deepEqual(restartTargetsFor(workflow, 'b', backEdges), []);
  assert.deepEqual(findBackEdgesFrom(workflow, 'c', backEdges).map((edge) => edge.id), ['c->a']);
});

test('downstream collection walks forward edges only', () => {
  const workflow = graph(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c'), link('c', 'a')]);
  const backEdges = findBackEdges(workflow);
  assert.deepEqual([...collectDownstreamNodeIds(workflow, ['a'], { excludedEdgeIds: backEdges })].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...collectDownstreamNodeIds(workflow, ['b'], { excludedEdgeIds: backEdges })].sort(), ['b', 'c']);
  // Without excluding the back edge the walk would circle back to 'a'.
  assert.deepEqual([...collectDownstreamNodeIds(workflow, ['b'])].sort(), ['a', 'b', 'c']);
});

test('a node can restart from several targets', () => {
  const workflow = graph(
    ['a', 'b', 'c', 'd'],
    [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('c', 'a'), link('d', 'b')],
  );
  const backEdges = findBackEdges(workflow);
  const targets = restartTargetsFor(workflow, 'c', backEdges).concat(restartTargetsFor(workflow, 'd', backEdges));
  assert.deepEqual([...new Set(targets)].sort(), ['a', 'b']);
});
