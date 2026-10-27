/**
 * Pure text preparation for spoken replies.
 *
 * A chat answer is markdown with code, tables and paths; reading it verbatim
 * through TTS is unbearable, and Edge TTS has a per-request size limit. These
 * helpers turn one assistant message into ordered speech segments:
 *   - markdown noise (fences, emphasis, links, table pipes) is dropped
 *   - a leading segment is held back until it reaches `minLen` characters, the
 *     same idea as Hermes' `tts.streaming.min_len` (CJK sentences rarely reach
 *     the default 20 chars, so speech would otherwise start too late)
 *   - very long segments are cut at a safe length for one synthesis call
 */

const SENTENCE_BREAK = /(?<=[。！？；!?;])|(?<=\.\s)|\n+/;
const TRAILING_PUNCTUATION = /[。！？；.!?;，,、]+$/;
const MAX_SEGMENT_CHARS = 240;
const MAX_SPEECH_CHARS = 4000;

/** Turn one markdown answer into plain prose that is safe to read aloud. */
export function markdownToSpeechText(source: string): string {
  let text = String(source ?? '');
  if (!text.trim()) return '';
  // Fenced code blocks: announce them instead of reading every token.
  text = text.replace(/```[\s\S]*?```/g, ' 代码块 ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' 代码块 ');
  // Markdown tables collapse to their cell text without the pipes.
  text = text.replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*$/gm, ' ');
  text = text.replace(/\|/g, ' ');
  // Links / images keep the human-readable label only.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings, blockquote markers, list bullets and task boxes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');
  text = text.replace(/^\s*\[[ xX]\]\s*/gm, '');
  // Inline emphasis / code / strikethrough markers.
  text = text.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  // Horizontal rules and leftover html tags.
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Join two clauses, keeping the space that splitting on ". " would otherwise eat. */
function joinClauses(head: string, tail: string): string {
  if (!head) return tail;
  const needsSpace = /[.!?;,:]$/.test(head) && /^[A-Za-z0-9]/.test(tail);
  return needsSpace ? `${head} ${tail}` : `${head}${tail}`;
}

function chunkLongSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) return [segment];
  const chunks: string[] = [];
  let rest = segment;
  while (rest.length > maxChars) {
    // Prefer a comma/space break near the limit so the cut stays natural.
    const window = rest.slice(0, maxChars);
    const breakAt = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf('、'),
      window.lastIndexOf(','),
      window.lastIndexOf(' '),
    );
    const cut = breakAt > maxChars * 0.5 ? breakAt + 1 : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Split prose into ordered segments, merging short leading pieces until the
 * first segment reaches `minLen`, and capping every segment at a safe length.
 */
export function splitSpeechSegments(prose: string, minLen = 6): string[] {
  // Splitting on a sentence break consumes the separator, so re-space the
  // Latin case ("Done.The build" -> "Done. The build") before segmenting.
  const normalized = String(prose ?? '')
    .trim()
    .replace(/([.!?;,])(?=[A-Z])/g, '$1 ');
  if (!normalized) return [];
  const minChars = Math.max(1, Math.round(minLen || 1));
  const rawPieces = normalized
    .split(SENTENCE_BREAK)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const pieces = rawPieces.length ? rawPieces : [normalized];
  if (pieces.length > 1 && TRAILING_PUNCTUATION.test(pieces[pieces.length - 1])) {
    // keep as-is; punctuation is fine inside a segment
  }

  const merged: string[] = [];
  let carry = '';
  for (const piece of pieces) {
    const candidate = joinClauses(carry, piece);
    if (candidate.length < minChars) {
      carry = candidate;
      continue;
    }
    merged.push(candidate);
    carry = '';
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] = joinClauses(merged[merged.length - 1], carry);
    else merged.push(carry);
  }

  const segments: string[] = [];
  let total = 0;
  for (const segment of merged) {
    for (const chunk of chunkLongSegment(segment, MAX_SEGMENT_CHARS)) {
      if (total + chunk.length > MAX_SPEECH_CHARS) return segments;
      segments.push(chunk);
      total += chunk.length;
    }
  }
  return segments;
}

/** One-stop helper: markdown answer -> ready-to-speak segments. */
export function buildSpeechSegments(markdown: string, minLen = 6): string[] {
  return splitSpeechSegments(markdownToSpeechText(markdown), minLen);
}
