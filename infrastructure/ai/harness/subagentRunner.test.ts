import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  buildSubagentMessages,
  buildSubagentToolsContext,
  canDelegateToSubagent,
  capSubagentPrompt,
  capSubagentReport,
  createSubagentAbortSignal,
  filterSubagentTools,
  isAbortLikeError,
  resolveSubagentDepth,
  resolveSubagentError,
  runSubagent,
  SUBAGENT_MAX_REPORT_CHARS,
  SUBAGENT_READ_ONLY_TOOL_NAMES,
  SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_TOOL_NAME,
} from './subagentRunner';
import type { CattyToolContext } from './cattyRuntimeContext';

const readTool = tool({
  description: 'read something',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }: { path: string }) => path,
});

const writeTool = tool({
  description: 'write something',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }: { path: string }) => path,
});

function makeToolMap(): ToolSet {
  return {
    get_environment: readTool,
    sftp_read_file: readTool,
    terminal_read_context: readTool,
    web_search: readTool,
    terminal_execute: writeTool,
    sftp_write_file: writeTool,
    sftp_delete: writeTool,
    vault_hosts_create: writeTool,
    scripts_run: writeTool,
    [SUBAGENT_TOOL_NAME]: readTool,
  };
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

const baseContext: CattyToolContext = {
  bridge: {} as CattyToolContext['bridge'],
  permissionMode: 'auto',
  getExecutorContext: () => ({ sessions: [], workspaceId: 'w', workspaceName: 'w' }),
};

describe('subagent read-only allowlist', () => {
  it('keeps only allowlisted read tools and drops every write/execute tool', () => {
    const filtered = filterSubagentTools(makeToolMap());
    const names = Object.keys(filtered).sort();

    assert.deepEqual(names, [
      'get_environment',
      'sftp_read_file',
      'terminal_read_context',
      'web_search',
    ]);
    assert.equal(names.includes('terminal_execute'), false);
    assert.equal(names.includes('sftp_write_file'), false);
    assert.equal(names.includes('sftp_delete'), false);
    assert.equal(names.includes('vault_hosts_create'), false);
    assert.equal(names.includes('scripts_run'), false);
  });

  it('never exposes run_subagent to the child (depth guard)', () => {
    const filtered = filterSubagentTools(makeToolMap());
    assert.equal(SUBAGENT_TOOL_NAME in filtered, false);
    assert.equal(Object.keys(filtered).some((name) => name === SUBAGENT_TOOL_NAME), false);
  });

  it('has no overlap between the allowlist and known write tools', () => {
    for (const name of SUBAGENT_READ_ONLY_TOOL_NAMES) {
      assert.equal(/_(create|update|delete|set|import|upload|write|mkdir|rename|chmod)$/.test(name), false, name);
    }
    assert.equal(SUBAGENT_READ_ONLY_TOOL_NAMES.includes('terminal_execute'), false);
    assert.equal(SUBAGENT_READ_ONLY_TOOL_NAMES.includes('scripts_run'), false);
    assert.equal(SUBAGENT_READ_ONLY_TOOL_NAMES.includes(SUBAGENT_TOOL_NAME), false);
  });

  it('forces observer mode in the child tool context', () => {
    const context = buildSubagentToolsContext(
      ['get_environment', 'terminal_execute'],
      { get_environment: baseContext, terminal_execute: baseContext },
      'auto',
    );
    assert.deepEqual(Object.keys(context), ['get_environment']);
    assert.equal(context.get_environment.permissionMode, 'observer');
  });
});

describe('subagent depth guard', () => {
  it('allows delegation only for the sidebar agent at depth 0', () => {
    assert.equal(canDelegateToSubagent({ agentKind: 'sidebar', subagentDepth: 0 }), true);
    assert.equal(canDelegateToSubagent({ agentKind: 'sidebar', subagentDepth: 1 }), false);
    assert.equal(canDelegateToSubagent({ agentKind: 'global', subagentDepth: 0 }), false);
  });

  it('normalizes the runtime-context depth flag', () => {
    assert.equal(resolveSubagentDepth(undefined), 0);
    assert.equal(resolveSubagentDepth(0), 0);
    assert.equal(resolveSubagentDepth(1), 1);
    assert.equal(resolveSubagentDepth('1'), 0);
  });
});

describe('subagent messages and caps', () => {
  it('builds an isolated system + user history', () => {
    const messages = buildSubagentMessages(SUBAGENT_SYSTEM_PROMPT, 'Inspect /etc/nginx');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.match(String(messages[1].content), /Inspect \/etc\/nginx/);
  });

  it('caps long prompts and reports', () => {
    const longPrompt = 'p'.repeat(50);
    const cappedPrompt = capSubagentPrompt(longPrompt, 10);
    assert.match(cappedPrompt, /^p{10}\n\n\[Delegated task truncated/);

    const longReport = 'r'.repeat(SUBAGENT_MAX_REPORT_CHARS + 100);
    const capped = capSubagentReport(longReport);
    assert.equal(capped.startsWith('r'.repeat(SUBAGENT_MAX_REPORT_CHARS)), true);
    assert.match(capped, /\[Report truncated at 20000 characters\.\]$/);
    assert.equal(capSubagentReport('short'), 'short');
  });
});

describe('subagent abort and timeout handling', () => {
  it('returns an error instead of starting when the parent is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSubagent({
      model: textModel('never used'),
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      tools: makeToolMap(),
      toolsContext: { get_environment: baseContext },
      permissionMode: 'auto',
      parentSignal: controller.signal,
      prompt: 'do work',
      description: 'test',
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /cancelled/i);
  });

  it('maps timeouts and abort-like errors', () => {
    assert.match(
      resolveSubagentError({ error: new Error('x'), timedOut: true, parentAborted: false, timeoutMs: 90_000 }),
      /timed out after 90000 ms/,
    );
    assert.match(
      resolveSubagentError({ error: new Error('x'), timedOut: false, parentAborted: true, timeoutMs: 1 }),
      /cancelled/i,
    );
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    assert.equal(isAbortLikeError(abortError), true);
    assert.match(
      resolveSubagentError({ error: abortError, timedOut: false, parentAborted: false, timeoutMs: 1 }),
      /aborted/i,
    );
  });

  it('fires the hard timeout signal', async () => {
    const handle = createSubagentAbortSignal(undefined, 10);
    assert.equal(handle.signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(handle.signal.aborted, true);
    assert.equal(handle.timedOut(), true);
    handle.dispose();
  });
});

describe('runSubagent', () => {
  it('returns the final assistant report with the step count', async () => {
    const result = await runSubagent({
      model: textModel('The nginx config listens on 8080.'),
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      tools: makeToolMap(),
      toolsContext: { get_environment: baseContext, sftp_read_file: baseContext },
      permissionMode: 'auto',
      prompt: 'Inspect the nginx config and report the listen port.',
      description: 'Inspect nginx configs',
      maxSteps: 3,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.report, /listens on 8080/);
      assert.equal(result.steps, 1);
      assert.equal(typeof result.elapsedMs, 'number');
    }
  });

  it('fails clearly when no read-only tools are available', async () => {
    const result = await runSubagent({
      model: textModel('unused'),
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      tools: { terminal_execute: writeTool },
      toolsContext: {},
      permissionMode: 'auto',
      prompt: 'do work',
      description: 'test',
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /No read-only tools/);
  });
});
