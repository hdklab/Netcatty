import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCommandOutput,
  isCommandEchoVisible,
  screenFingerprint,
  stripTerminalNoise,
} from './sessionOutput.ts';

test('terminal noise is stripped', () => {
  assert.equal(stripTerminalNoise('\u001B[32mok\u001B[0m'), 'ok');
  assert.equal(stripTerminalNoise('line\r'), 'line');
  assert.equal(stripTerminalNoise('trailing   '), 'trailing');
});

test('output is everything between the echoed command and the next prompt', () => {
  const lines = [
    'Last login: Mon Oct 14 13:00:00',
    'user@web-1:~$ uptime',
    ' 13:05:01 up 3 days,  2:11,  1 user,  load average: 0.12, 0.20, 0.18',
    'user@web-1:~$',
  ];
  assert.equal(
    extractCommandOutput({ lines, command: 'uptime' }),
    '13:05:01 up 3 days,  2:11,  1 user,  load average: 0.12, 0.20, 0.18',
  );
});

test('a device style prompt is removed too', () => {
  const lines = [
    'switch# show version',
    'Software Version 7.1(2)',
    'switch#',
  ];
  assert.equal(extractCommandOutput({ lines, command: 'show version' }), 'Software Version 7.1(2)');
});

test('multi-line output keeps its inner blank lines', () => {
  const lines = [
    '$ cat report.txt',
    'header',
    '',
    'body',
    '$',
  ];
  assert.equal(extractCommandOutput({ lines, command: 'cat report.txt' }), 'header\n\nbody');
});

test('the last echo wins when the same command appears twice', () => {
  const lines = [
    '$ echo hi',
    'hi',
    '$ echo hi',
    'hi',
    '$',
  ];
  assert.equal(extractCommandOutput({ lines, command: 'echo hi' }), 'hi');
});

test('no output yields an empty string rather than the prompt', () => {
  assert.equal(extractCommandOutput({ lines: ['$ true', '$'], command: 'true' }), '');
});

test('a command that is not on screen yields an empty string', () => {
  assert.equal(extractCommandOutput({ lines: ['$ whoami', 'root', '$'], command: 'uptime' }), '');
  assert.equal(extractCommandOutput({ lines: ['$ uptime'], command: '   ' }), '');
});

test('a custom prompt pattern can be supplied', () => {
  const lines = ['router) uptime', ' 13:05 up 1 day', 'router)'];
  assert.equal(
    extractCommandOutput({ lines, command: 'uptime', promptPattern: /\)\s*$/ }),
    '13:05 up 1 day',
  );
});

test('command echo detection follows the same noise stripping', () => {
  assert.equal(isCommandEchoVisible(['\u001B[33m$\u001B[0m df -h'], 'df -h'), true);
  assert.equal(isCommandEchoVisible(['$ whoami'], 'df -h'), false);
  assert.equal(isCommandEchoVisible([], 'df'), false);
});

test('the fingerprint is stable across cosmetic changes only', () => {
  assert.equal(screenFingerprint(['a  ', 'b']), screenFingerprint(['a', 'b']));
  assert.notEqual(screenFingerprint(['a', 'b']), screenFingerprint(['a', 'c']));
});
