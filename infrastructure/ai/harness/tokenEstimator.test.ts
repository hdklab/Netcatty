import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import {
  estimateModelMessagesTokensWithKind,
  estimateTextTokens,
  estimateUnknownTokens,
  resolveEstimatorKind,
} from './tokenEstimator.ts';

test('ASCII payloads keep the characters-per-token estimate', () => {
  assert.equal(resolveEstimatorKind(undefined), 'cjk-aware');
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('a'.repeat(40)), 10);
});

test('CJK characters count as one token each instead of being divided by four', () => {
  const chinese = '你好世界，这是一段中文提示词';
  assert.equal(chinese.length, 14);
  assert.equal(estimateTextTokens(chinese), 14, 'one token per CJK character');
  assert.ok(
    estimateTextTokens(chinese) > Math.ceil(chinese.length / 4),
    'the old char/4 estimate undercounted CJK',
  );
});

test('mixed payloads count CJK directly and the rest by the divisor', () => {
  assert.equal(estimateTextTokens('abc你好'), Math.ceil(3 / 4) + 2);
});

test('provider heuristics only apply to the non-CJK part', () => {
  assert.equal(estimateTextTokens('a'.repeat(35), 'openai'), Math.ceil(35 / 3.5));
  assert.equal(estimateTextTokens('你好', 'anthropic'), 2);
  assert.equal(estimateTextTokens('你好', 'gpt-4o'), 2);
  assert.equal(resolveEstimatorKind('claude'), 'anthropic-heuristic');
  assert.equal(resolveEstimatorKind('gemini'), 'google-heuristic');
});

test('unknown values and message arrays keep their CJK content', () => {
  const withCjk = { note: '你好' };
  const json = JSON.stringify(withCjk);
  assert.equal(estimateUnknownTokens(withCjk), 2 + Math.ceil((json.length - 2) / 4));

  const messages = [{ role: 'user', content: '你好世界' }] as ModelMessage[];
  const result = estimateModelMessagesTokensWithKind({ messages });
  assert.equal(result.estimatorKind, 'cjk-aware');
  assert.equal(result.tokens, 4 + Math.ceil('user'.length / 4));

  // Arrays (multimodal content) must be walked item by item, not passed to the
  // accumulating helper raw — that silently produced NaN.
  const arrayTokens = estimateUnknownTokens([{ type: 'text', text: '你好' }]);
  assert.ok(Number.isFinite(arrayTokens), 'array payloads estimate to a number');
  assert.equal(arrayTokens, 2 + Math.ceil((JSON.stringify({ type: 'text', text: '' }).length) / 4));
});
