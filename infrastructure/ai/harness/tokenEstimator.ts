import type { ModelMessage } from 'ai';
import type { TokenEstimatorKind } from './types';

const CHARS_PER_TOKEN_FALLBACK = 4;

/**
 * Characters a tokenizer renders as (about) one token each. Dividing their count
 * by 4 undercounts CJK text roughly 4x, which made a Chinese prompt look a
 * quarter of its real size to the context budget and the usage readout.
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x2eff], // CJK radicals
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // halfwidth and fullwidth forms
];

interface CharCounts {
  /** Code points counted as one token each. */
  cjk: number;
  /** Everything else: estimated as a divisor of the character count. */
  other: number;
}

function isCjkCodePoint(codePoint: number): boolean {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function countStringChars(value: string): CharCounts {
  let cjk = 0;
  let other = 0;
  // for..of walks code points, so surrogate pairs count once.
  for (const char of value) {
    if (isCjkCodePoint(char.codePointAt(0) as number)) cjk += 1;
    else other += 1;
  }
  return { cjk, other };
}

function sumChars(left: CharCounts, right: CharCounts): CharCounts {
  return { cjk: left.cjk + right.cjk, other: left.other + right.other };
}

function countChars(value: unknown): CharCounts {
  if (value == null) return { cjk: 0, other: 0 };
  if (typeof value === 'string') return countStringChars(value);
  if (Array.isArray(value)) {
    return value.reduce<CharCounts>(
      (total, item) => sumChars(total, countChars(item)),
      { cjk: 0, other: 0 },
    );
  }
  if (typeof value === 'object') {
    try {
      return countStringChars(JSON.stringify(value));
    } catch {
      return countStringChars(String(value));
    }
  }
  return countStringChars(String(value));
}

export function resolveEstimatorKind(providerId?: string | null): TokenEstimatorKind {
  const id = (providerId ?? '').toLowerCase();
  if (id.includes('openai') || id.includes('gpt')) return 'openai-heuristic';
  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic-heuristic';
  if (id.includes('google') || id.includes('gemini')) return 'google-heuristic';
  return 'cjk-aware';
}

/**
 * Characters per token for the non-CJK part of a payload. CJK characters are
 * never divided: they count as one token each, whatever the provider.
 */
function divisorFor(kind: TokenEstimatorKind): number {
  switch (kind) {
    case 'openai-heuristic':
      return 3.5;
    case 'anthropic-heuristic':
      return 3.2;
    case 'google-heuristic':
      return 3.8;
    default:
      return CHARS_PER_TOKEN_FALLBACK;
  }
}

function applyHeuristicMultiplier(counts: CharCounts, kind: TokenEstimatorKind): number {
  return counts.cjk + Math.ceil(counts.other / divisorFor(kind));
}

export function estimateTextTokens(text: string, providerId?: string | null): number {
  return applyHeuristicMultiplier(countStringChars(text), resolveEstimatorKind(providerId));
}

export function estimateUnknownTokens(value: unknown, providerId?: string | null): number {
  return applyHeuristicMultiplier(countChars(value), resolveEstimatorKind(providerId));
}

export interface EstimateModelMessagesTokensInput {
  messages: ModelMessage[];
  providerId?: string | null;
}

export interface EstimateModelMessagesTokensResult {
  tokens: number;
  estimatorKind: TokenEstimatorKind;
}

export function estimateModelMessagesTokensWithKind(
  input: EstimateModelMessagesTokensInput,
): EstimateModelMessagesTokensResult {
  const estimatorKind = resolveEstimatorKind(input.providerId);
  const counts = input.messages.reduce<CharCounts>((total, message) => {
    return sumChars(sumChars(total, countChars(message.role)), countChars(message.content));
  }, { cjk: 0, other: 0 });
  return {
    tokens: applyHeuristicMultiplier(counts, estimatorKind),
    estimatorKind,
  };
}

export function estimateModelMessagesTokens(
  messages: ModelMessage[],
  providerId?: string | null,
): number {
  return estimateModelMessagesTokensWithKind({ messages, providerId }).tokens;
}
