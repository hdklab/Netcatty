import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkflow, normalizeWorkflowList } from './serialize.ts';

const validNode = {
  id: 'n1',
  kind: 'hostCommand',
  name: 'Deploy',
  position: { x: 10, y: 20 },
  config: {
    kind: 'hostCommand',
    targets: { mode: 'hosts', hostIds: ['h1'] },
    command: 'echo hi',
  },
};

const validWorkflow = {
  id: 'w1',
  name: 'Release',
  nodes: [validNode],
  edges: [],
  settings: { concurrency: 2, onError: 'continue', variables: { region: 'cn' } },
  createdAt: 100,
  updatedAt: 200,
  revision: 3,
};

test('a well-formed workflow survives a round trip', () => {
  const workflow = normalizeWorkflow(validWorkflow, 'fallback');
  assert.ok(workflow);
  assert.equal(workflow.id, 'w1');
  assert.equal(workflow.name, 'Release');
  assert.equal(workflow.nodes.length, 1);
  assert.equal(workflow.nodes[0]?.kind, 'hostCommand');
  assert.equal(workflow.settings.concurrency, 2);
  assert.equal(workflow.settings.onError, 'continue');
  assert.deepEqual(workflow.settings.variables, { region: 'cn' });
  assert.equal(workflow.revision, 3);
});

test('defaults are filled in for missing settings', () => {
  const workflow = normalizeWorkflow({ ...validWorkflow, settings: undefined }, 'fallback');
  assert.equal(workflow?.settings.concurrency, 4);
  assert.equal(workflow?.settings.onError, 'stop');
  assert.equal(workflow?.settings.variables, undefined);
  // A stored revision is kept; only a missing one falls back to 1.
  assert.equal(workflow?.revision, 3);

  const fresh = normalizeWorkflow({
    ...validWorkflow,
    settings: undefined,
    revision: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  }, 'fallback');
  assert.equal(fresh?.revision, 1);
  assert.equal(fresh?.createdAt, 0);
});

test('unknown node kinds and broken configs are dropped, not fatal', () => {
  const workflow = normalizeWorkflow({
    ...validWorkflow,
    nodes: [
      validNode,
      { ...validNode, id: 'n2', kind: 'teleport' },
      { ...validNode, id: 'n3', config: undefined },
      { ...validNode, id: '' },
      'not-a-node',
    ],
  }, 'fallback');
  assert.deepEqual(workflow?.nodes.map((node) => node.id), ['n1']);
});

test('edges referencing missing nodes are dropped', () => {
  const workflow = normalizeWorkflow({
    ...validWorkflow,
    edges: [
      { id: 'e1', from: { nodeId: 'n1', output: 'main' }, to: { nodeId: 'ghost', input: 'main' } },
      { id: 'e2', from: { nodeId: 'n1', output: 'sideways' }, to: { nodeId: 'n1', input: 'main' } },
    ],
  }, 'fallback');
  // The second edge connects existing nodes, so only the unknown output port is normalized.
  assert.equal(workflow?.edges.length, 1);
  assert.equal(workflow?.edges[0]?.id, 'e2');
  assert.equal(workflow?.edges[0]?.from.output, 'main');
});

test('a workflow with no salvageable node is rejected', () => {
  assert.equal(normalizeWorkflow({ nodes: [] }, 'fallback'), null);
  assert.equal(normalizeWorkflow(null, 'fallback'), null);
  assert.equal(normalizeWorkflow('nonsense', 'fallback'), null);
});

test('the list drops invalid entries and duplicate ids', () => {
  const list = normalizeWorkflowList([validWorkflow, validWorkflow, { nodes: [] }, null]);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'w1');
  assert.deepEqual(normalizeWorkflowList('nope'), []);
});

test('condition operators fall back to a known value', () => {
  const workflow = normalizeWorkflow({
    ...validWorkflow,
    nodes: [
      {
        id: 'c1',
        kind: 'condition',
        name: 'check',
        position: { x: 0, y: 0 },
        config: { kind: 'condition', left: '{{ nodes.n1.stdout }}', operator: 'wat', right: 'x' },
      },
    ],
  }, 'fallback');
  const config = workflow?.nodes[0]?.config;
  assert.equal(config?.kind === 'condition' ? config.operator : null, 'contains');
});

test('retry and error policy are preserved when valid, dropped when not', () => {
  const workflow = normalizeWorkflow({
    ...validWorkflow,
    nodes: [
      { ...validNode, onError: 'errorPort', retry: { maxAttempts: 3, delayMs: 500 }, timeoutMs: 9000 },
      { ...validNode, id: 'n9', onError: 'sometimes', retry: { maxAttempts: 0, delayMs: 1 } },
    ],
  }, 'fallback');
  assert.equal(workflow?.nodes[0]?.onError, 'errorPort');
  assert.deepEqual(workflow?.nodes[0]?.retry, { maxAttempts: 3, delayMs: 500 });
  assert.equal(workflow?.nodes[0]?.timeoutMs, 9000);
  assert.equal(workflow?.nodes[1]?.onError, undefined);
  assert.equal(workflow?.nodes[1]?.retry, undefined);
});
