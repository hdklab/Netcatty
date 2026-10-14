import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCommandOutcome } from './commandOutcome.ts';

test('exit code 0 passes by default', () => {
  assert.deepEqual(evaluateCommandOutcome({}, { exitCode: 0, stdout: 'ok' }), { ok: true });
});

test('a non-zero exit code fails with the code in the reason', () => {
  const outcome = evaluateCommandOutcome({}, { exitCode: 3, stderr: 'boom' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? '', /Exit code 3/);
});

test('expected exit codes replace the default list', () => {
  assert.equal(evaluateCommandOutcome({ expectedExitCodes: [0, 1] }, { exitCode: 1 }).ok, true);
  assert.equal(evaluateCommandOutcome({ expectedExitCodes: [0, 1] }, { exitCode: 2 }).ok, false);
});

test('a session channel without an exit code counts as success', () => {
  // telnet / serial / typed-into-a-terminal commands have no exit status.
  assert.deepEqual(evaluateCommandOutcome({}, { exitCode: null, stdout: 'switch#' }), { ok: true });
  assert.deepEqual(evaluateCommandOutcome({}, {}), { ok: true });
});

test('failurePattern beats a zero exit code', () => {
  const outcome = evaluateCommandOutcome(
    { failurePattern: 'ERROR' },
    { exitCode: 0, stdout: 'all good\nERROR: disk full' },
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? '', /failurePattern/);
});

test('successPattern replaces the exit-code check', () => {
  assert.equal(
    evaluateCommandOutcome({ successPattern: 'BUILD OK' }, { exitCode: 1, stdout: 'BUILD OK' }).ok,
    true,
  );
  const missing = evaluateCommandOutcome({ successPattern: 'BUILD OK' }, { exitCode: 0, stdout: 'nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? '', /did not match successPattern/);
});

test('a transport error fails the host before any pattern is considered', () => {
  const outcome = evaluateCommandOutcome(
    { successPattern: 'OK' },
    { error: 'Connection refused', stdout: 'OK' },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'Connection refused');
});
