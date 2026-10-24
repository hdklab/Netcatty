import { streamText, isStepCount, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { classifyError } from '../../errorClassifier';
import { isRequestTooLargeError } from '../../errorClassifier';
import { isSdkStreamStateError } from '../../shared/streamStateErrors';
import {
  createCattyRequestTooLargeRetryError,
  hadToolProgressBeforeRequestTooLarge,
} from '../../cattyRequestTooLargeRetry';
import { mapCattyStreamChunkToAgentEvents } from '../agentEventAdapter';
import type { AgentEvent } from '../types';
import { resolveProviderStyle, type ProviderAdvancedParams } from '../../types';
import type { CattyReasoningProviderOptions } from '../../cattyReasoning';
import { resolveProviderEndpoint } from '../../sdk/providers';
import type { CattyToolsBundle } from '../capabilityTools';
import { buildCattyToolApproval } from '../cattyToolApproval';
import { cattyToolContextSchema, type CattyRuntimeContext, type CattyToolContext } from '../cattyRuntimeContext';
import {
  canDelegateToSubagent,
  resolveSubagentDepth,
  runSubagent,
  SUBAGENT_SYSTEM_PROMPT,
  SUBAGENT_TOOL_NAME,
  type SubagentRuntimeContext,
} from '../subagentRunner';
import { buildCattyStreamTimeouts } from '../streamTimeouts';
import { createCattyPromptCache } from '../cattyPromptCache';
import {
  extractProviderContinuationFromRawChunk,
  mergeProviderContinuation,
  normalizeProviderContinuationOptions,
  withProviderContinuationSource,
  type ProviderContinuation,
} from '../../providerContinuation';
import {
  formatToolErrorContent,
  generateId,
  isToolResultError,
  resolveStreamChunkToolCallId,
  type CattyProviderContinuationContext,
  type ErrorChunk,
  type RawChunk,
  type ReasoningChunk,
  type StreamChunk,
  type TextDeltaChunk,
  type ToolApprovalResponseChunk,
  type ToolCallChunk,
  type ToolErrorChunk,
  type ToolOutputDeniedChunk,
  type ToolResultChunk,
} from '../../aiChatStreamingSupport';
import type { ChatMessage, ProviderConfig } from '../../types';

export type CattyModel = LanguageModelV4;

export interface CattyStreamUiSink {
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateMessageById: (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
}

export interface ProcessCattyStreamInput {
  streamSessionId: string;
  model: CattyModel;
  providerConfig?: ProviderConfig;
  systemPrompt: string;
  toolsBundle: CattyToolsBundle;
  sdkMessages: ModelMessage[];
  signal: AbortSignal;
  currentAssistantMsgId: string;
  maxIterations: number;
  advancedParams?: ProviderAdvancedParams;
  reasoningProviderOptions?: CattyReasoningProviderOptions;
  continuationContext?: CattyProviderContinuationContext;
  turnId?: string;
  commandTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  runtimeContext: CattyRuntimeContext;
  onAgentEvent?: (event: AgentEvent) => void;
  prepareStep?: (args: {
    stepNumber: number;
    messages: ModelMessage[];
    runtimeContext: CattyRuntimeContext;
  }) => Promise<{ messages: ModelMessage[]; runtimeContext?: CattyRuntimeContext } | undefined>;
  ui: CattyStreamUiSink;
}

export interface ProcessCattyStreamResult {
  usage?: {
    promptTokens?: number;
    cachedPromptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  performance?: {
    responseTimeMs?: number;
    timeToFirstOutputMs?: number;
    outputTokensPerSecond?: number;
  };
}

/** Skip trace emission for SDK-internal stream bookkeeping errors we suppress in UI. */
export function shouldEmitAgentEventsForStreamChunk(chunk: StreamChunk): boolean {
  if (chunk.type !== 'error') return true;
  return !isSdkStreamStateError((chunk as ErrorChunk).error);
}

/**
 * Detect provider metadata that actually carries replayable reasoning
 * ciphertext (e.g. `openai.reasoningEncryptedContent`). A null/absent payload
 * must not be persisted: merging it over a previously captured ciphertext
 * would invalidate the stateless reasoning replay.
 */
function hasReasoningEncryptedContent(options: Record<string, Record<string, unknown>>): boolean {
  return Object.values(options).some(providerOptions =>
    typeof providerOptions?.reasoningEncryptedContent === 'string'
    && providerOptions.reasoningEncryptedContent.length > 0,
  );
}

/**
 * `run_subagent` is a Catty-sidebar-only harness tool: it starts a nested
 * `streamText` turn with an isolated history and a read-only tool subset.
 * Registration is gated on depth 0 so a subagent can never delegate again.
 */
const runSubagentInputSchema = z.object({
  prompt: z.string().min(1).describe('Self-contained research brief for the subagent. It sees nothing else from this conversation.'),
  description: z.string().min(1).describe('Short label for the UI, e.g. "Inspect nginx configs".'),
  allowWrites: z.boolean().optional().describe('Reserved for future milestones. Subagents are read-only in M1; pass false or omit.'),
});

type RunSubagentToolInput = {
  prompt: string;
  description: string;
  allowWrites?: boolean;
};

type RunSubagentToolOutput =
  | { report: string; steps: number; elapsedMs: number }
  | { error: string; elapsedMs?: number };

function createRunSubagentTool(input: {
  model: CattyModel;
  tools: CattyToolsBundle['tools'];
  toolsContext: Record<string, CattyToolContext>;
  permissionMode: CattyRuntimeContext['permissionMode'];
}) {
  return tool<RunSubagentToolInput, RunSubagentToolOutput, CattyToolContext>({
    description: [
      'Delegate a self-contained, read-only research task to a subagent.',
      'The subagent starts with an isolated context (it cannot see this conversation), may only use read-only inspection tools, and returns one markdown report.',
      'Use it to gather facts across sessions, files, hosts or the web without cluttering this conversation.',
      'It cannot execute commands, write files or change the vault; `allowWrites` is not supported in this version.',
      'Write `prompt` as a complete brief: the goal, which sessions/hosts/paths to inspect, and exactly what to report back.',
      '`description` is a short label shown in the UI (3-6 words).',
      'Do not delegate work that requires changes; do that yourself.',
    ].join(' '),
    inputSchema: runSubagentInputSchema,
    contextSchema: cattyToolContextSchema,
    execute: async (args: RunSubagentToolInput, { abortSignal }) => {
      if (args.allowWrites === true) {
        return {
          error: 'run_subagent is read-only in this version; allowWrites is not supported.',
        };
      }
      const result = await runSubagent({
        model: input.model,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        tools: input.tools,
        toolsContext: input.toolsContext,
        permissionMode: input.permissionMode,
        parentSignal: abortSignal,
        prompt: args.prompt,
        description: args.description,
      });
      if (result.ok === false) {
        return { error: result.error, elapsedMs: result.elapsedMs };
      }
      return { report: result.report, steps: result.steps, elapsedMs: result.elapsedMs };
    },
  });
}

export async function processCattyStream(input: ProcessCattyStreamInput): Promise<ProcessCattyStreamResult> {
  const {
    streamSessionId,
    model,
    systemPrompt,
    toolsBundle,
    sdkMessages,
    signal,
    currentAssistantMsgId,
    maxIterations,
    advancedParams,
    reasoningProviderOptions,
    continuationContext,
    turnId,
    commandTimeoutMs,
    responseIdleTimeoutMs,
    runtimeContext: initialRuntimeContext,
    onAgentEvent,
    prepareStep,
    ui,
  } = input;

  let runtimeContext = initialRuntimeContext;
  const parentTools = toolsBundle.tools;
  const parentToolsContext = toolsBundle.toolsContext;
  const sharedToolContext = Object.values(parentToolsContext)[0];
  const subagentDepth = resolveSubagentDepth(
    (runtimeContext as CattyRuntimeContext & SubagentRuntimeContext).subagentDepth,
  );
  // `run_subagent` is sidebar-only and depth-0 only: a nested Catty turn never
  // registers it, so a child can never delegate again.
  const canDelegate = Boolean(sharedToolContext)
    && canDelegateToSubagent({ agentKind: runtimeContext.agentKind, subagentDepth });
  const tools = canDelegate && sharedToolContext
    ? {
        ...parentTools,
        [SUBAGENT_TOOL_NAME]: createRunSubagentTool({
          model,
          tools: parentTools,
          toolsContext: parentToolsContext,
          permissionMode: runtimeContext.permissionMode,
        }),
      }
    : parentTools;
  const toolsContext = canDelegate && sharedToolContext
    ? { ...parentToolsContext, [SUBAGENT_TOOL_NAME]: sharedToolContext }
    : parentToolsContext;
  const endpoint = input.providerConfig
    ? resolveProviderEndpoint(input.providerConfig, resolveProviderStyle(input.providerConfig), undefined)
    : undefined;
  const promptCache = createCattyPromptCache(systemPrompt, model.provider, endpoint);

  const result = streamText({
    model,
    messages: promptCache.prepareMessages(sdkMessages),
    instructions: promptCache.instructions,
    tools,
    toolsContext,
    runtimeContext,
    toolApproval: buildCattyToolApproval({
      permissionMode: runtimeContext.permissionMode,
      chatSessionId: runtimeContext.chatSessionId,
    }),
    stopWhen: isStepCount(maxIterations),
    abortSignal: signal,
    include: { rawChunks: true },
    timeout: buildCattyStreamTimeouts({
      permissionMode: runtimeContext.permissionMode,
      commandTimeoutMs,
      responseIdleTimeoutMs,
      maxIterations,
    }),
    telemetry: {
      functionId: `catty-${runtimeContext.agentKind}`,
      metadata: {
        chatSessionId: runtimeContext.chatSessionId,
        turnId: runtimeContext.turnId,
      },
    },
    onStart: ({ callId, modelId, runtimeContext: startContext }) => {
      onAgentEvent?.({
        id: `model-call-start-${callId}`,
        type: 'model_call_start',
        sessionId: streamSessionId,
        chatSessionId: startContext.chatSessionId,
        backend: 'catty',
        timestamp: Date.now(),
        turnId,
        callId,
        modelId,
        providerId: startContext.providerId,
      } as AgentEvent);
    },
    onStepEnd: (step) => {
      const usage = step.usage;
      onAgentEvent?.({
        id: `step-end-${step.callId}-${step.stepNumber}`,
        type: 'step_end',
        sessionId: streamSessionId,
        chatSessionId: step.runtimeContext.chatSessionId,
        backend: 'catty',
        timestamp: Date.now(),
        turnId,
        callId: step.callId,
        stepNumber: step.stepNumber,
        modelId: step.model.modelId,
        finishReason: step.finishReason,
        promptTokens: usage.inputTokens ?? 0,
        cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      } as AgentEvent);
    },
    onEnd: ({ callId, usage, runtimeContext: endContext }) => {
      if (usage) {
        onAgentEvent?.({
          id: `usage-${callId}`,
          type: 'usage',
          sessionId: streamSessionId,
          chatSessionId: endContext.chatSessionId,
          backend: 'catty',
          timestamp: Date.now(),
          turnId,
          promptTokens: usage.inputTokens ?? 0,
          cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
          completionTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
          totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          estimated: false,
        } as AgentEvent);
      }
    },
    ...(prepareStep || promptCache.enabled ? {
      prepareStep: async ({ stepNumber, messages, runtimeContext: stepRuntimeContext }) => {
        const prepared = await prepareStep?.({
          stepNumber,
          messages,
          runtimeContext: stepRuntimeContext as CattyRuntimeContext,
        });
        if (prepared?.runtimeContext) {
          runtimeContext = prepared.runtimeContext;
        }
        return { ...prepared, messages: promptCache.prepareMessages(prepared?.messages ?? messages) };
      },
    } : {}),
    ...(advancedParams?.maxTokens != null && { maxOutputTokens: advancedParams.maxTokens }),
    ...(advancedParams?.temperature != null && { temperature: advancedParams.temperature }),
    ...(advancedParams?.topP != null && { topP: advancedParams.topP }),
    ...(advancedParams?.frequencyPenalty != null && { frequencyPenalty: advancedParams.frequencyPenalty }),
    ...(advancedParams?.presencePenalty != null && { presencePenalty: advancedParams.presencePenalty }),
    ...(reasoningProviderOptions ? { providerOptions: reasoningProviderOptions } : {}),
  });

  let activeMsgId = currentAssistantMsgId;
  let lastAddedRole: 'assistant' | 'tool' = 'assistant';
  let hadToolProgress = false;
  const reader = result.stream.getReader();

  let pendingText = '';
  let rafId: number | null = null;

  const clearCompactionStatusFromAssistant = (messageId: string) => {
    ui.updateMessageById(streamSessionId, messageId, msg =>
      msg.role === 'assistant' && msg.statusText
        ? { ...msg, statusText: undefined }
        : msg,
    );
  };

  const ensureAssistantMessage = (): string => {
    if (lastAddedRole !== 'tool') return activeMsgId;
    clearCompactionStatusFromAssistant(activeMsgId);
    const newId = generateId();
    ui.addMessageToSession(streamSessionId, {
      id: newId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    });
    activeMsgId = newId;
    lastAddedRole = 'assistant';
    return activeMsgId;
  };

  const updateAssistantContinuation = (
    messageId: string,
    continuation: ProviderContinuation | undefined,
    thinkingText = '',
  ) => {
    if (!continuation && !thinkingText) return;
    const sourcedContinuation = withProviderContinuationSource(continuation, continuationContext?.source);
    ui.updateMessageById(streamSessionId, messageId, msg => {
      const providerContinuation = mergeProviderContinuation(msg.providerContinuation, sourcedContinuation);
      return {
        ...msg,
        ...(providerContinuation ? { providerContinuation } : {}),
        ...(thinkingText ? { thinking: (msg.thinking || '') + thinkingText } : {}),
      };
    });
  };

  const getOpenAIReasoningText = (continuation: ProviderContinuation | undefined): string => {
    const reasoningContent = continuation?.openAIChatAssistantFields?.reasoning_content;
    return typeof reasoningContent === 'string' ? reasoningContent : '';
  };

  const flushText = () => {
    if (pendingText) {
      const text = pendingText;
      pendingText = '';
      if (lastAddedRole === 'tool') {
        clearCompactionStatusFromAssistant(activeMsgId);
        const newId = generateId();
        ui.addMessageToSession(streamSessionId, {
          id: newId,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
        });
        activeMsgId = newId;
        lastAddedRole = 'assistant';
      } else {
        ui.updateMessageById(streamSessionId, activeMsgId, msg => ({
          ...msg,
          content: msg.content + text,
          ...(msg.statusText ? { statusText: undefined } : {}),
        }));
      }
    }
    rafId = null;
  };

  const cancelPendingFlush = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const appendToolResultToUi = (toolCallId: string, content: string, isError: boolean) => {
    cancelPendingFlush();
    flushText();
    hadToolProgress = true;
    ui.updateMessageById(streamSessionId, activeMsgId, msg =>
      msg.role === 'assistant' && msg.executionStatus === 'running'
        ? { ...msg, executionStatus: 'completed', statusText: undefined } : msg,
    );
    ui.addMessageToSession(streamSessionId, {
      id: generateId(),
      role: 'tool',
      content: '',
      toolResults: [{
        toolCallId,
        content,
        isError,
      }],
      timestamp: Date.now(),
      executionStatus: 'completed',
    });
    lastAddedRole = 'tool';
  };

  const deniedToolResultIds = new Set<string>();
  const appendDeniedToolResultToUi = (toolCallId: string, reason?: unknown) => {
    if (deniedToolResultIds.has(toolCallId)) return;
    deniedToolResultIds.add(toolCallId);
    appendToolResultToUi(
      toolCallId,
      formatToolErrorContent(reason, 'Tool execution denied.'),
      true,
    );
  };

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<unknown>;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        if (isRequestTooLargeError(readErr)) {
          throw createCattyRequestTooLargeRetryError(readErr, hadToolProgress);
        }
        throw readErr;
      }
      const { done, value } = readResult;
      if (done) break;
      const chunk = value as StreamChunk;
      if (shouldEmitAgentEventsForStreamChunk(chunk)) {
        for (const agentEvent of mapCattyStreamChunkToAgentEvents(chunk, {
          sessionId: streamSessionId,
          chatSessionId: streamSessionId,
          turnId,
        })) {
          onAgentEvent?.(agentEvent);
        }
      }
      switch (chunk.type) {
        case 'text':
        case 'text-delta': {
          const typedChunk = chunk as TextDeltaChunk;
          const text = typedChunk.text ?? typedChunk.textDelta;
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (providerOptions) {
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, { textProviderOptions: providerOptions });
          }
          if (text) {
            pendingText += text;
            if (rafId === null) {
              rafId = requestAnimationFrame(flushText);
            }
          }
          break;
        }
        case 'reasoning':
        case 'reasoning-start':
        case 'reasoning-delta': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ReasoningChunk;
          const rText = typedChunk.text ?? typedChunk.textDelta ?? typedChunk.delta ?? '';
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          const continuation = rText || providerOptions
            ? {
                reasoningParts: [{
                  text: rText,
                  ...(providerOptions ? { providerOptions } : {}),
                }],
              } satisfies ProviderContinuation
            : undefined;
          if (continuation || rText) {
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, continuation, rText);
          }
          break;
        }
        case 'raw': {
          const typedChunk = chunk as RawChunk;
          const continuation = extractProviderContinuationFromRawChunk(typedChunk.rawValue);
          if (continuation) {
            cancelPendingFlush();
            flushText();
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, continuation, getOpenAIReasoningText(continuation));
          }
          break;
        }
        case 'reasoning-end': {
          // With Responses `store: false`, the SDK delivers the reasoning
          // item's encrypted content on the reasoning-end chunk (via
          // output_item.done). It must be merged into the persisted reasoning
          // parts or the stateless replay silently drops the reasoning item.
          // Skip metadata without ciphertext (e.g. store:true item ids) so a
          // null payload cannot overwrite a previously captured one.
          const typedChunk = chunk as { providerMetadata?: unknown };
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          if (providerOptions && hasReasoningEncryptedContent(providerOptions)) {
            cancelPendingFlush();
            flushText();
            const messageId = ensureAssistantMessage();
            updateAssistantContinuation(messageId, {
              reasoningParts: [{ text: '', providerOptions }],
            });
          }
          break;
        }
        case 'text-start':
        case 'text-end':
        case 'start':
        case 'finish':
        case 'start-step':
        case 'finish-step':
        case 'tool-approval-request':
          break;
        case 'tool-approval-response': {
          const typedChunk = chunk as ToolApprovalResponseChunk;
          if (typedChunk.approved === false) {
            const toolCallId = resolveStreamChunkToolCallId(typedChunk);
            if (toolCallId) {
              appendDeniedToolResultToUi(toolCallId, typedChunk.reason);
            }
          }
          break;
        }
        case 'tool-call': {
          cancelPendingFlush();
          flushText();
          const typedChunk = chunk as ToolCallChunk;
          hadToolProgress = true;
          const messageId = ensureAssistantMessage();
          const providerOptions = normalizeProviderContinuationOptions(typedChunk.providerMetadata);
          ui.updateMessageById(streamSessionId, messageId, msg => ({
            ...msg,
            toolCalls: [...(msg.toolCalls || []), {
              id: typedChunk.toolCallId,
              name: typedChunk.toolName,
              arguments: (typedChunk.input ?? typedChunk.args) as Record<string, unknown>,
            }],
            executionStatus: 'running',
            statusText: undefined,
          }));
          if (providerOptions) {
            updateAssistantContinuation(messageId, {
              toolCallProviderOptionsById: {
                [typedChunk.toolCallId]: providerOptions,
              },
            });
          }
          break;
        }
        case 'tool-result': {
          const typedChunk = chunk as ToolResultChunk;
          const toolOutput = typedChunk.output ?? typedChunk.result;
          appendToolResultToUi(
            typedChunk.toolCallId,
            typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
            isToolResultError(toolOutput),
          );
          break;
        }
        case 'tool-error': {
          const typedChunk = chunk as ToolErrorChunk;
          appendToolResultToUi(
            typedChunk.toolCallId,
            formatToolErrorContent(typedChunk.error),
            true,
          );
          break;
        }
        case 'tool-output-denied': {
          const typedChunk = chunk as ToolOutputDeniedChunk;
          appendDeniedToolResultToUi(typedChunk.toolCallId);
          break;
        }
        case 'error': {
          const typedChunk = chunk as ErrorChunk;
          if (isSdkStreamStateError(typedChunk.error)) {
            console.warn('[Catty] suppressed SDK stream state error:', typedChunk.error);
            break;
          }
          if (isRequestTooLargeError(typedChunk.error)) {
            cancelPendingFlush();
            flushText();
            throw createCattyRequestTooLargeRetryError(
              typedChunk.error,
              hadToolProgress,
            );
          }
          cancelPendingFlush();
          flushText();
          ui.updateMessageById(streamSessionId, activeMsgId, msg => ({
            ...msg,
            statusText: '',
            executionStatus: msg.executionStatus === 'running' ? 'failed' : msg.executionStatus,
          }));
          ui.addMessageToSession(streamSessionId, {
            id: generateId(),
            role: 'assistant',
            content: '',
            errorInfo: classifyError(typedChunk.error),
            timestamp: Date.now(),
          });
          break;
        }
        default:
          break;
      }
    }
  } finally {
    cancelPendingFlush();
    flushText();
    reader.releaseLock();
  }

  const usage = await result.usage;
  const finalStep = await result.finalStep;
  const performance = finalStep?.performance;
  // onEnd can run before this consumer flushes its final text and creates the
  // post-tool assistant message. Attach turn totals only after that flush.
  if (usage) {
    ui.updateMessageById(streamSessionId, activeMsgId, message => ({
      ...message,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        estimated: false,
      },
    }));
  }

  if (performance) {
    onAgentEvent?.({
      id: `performance-${turnId ?? Date.now()}`,
      type: 'performance',
      sessionId: streamSessionId,
      chatSessionId: runtimeContext.chatSessionId,
      backend: 'catty',
      timestamp: Date.now(),
      turnId,
      responseTimeMs: performance.responseTimeMs,
      timeToFirstOutputMs: performance.timeToFirstOutputMs,
      outputTokensPerSecond: performance.outputTokensPerSecond,
    } as AgentEvent);
  }

  return {
    usage: usage ? {
      promptTokens: usage.inputTokens,
      cachedPromptTokens: usage.inputTokenDetails?.cacheReadTokens,
      completionTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    } : undefined,
    performance: performance ? {
      responseTimeMs: performance.responseTimeMs,
      timeToFirstOutputMs: performance.timeToFirstOutputMs,
      outputTokensPerSecond: performance.outputTokensPerSecond,
    } : undefined,
  };
}

export { hadToolProgressBeforeRequestTooLarge };
