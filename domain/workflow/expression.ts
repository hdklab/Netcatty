/**
 * Template interpolation for workflow node fields.
 *
 * Deliberately NOT an expression engine: no `eval`, no user JavaScript. Only
 * whitelisted result paths plus a small fixed filter set, so a workflow
 * definition (which may be imported from elsewhere) cannot execute code.
 *
 *   {{ nodes.<nodeId>.stdout }}
 *   {{ nodes.<nodeId>.hosts.<hostId>.stderr }}
 *   {{ nodes.<nodeId>.exitCode }}   {{ nodes.<nodeId>.ok }}
 *   {{ workflow.vars.<name> }}      {{ run.id }}   {{ run.startedAt }}
 *
 * Filters: trim, upper, lower, head(n), tail(n), match(/re/), default("v")
 */

import type { NodeRunResult } from './types.ts';

export interface InterpolationContext {
  nodeResults: Readonly<Record<string, NodeRunResult>>;
  variables?: Readonly<Record<string, string>>;
  runId?: string;
  runStartedAt?: number;
  /** 1-based loop attempt for `{{ loop.iteration }}`. */
  iteration?: number;
}

export interface InterpolationIssue {
  /** Raw token text without the braces, trimmed. */
  token: string;
  message: string;
}

export interface InterpolationResult {
  ok: boolean;
  value: string;
  issues: InterpolationIssue[];
}

interface ParsedToken {
  raw: string;
  path: string;
  filters: string[];
}

const TOKEN_PATTERN = /\{\{([\s\S]*?)\}\}/g;

const NODE_AGGREGATE_FIELDS = new Set(['stdout', 'stderr', 'exitCode', 'ok']);
const HOST_FIELDS = new Set(['stdout', 'stderr', 'exitCode', 'ok']);
const SIMPLE_FILTERS = new Set(['trim', 'upper', 'lower']);
const ARG_FILTERS = new Set(['head', 'tail', 'match', 'default']);

/** Split a token body on `|` that sits outside parentheses, so `match(/a|b/)` works. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of source) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseToken(raw: string): ParsedToken {
  const [path = '', ...filters] = splitTopLevel(raw.trim());
  return { raw: raw.trim(), path, filters };
}

/** Validate a result path; returns an error message or null when accepted. */
function validatePath(path: string): string | null {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) return 'Empty reference';
  if (segments[0] === 'run') {
    if (segments.length === 2 && (segments[1] === 'id' || segments[1] === 'startedAt')) return null;
    return 'Use run.id or run.startedAt';
  }
  if (segments[0] === 'loop') {
    if (segments.length === 2 && segments[1] === 'iteration') return null;
    return 'Use loop.iteration';
  }
  if (segments[0] === 'workflow') {
    if (segments.length === 3 && segments[1] === 'vars' && segments[2].length > 0) return null;
    return 'Use workflow.vars.<name>';
  }
  if (segments[0] === 'nodes') {
    if (segments.length < 3) return 'Use nodes.<nodeId>.<field>';
    const [, , field] = segments;
    if (field === 'hosts') {
      if (segments.length !== 5 || segments[3].length === 0 || !HOST_FIELDS.has(segments[4])) {
        return 'Use nodes.<nodeId>.hosts.<hostId>.<stdout|stderr|exitCode|ok>';
      }
      return null;
    }
    if (!NODE_AGGREGATE_FIELDS.has(field) || segments.length !== 3) {
      return 'Use nodes.<nodeId>.<stdout|stderr|exitCode|ok>';
    }
    return null;
  }
  return `Unknown reference root "${segments[0]}"`;
}

function validateFilter(filter: string): string | null {
  const open = filter.indexOf('(');
  if (open === -1) {
    return SIMPLE_FILTERS.has(filter) ? null : `Unknown filter "${filter}"`;
  }
  if (!filter.endsWith(')')) return `Unterminated filter "${filter}"`;
  const name = filter.slice(0, open).trim();
  const arg = filter.slice(open + 1, -1).trim();
  if (!ARG_FILTERS.has(name)) return `Unknown filter "${name}"`;
  if (arg.length === 0) return `Filter "${name}" needs an argument`;
  if (name === 'head' || name === 'tail') {
    if (!/^\d+$/.test(arg)) return `Filter "${name}" needs a line count`;
  }
  if (name === 'match') {
    if (!(arg.startsWith('/') && arg.lastIndexOf('/') > 0)) return 'match() needs /regex/';
    try {
      new RegExp(arg.slice(1, arg.lastIndexOf('/')), arg.slice(arg.lastIndexOf('/') + 1));
    } catch {
      return `Invalid regex in match(${arg})`;
    }
  }
  if (name === 'default' && !(arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2)) {
    return 'default() needs a quoted string';
  }
  return null;
}

/** Every `{{ ... }}` body in the template, trimmed. */
export function findTemplateTokens(template: string): string[] {
  const tokens: string[] = [];
  for (const match of String(template ?? '').matchAll(TOKEN_PATTERN)) {
    tokens.push(match[1].trim());
  }
  return tokens;
}

/** Static validation: unknown paths and filters, without needing run results. */
export function validateTemplate(template: string): InterpolationIssue[] {
  const issues: InterpolationIssue[] = [];
  for (const token of findTemplateTokens(template)) {
    const parsed = parseToken(token);
    const pathError = validatePath(parsed.path);
    if (pathError) {
      issues.push({ token, message: pathError });
      continue;
    }
    for (const filter of parsed.filters) {
      const filterError = validateFilter(filter);
      if (filterError) issues.push({ token, message: filterError });
    }
  }
  return issues;
}

function nodeResultToString(result: NodeRunResult | undefined, field: string): string | undefined {
  if (!result) return undefined;
  switch (field) {
    case 'stdout':
      return result.hosts.map((host) => host.stdout ?? '').filter((text) => text.length > 0).join('\n');
    case 'stderr':
      return result.hosts.map((host) => host.stderr ?? '').filter((text) => text.length > 0).join('\n');
    case 'exitCode': {
      const codes = result.hosts.map((host) => host.exitCode).filter((code): code is number => typeof code === 'number');
      return codes.length > 0 ? codes.join(',') : undefined;
    }
    case 'ok':
      return result.hosts.length > 0 && result.hosts.every((host) => host.ok) ? 'true' : 'false';
    default:
      return undefined;
  }
}

function resolvePath(path: string, context: InterpolationContext): { value?: string; error?: string } {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments[0] === 'run') {
    if (segments[1] === 'id') return { value: context.runId ?? '' };
    if (segments[1] === 'startedAt') {
      return { value: context.runStartedAt === undefined ? '' : String(context.runStartedAt) };
    }
  }
  if (segments[0] === 'loop' && segments[1] === 'iteration') {
    return { value: String(context.iteration ?? 1) };
  }
  if (segments[0] === 'workflow' && segments[1] === 'vars') {
    return { value: context.variables?.[segments[2]] ?? '' };
  }
  if (segments[0] === 'nodes') {
    const result = context.nodeResults[segments[1]];
    if (!result) return { error: `Unknown node "${segments[1]}"` };
    if (segments[2] === 'hosts') {
      const host = result.hosts.find((entry) => entry.hostId === segments[3]);
      if (!host) return { error: `Node "${segments[1]}" has no result for host "${segments[3]}"` };
      const field = segments[4];
      if (field === 'exitCode') return { value: host.exitCode === undefined ? '' : String(host.exitCode) };
      if (field === 'ok') return { value: host.ok ? 'true' : 'false' };
      return { value: (field === 'stderr' ? host.stderr : host.stdout) ?? '' };
    }
    return { value: nodeResultToString(result, segments[2]) ?? '' };
  }
  return { error: `Cannot resolve "${path}"` };
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split('\n');
}

function applyFilter(value: string, filter: string): { value: string; error?: string } {
  const open = filter.indexOf('(');
  const name = open === -1 ? filter : filter.slice(0, open).trim();
  const arg = open === -1 ? '' : filter.slice(open + 1, -1).trim();
  switch (name) {
    case 'trim':
      return { value: value.trim() };
    case 'upper':
      return { value: value.toUpperCase() };
    case 'lower':
      return { value: value.toLowerCase() };
    case 'head': {
      const count = Number(arg);
      return { value: splitLines(value).slice(0, count).join('\n') };
    }
    case 'tail': {
      const count = Number(arg);
      const lines = splitLines(value);
      return { value: lines.slice(Math.max(0, lines.length - count)).join('\n') };
    }
    case 'match': {
      const lastSlash = arg.lastIndexOf('/');
      const pattern = arg.slice(1, lastSlash);
      const flags = arg.slice(lastSlash + 1);
      try {
        const match = new RegExp(pattern, flags).exec(value);
        if (!match) return { value: '' };
        return { value: match[1] ?? match[0] };
      } catch (err) {
        return { value, error: `match() failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case 'default':
      return { value: value.length > 0 ? value : arg.slice(1, -1) };
    default:
      return { value, error: `Unknown filter "${name}"` };
  }
}

/** Resolve one `{{ ... }}` body against settled run results. */
export function resolveToken(token: string, context: InterpolationContext): { value: string; issues: InterpolationIssue[] } {
  const parsed = parseToken(token);
  const issues: InterpolationIssue[] = [];
  const pathError = validatePath(parsed.path);
  if (pathError) return { value: '', issues: [{ token: parsed.raw, message: pathError }] };

  const resolved = resolvePath(parsed.path, context);
  if (resolved.error) {
    // `default("x")` declares that a missing reference is acceptable, so the
    // filter chain gets an empty value instead of failing the node.
    const toleratesMissing = parsed.filters.some((filter) => filter.startsWith('default('));
    if (!toleratesMissing) {
      return { value: '', issues: [{ token: parsed.raw, message: resolved.error }] };
    }
  }

  let value = resolved.value ?? '';
  for (const filter of parsed.filters) {
    const filterError = validateFilter(filter);
    if (filterError) {
      issues.push({ token: parsed.raw, message: filterError });
      return { value: '', issues };
    }
    const applied = applyFilter(value, filter);
    if (applied.error) issues.push({ token: parsed.raw, message: applied.error });
    value = applied.value;
  }
  return { value, issues };
}

/**
 * Replace every `{{ ... }}` in the template. Unresolvable tokens become an
 * empty string and are reported in `issues`; callers decide whether an issue is
 * fatal for the node.
 */
export function interpolateTemplate(template: string, context: InterpolationContext): InterpolationResult {
  const source = String(template ?? '');
  const issues: InterpolationIssue[] = [];
  let value = '';
  let cursor = 0;
  TOKEN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    value += source.slice(cursor, index);
    const resolved = resolveToken(match[1], context);
    value += resolved.value;
    issues.push(...resolved.issues);
    cursor = index + match[0].length;
  }
  value += source.slice(cursor);
  return { ok: issues.length === 0, value, issues };
}
