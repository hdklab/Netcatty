import { isStepCount, streamText, type ModelMessage, type ToolSet } from 'ai';
import type { AIPermissionMode } from '../types';
import type { CattyToolContext } from './cattyRuntimeContext';

/**
 * Read-only tool allowlist for subagents (M1).
 *
 * This is deliberately an explicit allowlist rather than a deny-list derived
 * from the capability catalog: a newly added write tool must never become
 * reachable from a subagent because the catalog changed. Keep it in sync with
 * the read-only tools exposed to the Catty sidebar.
 */
export const SUBAGENT_READ_ONLY_TOOL_NAMES: readonly string[] = [
  'get_environment',
  'workspace_get_info',
  'workspace_get_session_info',
  'terminal_read_context',
  'list_attachments',
  'read_attachment',
  'sftp_list',
  'sftp_read_file',
  'sftp_stat',
  'sftp_home',
  'vault_hosts_list',
  'host_get',
  'vault_notes_list',
  'vault_notes_get',
  'vault_identities_list',
  'vault_groups_list',
  'vault_proxy_profiles_list',
  'snippets_list',
  'snippets_get',
  'scripts_list',
  'scripts_get',
  'scripts_runs_list',
  'portforward_rules_list',
  'portforward_tunnels_list',
  'tool_output_read',
  'web_search',
  'url_fetch',
];

const readOnlyToolNameSet = new Set(SUBAGENT_READ_ONLY_TOOL_NAMES);

export const SUBAGENT_TOOL_NAME = 'run_subagent';
export const SUBAGENT_DEFAULT_MAX_STEPS = 8;
export const SUBAGENT_DEFAULT_TIMEOUT_MS = 90_000;
export const SUBAGENT_MAX_REPORT_CHARS = 20_000;
export const SUBAGENT_MAX_PROMPT_CHARS = 8_000;

/**
 * Depth is limited to one level in M1: the parent may delegate, the child may
 * not. The flag lives on `runtimeContext` (an additive, optional property) so a
 * turn that is already a subagent never registers `run_subagent` again.
 */
export type SubagentRuntimeContext = { subagentDepth?: number };

export function resolveSubagentDepth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function canDelegateToSubagent(input: {
  agentKind: string;
  subagentDepth: number;
}): boolean {
  return input.agentKind === 'sidebar' && input.subagentDepth === 0;
}

type CattyToolMap = ToolSet;

/**
 * Build the child tool map: the read-only allowlist minus `run_subagent`.
 *
 * Filtering (rather than trusting the caller) is the primary depth guard: even
 * if a parent tool map contains `run_subagent`, the child can never call it.
 */
export function filterSubagentTools(tools: CattyToolMap): CattyToolMap {
  const filtered: CattyToolMap = {};
  for (const [name, toolInstance] of Object.entries(tools)) {
    if (name === SUBAGENT_TOOL_NAME) continue;
    if (!readOnlyToolNameSet.has(name)) continue;
    filtered[name] = toolInstance;
  }
  return filtered;
}

/**
 * Per-tool context for the child turn. The permission mode is forced to
 * `observer` as defense in depth: every gated executor sees a read-only mode
 * even though the allowlist should already have removed write tools.
 */
export function buildSubagentToolsContext(
  toolNames: readonly string[],
  source: Record<string, CattyToolContext>,
  _permissionMode: AIPermissionMode,
): Record<string, CattyToolContext> {
  const context: Record<string, CattyToolContext> = {};
  for (const name of toolNames) {
    if (!readOnlyToolNameSet.has(name) || name === SUBAGENT_TOOL_NAME) continue;
    const entry = source[name];
    if (entry) context[name] = { ...entry, permissionMode: 'observer' };
  }
  return context;
}

/** Isolated history: system prompt + the delegated task. No parent history. */
export function buildSubagentMessages(systemPrompt: string, prompt: string): ModelMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: capSubagentPrompt(prompt) },
  ];
}

export function capSubagentPrompt(prompt: string, maxChars = SUBAGENT_MAX_PROMPT_CHARS): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[Delegated task truncated at ${maxChars} characters.]`;
}

export function capSubagentReport(report: string, maxChars = SUBAGENT_MAX_REPORT_CHARS): string {
  const trimmed = report.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[Report truncated at ${maxChars} characters.]`;
}

export type SubagentAbortHandle = {
  signal: AbortSignal;
  /** True when the hard timeout fired (as opposed to the parent aborting). */
  timedOut: () => boolean;
  dispose: () => void;
};

/**
 * Combine the parent turn's signal with a hard timeout. Prefer
 * `AbortSignal.any` (Node >= 20.3 / modern Chromium); fall back to a manual
 * controller on runtimes without it.
 */
export function createSubagentAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): SubagentAbortHandle {
  const signalApi = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
    timeout?: (ms: number) => AbortSignal;
  };
  const anySignal = signalApi.any;
  const timeoutFn = signalApi.timeout;
  const supportsTimeout = typeof timeoutFn === 'function';

  if (anySignal && parentSignal && supportsTimeout) {
    const timeoutSignal = timeoutFn.call(AbortSignal, timeoutMs);
    return {
      signal: anySignal.call(AbortSignal, [parentSignal, timeoutSignal]),
      timedOut: () => timeoutSignal.aborted,
      dispose: () => {},
    };
  }
  if (!parentSignal && supportsTimeout) {
    const timeoutSignal = timeoutFn.call(AbortSignal, timeoutMs);
    return {
      signal: timeoutSignal,
      timedOut: () => timeoutSignal.aborted,
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error('Subagent timed out.'));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

export function isAbortLikeError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError' || name === 'TimeoutError';
  }
  return false;
}

/** Map a nested-turn failure onto the tool-facing error string. */
export function resolveSubagentError(input: {
  error: unknown;
  timedOut: boolean;
  parentAborted: boolean;
  timeoutMs: number;
}): string {
  if (input.parentAborted) return 'Subagent cancelled because the parent turn was stopped.';
  if (input.timedOut) return `Subagent timed out after ${input.timeoutMs} ms.`;
  if (isAbortLikeError(input.error)) return 'Subagent was aborted before it produced a report.';
  if (input.error instanceof Error && input.error.message) return input.error.message;
  return 'Subagent failed.';
}

export const SUBAGENT_SYSTEM_PROMPT = [
  'You are a read-only research subagent working inside Netcatty.',
  'You cannot see the parent conversation; the delegated task below is your only context.',
  'You may only inspect: terminals, SFTP files, the vault, snippets, scripts, port-forward rules, attachments and the web (when those tools are provided).',
  'You cannot run commands, write files, change settings or modify the vault. Never claim that you changed anything.',
  'Investigate efficiently, then reply with one concise markdown report: what you checked, the facts you found (quote exact values such as paths, versions, addresses and ports), and anything you could not determine.',
  'Keep the report under 500 words. No greetings, no meta commentary.',
].join('\n');

export type RunSubagentInput = {
  model: Parameters<typeof streamText>[0]['model'];
  systemPrompt: string;
  tools: CattyToolMap;
  toolsContext: Record<string, CattyToolContext>;
  permissionMode: AIPermissionMode;
  parentSignal?: AbortSignal;
  prompt: string;
  description: string;
  maxSteps?: number;
  timeoutMs?: number;
};

export type RunSubagentResult =
  | { ok: true; report: string; steps: number; elapsedMs: number }
  | { ok: false; error: string; elapsedMs: number };

export async function runSubagent(input: RunSubagentInput): Promise<RunSubagentResult> {
  const startedAt = Date.now();
  const maxSteps = Math.max(1, input.maxSteps ?? SUBAGENT_DEFAULT_MAX_STEPS);
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? SUBAGENT_DEFAULT_TIMEOUT_MS);

  if (input.parentSignal?.aborted) {
    return { ok: false, error: 'Subagent cancelled before it started.', elapsedMs: 0 };
  }
  if (!input.prompt.trim()) {
    return { ok: false, error: 'Subagent prompt is empty.', elapsedMs: 0 };
  }

  const tools = filterSubagentTools(input.tools);
  const toolNames = Object.keys(tools);
  if (toolNames.length === 0) {
    return {
      ok: false,
      error: 'No read-only tools are available for the subagent.',
      elapsedMs: Date.now() - startedAt,
    };
  }

  const toolsContext = buildSubagentToolsContext(toolNames, input.toolsContext, input.permissionMode);
  const abortHandle = createSubagentAbortSignal(input.parentSignal, timeoutMs);

  try {
    const result = streamText({
      model: input.model,
      messages: buildSubagentMessages(input.systemPrompt, input.prompt),
      allowSystemInMessages: true,
      tools,
      // `ToolSet` erases per-tool context schemas; the runtime shape is the
      // map built above (same contract capabilityTools uses).
      toolsContext: toolsContext as Parameters<typeof streamText>[0]['toolsContext'],
      // Defense in depth: the allowlist already removed write tools, but any
      // tool that still asks for approval is denied rather than gated.
      toolApproval: async ({ toolCall }) => (
        readOnlyToolNameSet.has(toolCall.toolName) && toolCall.toolName !== SUBAGENT_TOOL_NAME
          ? undefined
          : { type: 'denied' as const, reason: 'Subagent runs are read-only.' }
      ),
      stopWhen: isStepCount(maxSteps),
      abortSignal: abortHandle.signal,
      runtimeContext: { subagentDepth: 1 },
      telemetry: { functionId: 'catty-subagent' },
    });

    const text = await result.text;
    const steps = (await result.steps).length;
    return {
      ok: true,
      report: capSubagentReport(text || 'The subagent produced no report.'),
      steps,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: resolveSubagentError({
        error,
        timedOut: abortHandle.timedOut(),
        parentAborted: Boolean(input.parentSignal?.aborted),
        timeoutMs,
      }),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    abortHandle.dispose();
  }
}
