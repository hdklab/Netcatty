import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpeechSegments,
  markdownToSpeechText,
  splitSpeechSegments,
} from './voiceSpeechText';

test('markdownToSpeechText drops code fences but announces them', () => {
  const prose = markdownToSpeechText('先看这段：\n```bash\nssh root@host\n```\n然后重试。');
  assert.equal(prose.includes('ssh root@host'), false);
  assert.ok(prose.includes('代码块'));
  assert.ok(prose.includes('然后重试'));
});

test('markdownToSpeechText strips links, emphasis, headings and table pipes', () => {
  const prose = markdownToSpeechText([
    '## 结论',
    '',
    '- **升级** [文档](https://example.com) 已就绪',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'));
  assert.equal(prose.includes('##'), false);
  assert.equal(prose.includes('**'), false);
  assert.equal(prose.includes('|'), false);
  assert.equal(prose.includes('https://example.com'), false);
  assert.ok(prose.includes('升级'));
  assert.ok(prose.includes('文档'));
});

test('splitSpeechSegments merges short CJK clauses until minLen is reached', () => {
  const segments = splitSpeechSegments('好的。我来看看。然后再告诉你结果。', 6);
  // "好的。" is too short on its own, so it is merged into the next clause.
  assert.ok(segments.length >= 2);
  assert.ok(segments[0].length >= 6);
  assert.equal(segments.join(''), '好的。我来看看。然后再告诉你结果。');
});

test('splitSpeechSegments keeps a single short answer intact', () => {
  assert.deepEqual(splitSpeechSegments('好的。', 6), ['好的。']);
});

test('splitSpeechSegments cuts very long segments into safe synthesis chunks', () => {
  const long = '这是一句很长的说明，'.repeat(60);
  const segments = splitSpeechSegments(long, 6);
  assert.ok(segments.length > 1);
  for (const segment of segments) assert.ok(segment.length <= 240, `segment too long: ${segment.length}`);
});

test('splitSpeechSegments returns nothing for empty prose', () => {
  assert.deepEqual(splitSpeechSegments('   ', 6), []);
  assert.deepEqual(buildSpeechSegments('```\ncode only\n```', 6), ['代码块']);
});

test('buildSpeechSegments reads an English answer sentence by sentence', () => {
  const segments = buildSpeechSegments('Done. The build finished and the app relaunched.', 3);
  assert.deepEqual(segments, ['Done.', 'The build finished and the app relaunched.']);
});

test('buildSpeechSegments holds a too-short leading sentence back (min_len rule)', () => {
  // Hermes parity: the first spoken segment must reach min_len, so a 5-char
  // "Done." is merged instead of being spoken as its own clip.
  const segments = buildSpeechSegments('Done. The build finished.', 6);
  assert.deepEqual(segments, ['Done. The build finished.']);
});
