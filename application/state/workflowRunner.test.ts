import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host } from '@/domain/models';
import type {
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTargetSelection,
} from '@/domain/workflow/types.ts';
import {
  runWorkflow,
  type WorkflowCommandRequest,
  type WorkflowCommandResult,
  type WorkflowExecutor,
} from './workflowRunner.ts';

function host(id: string): Host {
  return {
    id,
    label: id,
    hostname: `${id}.example`,
    username: 'root',
    os: 'linux',
    protocol: 'ssh',
    tags: [],
  };
}

const hosts: Host[] = [host('h1'), host('h2')];

function commandNode(
  id: string,
  selection: WorkflowTargetSelection = { mode: 'hosts', hostIds: ['h1'] },
  extra: Partial<WorkflowNode> = {},
  command = 'echo hi',
): WorkflowNode {
  return {
    id,
    kind: 'hostCommand',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'hostCommand', targets: selection, command },
    ...extra,
  };
}

function conditionNode(id: string, left: string, right: string): WorkflowNode {
  return {
    id,
    kind: 'condition',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'condition', left, operator: 'contains', right },
  };
}

function delayNode(id: string, ms: number): WorkflowNode {
  return {
    id,
    kind: 'delay',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'delay', ms },
  };
}

function manualNode(id: string): WorkflowNode {
  return {
    id,
    kind: 'manual',
    name: id,
    position: { x: 0, y: 0 },
    config: { kind: 'manual', message: 'go?' },
  };
}

function link(from: string, to: string, output: WorkflowEdge['from']['output'] = 'main'): WorkflowEdge {
  return { id: `${from}->${to}:${output}`, from: { nodeId: from, output }, to: { nodeId: to, input: 'main' } };
}

function graph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  concurrency = 4,
  maxLoopIterations?: number,
): Workflow {
  return {
    id: 'w1',
    name: 'w1',
    nodes,
    edges,
    settings: {
      concurrency,
      onError: 'stop',
      ...(maxLoopIterations === undefined ? {} : { maxLoopIterations }),
    },
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    schema: 1,
  };
}

interface FakeExecutorOptions {
  respond?: (request: WorkflowCommandRequest) => Promise<WorkflowCommandResult> | WorkflowCommandResult;
  confirm?: () => Promise<boolean>;
  sleep?: (ms: number) => void;
}

function createFakeExecutor(options: FakeExecutorOptions = {}) {
  const calls: Array<{ node: string; host: string; command: string; order: number }> = [];
  const sleeps: number[] = [];
  let order = 0;
  const executor: WorkflowExecutor = {
    async runCommand(request) {
      calls.push({ node: request.node.name, host: request.host.id, command: request.command, order: order++ });
      if (options.respond) return options.respond(request);
      return { exitCode: 0, stdout: '' };
    },
    async sleep(ms) {
      sleeps.push(ms);
      options.sleep?.(ms);
    },
    async confirm() {
      return options.confirm ? options.confirm() : true;
    },
  };
  return { executor, calls, sleeps };
}

const runIds = { runId: 'run-test', now: () => 0 };

test('a linear chain runs its nodes in dependency order', async () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c')],
    [link('a', 'b'), link('b', 'c')],
  );
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['a', 'b', 'c']);
  assert.equal(run.status, 'success');
  assert.equal(run.nodeRuns.a?.status, 'success');
  assert.equal(run.nodeRuns.a?.outputPort, 'main');
});

test('independent branches start without waiting for each other', async () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c')],
    [link('a', 'b'), link('a', 'c')],
  );
  const { executor, calls } = createFakeExecutor();
  await runWorkflow({ workflow, hosts, executor, ...runIds });

  const orderOf = (name: string) => calls.findIndex((call) => call.node === name);
  assert.equal(orderOf('a'), 0);
  assert.ok(orderOf('b') > orderOf('a'));
  assert.ok(orderOf('c') > orderOf('a'));
  assert.deepEqual(calls.filter((call) => call.node !== 'a').map((call) => call.node).sort(), ['b', 'c']);
});

test('node targets fan out over their hosts', async () => {
  const workflow = graph([commandNode('a', { mode: 'hosts', hostIds: ['h1', 'h2'] })], []);
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.host).sort(), ['h1', 'h2']);
  assert.equal(run.nodeRuns.a?.hosts.length, 2);
  assert.equal(run.nodeRuns.a?.hosts.every((entry) => entry.ok), true);
});

test('a condition releases only the branch it took', async () => {
  const workflow = graph(
    [
      commandNode('probe'),
      conditionNode('check', '{{ nodes.probe.stdout }}', 'READY'),
      commandNode('yes'),
      commandNode('no'),
    ],
    [link('probe', 'check'), link('check', 'yes', 'true'), link('check', 'no', 'false')],
  );
  const { executor, calls } = createFakeExecutor({
    respond: (request) => ({ exitCode: 0, stdout: request.node.name === 'probe' ? 'status: READY\n' : '' }),
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['probe', 'yes']);
  assert.equal(run.nodeRuns.check?.outputPort, 'true');
  assert.equal(run.nodeRuns.no?.status, 'skipped');
  assert.equal(run.nodeRuns.no?.skippedReason, 'condition-false');
  assert.equal(run.status, 'success');
});

test('a failing host stops the chain and the run reports failure', async () => {
  const workflow = graph([commandNode('a'), commandNode('b'), commandNode('c')], [link('a', 'b'), link('b', 'c')]);
  const { executor, calls } = createFakeExecutor({
    respond: (request) => (request.node.name === 'a' ? { exitCode: 1, stderr: 'boom' } : { exitCode: 0 }),
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['a']);
  assert.equal(run.nodeRuns.a?.status, 'failed');
  assert.match(run.nodeRuns.a?.error ?? '', /Exit code 1/);
  assert.equal(run.nodeRuns.b?.status, 'skipped');
  assert.equal(run.nodeRuns.b?.skippedReason, 'upstream-failed');
  assert.equal(run.nodeRuns.c?.status, 'skipped');
  assert.equal(run.status, 'failed');
});

test('the error port diverts a failure away from the main branch', async () => {
  const workflow = graph(
    [commandNode('a', undefined, { onError: 'errorPort' }), commandNode('b'), commandNode('handler')],
    [link('a', 'b'), link('a', 'handler', 'error')],
  );
  const { executor, calls } = createFakeExecutor({
    respond: (request) => (request.node.name === 'a' ? { exitCode: 2 } : { exitCode: 0 }),
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node).sort(), ['a', 'handler']);
  assert.equal(run.nodeRuns.a?.outputPort, 'error');
  assert.equal(run.nodeRuns.b?.status, 'skipped');
  assert.equal(run.nodeRuns.handler?.status, 'success');
});

test('the continue policy keeps downstream nodes running after a failure', async () => {
  const workflow = graph([commandNode('a', undefined, { onError: 'continue' }), commandNode('b')], [link('a', 'b')]);
  const { executor, calls } = createFakeExecutor({
    respond: (request) => (request.node.name === 'a' ? { exitCode: 1 } : { exitCode: 0 }),
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['a', 'b']);
  assert.equal(run.nodeRuns.a?.status, 'failed');
  assert.equal(run.nodeRuns.b?.status, 'success');
  assert.equal(run.status, 'failed');
});

test('retry reruns a failing host before giving up', async () => {
  const workflow = graph(
    [commandNode('a', undefined, { retry: { maxAttempts: 3, delayMs: 10 } })],
    [],
  );
  let attempts = 0;
  const { executor, sleeps } = createFakeExecutor({
    respond: () => {
      attempts += 1;
      return attempts < 3 ? { exitCode: 1 } : { exitCode: 0 };
    },
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.equal(attempts, 3);
  assert.equal(run.nodeRuns.a?.status, 'success');
  assert.equal(run.nodeRuns.a?.hosts[0]?.attempts, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

test('failFast leaves the untouched hosts recorded as skipped', async () => {
  const fanOut: WorkflowNode = {
    id: 'a',
    kind: 'hostCommand',
    name: 'a',
    position: { x: 0, y: 0 },
    config: {
      kind: 'hostCommand',
      targets: { mode: 'hosts', hostIds: ['h1', 'h2'] },
      command: 'echo hi',
      failFast: true,
      // Serial, otherwise both hosts are already in flight before the first failure lands.
      concurrency: 1,
    },
  };
  const workflow = graph([fanOut], []);
  const { executor } = createFakeExecutor({
    respond: (request) => (request.host.id === 'h1' ? { exitCode: 1 } : { exitCode: 0 }),
  });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  const results = run.nodeRuns.a?.hosts ?? [];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[1]?.error, 'Skipped after a failing host');
});

test('two nodes touching the same host never run concurrently', async () => {
  const workflow = graph(
    [
      commandNode('a', { mode: 'hosts', hostIds: ['h1'] }),
      commandNode('b', { mode: 'hosts', hostIds: ['h1'] }),
    ],
    [],
  );
  let active = 0;
  let peak = 0;
  const { executor } = createFakeExecutor({
    respond: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { exitCode: 0 };
    },
  });
  await runWorkflow({ workflow, hosts, executor, ...runIds });
  assert.equal(peak, 1);
});

test('interpolated commands receive upstream output', async () => {
  const workflow = graph(
    [
      commandNode('build'),
      commandNode('deploy', undefined, {}, 'deploy {{ nodes.build.stdout | trim }}'),
    ],
    [link('build', 'deploy')],
  );
  const { executor, calls } = createFakeExecutor({
    respond: (request) => ({ exitCode: 0, stdout: request.node.name === 'build' ? 'app-1.2.3.tgz\n' : '' }),
  });
  await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.equal(calls.find((call) => call.node === 'deploy')?.command, 'deploy app-1.2.3.tgz');
});

test('an unknown reference fails the node instead of running a broken command', async () => {
  const workflow = graph([commandNode('a', undefined, {}, 'deploy {{ nodes.missing.stdout }}')], []);
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls, []);
  assert.equal(run.nodeRuns.a?.status, 'failed');
  assert.match(run.nodeRuns.a?.error ?? '', /Unknown node "missing"/);
  assert.equal(run.status, 'failed');
});

test('delay nodes wait and manual nodes can be declined', async () => {
  const workflow = graph(
    [delayNode('wait', 2500), manualNode('approve'), commandNode('a')],
    [link('wait', 'approve'), link('approve', 'a')],
  );
  const { executor, calls, sleeps } = createFakeExecutor({ confirm: async () => false });
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(sleeps, [2500]);
  assert.equal(run.nodeRuns.wait?.status, 'success');
  assert.equal(run.nodeRuns.approve?.status, 'skipped');
  assert.equal(run.nodeRuns.approve?.skippedReason, 'manual-declined');
  assert.deepEqual(calls, []);
  assert.equal(run.status, 'success');
});

test('disabled nodes are skipped and cascade to their downstream', async () => {
  const workflow = graph(
    [commandNode('a', undefined, { disabled: true }), commandNode('b')],
    [link('a', 'b')],
  );
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls, []);
  assert.equal(run.nodeRuns.a?.skippedReason, 'disabled');
  assert.equal(run.nodeRuns.b?.skippedReason, 'upstream-skipped');
});

test('previous results are reused instead of re-executing nodes', async () => {
  const workflow = graph([commandNode('a'), commandNode('b'), commandNode('c')], [link('a', 'b'), link('b', 'c')]);
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({
    workflow,
    hosts,
    executor,
    ...runIds,
    previousResults: {
      a: { nodeId: 'a', status: 'success', outputPort: 'main', hosts: [], endedAt: 1 },
    },
  });

  assert.deepEqual(calls.map((call) => call.node), ['b', 'c']);
  assert.equal(run.nodeRuns.a?.status, 'success');
});

test('an abort cancels the run and marks untouched nodes as cancelled', async () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: WorkflowExecutor = {
    async runCommand(request) {
      if (request.node.name === 'a') await gate;
      return { exitCode: 0 };
    },
    async sleep() {},
    async confirm() {
      return true;
    },
  };

  const promise = runWorkflow({ workflow, hosts, executor, ...runIds, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  release?.();
  const run = await promise;

  assert.equal(run.status, 'cancelled');
  assert.equal(run.nodeRuns.b?.status, 'skipped');
  assert.equal(run.nodeRuns.b?.skippedReason, 'cancelled');
});

test('run updates are emitted as immutable snapshots', async () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b')]);
  const { executor } = createFakeExecutor();
  const snapshots: string[] = [];
  await runWorkflow({
    workflow,
    hosts,
    executor,
    ...runIds,
    onUpdate: (run) => snapshots.push(`${run.nodeRuns.a?.status}:${run.nodeRuns.b?.status}`),
  });

  assert.ok(snapshots.length > 2);
  assert.equal(snapshots[0], 'pending:pending');
  assert.equal(snapshots.at(-1), 'success:success');
});

/* ------------------------------------------------------------------ */
/* Loops (a failing node restarting the step it points back into)      */
/* ------------------------------------------------------------------ */

test('a failing node restarts the loop it points back into', async () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b')],
    [link('a', 'b'), link('b', 'a')],
  );
  let attempts = 0;
  const { executor, calls } = createFakeExecutor({
    respond: (request) => {
      if (request.node.name !== 'b') return { exitCode: 0 };
      attempts += 1;
      return attempts === 1 ? { exitCode: 1, stderr: 'not ready' } : { exitCode: 0 };
    },
  });

  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['a', 'b', 'a', 'b']);
  assert.equal(run.status, 'success');
  assert.equal(run.nodeRuns.b?.status, 'success');
  assert.ok(run.log.some((entry) => /restarting from a \(attempt 2 of 3\)/.test(entry.message)));
});

test('a loop that succeeds first time never restarts', async () => {
  const workflow = graph([commandNode('a'), commandNode('b')], [link('a', 'b'), link('b', 'a')]);
  const { executor, calls } = createFakeExecutor();
  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(calls.map((call) => call.node), ['a', 'b']);
  assert.equal(run.status, 'success');
});

test('the loop stops once the attempt budget is used up', async () => {
  const workflow = graph(
    [commandNode('a'), commandNode('b'), commandNode('c')],
    [link('a', 'b'), link('b', 'c'), link('c', 'a')],
    4,
    2,
  );
  const { executor, calls } = createFakeExecutor({
    respond: (request) => (request.node.name === 'c' ? { exitCode: 1 } : { exitCode: 0 }),
  });

  const run = await runWorkflow({ workflow, hosts, executor, ...runIds });

  // a, b, c, then the loop restarts a and b before c fails for the second time.
  assert.deepEqual(calls.map((call) => call.node), ['a', 'b', 'c', 'a', 'b', 'c']);
  assert.equal(run.status, 'failed');
  assert.equal(run.nodeRuns.c?.status, 'failed');
  assert.ok(run.log.some((entry) => /loop budget \(2\) is used up/.test(entry.message)));
});

test('loop.iteration is exposed to node commands', async () => {
  const workflow = graph(
    [commandNode('a', undefined, {}, 'echo attempt {{ loop.iteration }}'), commandNode('b')],
    [link('a', 'b'), link('b', 'a')],
  );
  const { executor, calls } = createFakeExecutor({
    respond: (request) => (request.node.name === 'b'
      ? { exitCode: calls.filter((call) => call.node === 'b').length > 1 ? 0 : 1 }
      : { exitCode: 0 }),
  });

  await runWorkflow({ workflow, hosts, executor, ...runIds });

  assert.deepEqual(
    calls.filter((call) => call.node === 'a').map((call) => call.command),
    ['echo attempt 1', 'echo attempt 2'],
  );
});
