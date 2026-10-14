import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExecutionChannel, type ChannelHost } from './channel.ts';

function host(overrides: Partial<ChannelHost> = {}): ChannelHost {
  return {
    protocol: 'ssh',
    hostname: 'host.example',
    ...overrides,
  };
}

test('a direct ssh host uses the exec channel without needing a session', () => {
  assert.equal(resolveExecutionChannel({ host: host(), hasOpenSession: false }), 'exec');
  assert.equal(resolveExecutionChannel({ host: host(), hasOpenSession: true }), 'exec');
});

test('a host behind a jump chain needs an open session', () => {
  const chained = host({ hostChain: { hostIds: ['jump-1'] } });
  assert.equal(resolveExecutionChannel({ host: chained, hasOpenSession: false }), 'unavailable');
  assert.equal(resolveExecutionChannel({ host: chained, hasOpenSession: true }), 'session');
});

test('telnet and serial devices go through the session', () => {
  for (const protocol of ['telnet', 'serial', 'local'] as const) {
    assert.equal(resolveExecutionChannel({ host: host({ protocol }), hasOpenSession: true }), 'session');
    assert.equal(resolveExecutionChannel({ host: host({ protocol }), hasOpenSession: false }), 'unavailable');
  }
});

test('mosh and et hosts use the session when one is open', () => {
  assert.equal(resolveExecutionChannel({ host: host({ moshEnabled: true }), hasOpenSession: true }), 'session');
  assert.equal(resolveExecutionChannel({ host: host({ etEnabled: true }), hasOpenSession: false }), 'unavailable');
});

test('an empty jump chain still counts as direct', () => {
  assert.equal(resolveExecutionChannel({ host: host({ hostChain: { hostIds: [] } }), hasOpenSession: false }), 'exec');
});
