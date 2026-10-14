import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findTemplateTokens,
  interpolateTemplate,
  resolveToken,
  validateTemplate,
} from './expression.ts';
import type { NodeRunResult } from './types.ts';

const nodeResults: Record<string, NodeRunResult> = {
  check: {
    nodeId: 'check',
    status: 'success',
    outputPort: 'main',
    hosts: [
      {
        hostId: 'h1',
        hostLabel: 'web-1',
        ok: true,
        exitCode: 0,
        stdout: 'line1\nline2\nline3\n',
        stderr: '',
        durationMs: 12,
        attempts: 1,
      },
      {
        hostId: 'h2',
        hostLabel: 'web-2',
        ok: false,
        exitCode: 3,
        stdout: 'boom\n',
        stderr: 'err\n',
        durationMs: 30,
        attempts: 2,
      },
    ],
  },
};

const context = {
  nodeResults,
  variables: { region: 'cn-north' },
  runId: 'run-1',
  runStartedAt: 1700000000000,
};

test('findTemplateTokens extracts every token body', () => {
  assert.deepEqual(
    findTemplateTokens('a {{ nodes.one.stdout }} b {{ workflow.vars.x }} c'),
    ['nodes.one.stdout', 'workflow.vars.x'],
  );
  assert.deepEqual(findTemplateTokens('no tokens here'), []);
});

test('interpolateTemplate resolves node and run references', () => {
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | trim }}', context).value, 'line1\nline2\nline3\n\nboom');
  assert.equal(interpolateTemplate('{{ nodes.check.exitCode }}', context).value, '0,3');
  assert.equal(interpolateTemplate('{{ nodes.check.ok }}', context).value, 'false');
  assert.equal(interpolateTemplate('{{ nodes.check.hosts.h1.stdout | trim }}', context).value, 'line1\nline2\nline3');
  assert.equal(interpolateTemplate('deploy to {{ workflow.vars.region }}', context).value, 'deploy to cn-north');
  assert.equal(interpolateTemplate('{{ run.id }}', context).value, 'run-1');
  assert.equal(interpolateTemplate('{{ run.startedAt }}', context).value, '1700000000000');
});

test('interpolateTemplate applies filters in order', () => {
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | head(2) | trim }}', context).value, 'line1\nline2');
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | tail(1) | trim }}', context).value, '');
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | trim | tail(1) }}', context).value, 'boom');
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | match(/line(\\d)/) }}', context).value, '1');
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | upper | match(/LINE1/) }}', context).value, 'LINE1');
});

test('default() fills in values that resolve to nothing', () => {
  assert.equal(interpolateTemplate('{{ nodes.missing.stdout | default("fallback") }}', context).value, 'fallback');
  assert.equal(interpolateTemplate('{{ nodes.check.stdout | default("fallback") | trim | head(1) }}', context).value, 'line1');
  assert.equal(interpolateTemplate('{{ nodes.check.hosts.nope.stdout | default("x") }}', context).value, 'x');
});

test('a vertical bar inside a regex argument does not split filters', () => {
  const result = interpolateTemplate('{{ nodes.check.stdout | match(/line1|boom/) }}', context);
  assert.deepEqual(result.issues, []);
  assert.equal(result.value, 'line1');
  assert.deepEqual(validateTemplate('{{ nodes.check.stdout | match(/line1|boom/) }}'), []);
});

test('unresolvable references are reported and interpolate to empty text', () => {
  const unknownRoot = interpolateTemplate('value={{ nope.field }}', context);
  assert.equal(unknownRoot.ok, false);
  assert.equal(unknownRoot.value, 'value=');
  assert.equal(unknownRoot.issues[0]?.message, 'Unknown reference root "nope"');

  const unknownFilter = interpolateTemplate('{{ nodes.check.stdout | nope }}', context);
  assert.equal(unknownFilter.ok, false);
  assert.equal(unknownFilter.issues[0]?.message, 'Unknown filter "nope"');

  const unknownNode = interpolateTemplate('{{ nodes.ghost.stdout }}', context);
  assert.equal(unknownNode.issues[0]?.message, 'Unknown node "ghost"');
  assert.equal(interpolateTemplate('{{ nodes.ghost.stdout | default("none") }}', context).ok, true);
});

test('validateTemplate rejects malformed paths and filters without run data', () => {
  assert.deepEqual(validateTemplate('{{ nodes.a.stdout }}'), []);
  assert.deepEqual(validateTemplate('{{ nodes.a.hosts.h1.ok }}'), []);
  assert.equal(validateTemplate('{{ nodes.a }}')[0]?.message, 'Use nodes.<nodeId>.<field>');
  assert.equal(
    validateTemplate('{{ nodes.a.hosts.h1.nope }}')[0]?.message,
    'Use nodes.<nodeId>.hosts.<hostId>.<stdout|stderr|exitCode|ok>',
  );
  assert.equal(validateTemplate('{{ workflow.foo }}')[0]?.message, 'Use workflow.vars.<name>');
  assert.equal(validateTemplate('{{ run.url }}')[0]?.message, 'Use run.id or run.startedAt');
  assert.equal(validateTemplate('{{ nodes.a.stdout | head(x) }}')[0]?.message, 'Filter "head" needs a line count');
  assert.equal(validateTemplate('{{ nodes.a.stdout | match(xyz) }}')[0]?.message, 'match() needs /regex/');
  assert.equal(validateTemplate('{{ nodes.a.stdout | match(/[/ }}')[0]?.message, 'Unterminated filter "match(/[/"');
  assert.equal(validateTemplate('{{ nodes.a.stdout | default(x) }}')[0]?.message, 'default() needs a quoted string');
});

test('resolveToken reports a single issue per token', () => {
  const resolved = resolveToken('nodes.check.stdout | head(1)', context);
  assert.deepEqual(resolved.issues, []);
  assert.equal(resolved.value, 'line1');

  const broken = resolveToken('nodes.check.stdout | head(x)', context);
  assert.equal(broken.issues.length, 1);
  assert.equal(broken.value, '');
});
