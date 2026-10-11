import { globalTraceStore } from './traceStore';
import { stopAgentTurn } from './agentStop';
import type { AgentBackend, AgentEvent, AgentEventListener } from './types';
import { ToolOutputStore } from './toolOutputStore';
import { ToolResultDedup } from './toolResultDedup';
import { SessionStateStore } from './sessionState';
import type {
  TurnDriver,
  TurnInput,
  TurnResult,
  TurnSteerInput,
  TurnSteerResult,
} from './turnDrivers/types';
import { globalTwoPassCompactionCache } from './twoPassCompaction';
import { redactSecretsForModel, redactSecretsInValueForModel } from './modelSecretRedaction';
import { globalTerminalMonitorGuard } from './terminalMonitorGuard';

let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  return `turn-${Date.now()}-${turnCounter}`;
}

function isFailedToolResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed?.ok === false || typeof parsed?.error === 'string';
  } catch {
    return false;
  }
}

interface ActiveTurn {
  turnId: string;
  backend: AgentBackend;
  driver: TurnDriver;
}

export interface AgentRuntimeOptions {
  drivers: TurnDriver[];
  traceStore?: typeof globalTraceStore;
  sessionStateStore?: SessionStateStore;
}

export class AgentRuntime {
  private readonly drivers = new Map<AgentBackend, TurnDriver>();
  private readonly listeners = new Set<AgentEventListener>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeTurnPromises = new Map<string, Promise<TurnResult>>();
  private readonly toolOutputStore = new ToolOutputStore();
  private readonly sessionStateStore: SessionStateStore;
  private readonly traceStore: typeof globalTraceStore;

  constructor(options: AgentRuntimeOptions) {
    for (const driver of options.drivers) {
      this.drivers.set(driver.backend, driver);
    }
    this.traceStore = options.traceStore ?? globalTraceStore;
    this.sessionStateStore = options.sessionStateStore ?? new SessionStateStore();
  }

  getToolOutputStore(chatSessionId: string): ToolOutputStore {
    void chatSessionId;
    return this.toolOutputStore;
  }

  getSessionStateStore(): SessionStateStore {
    return this.sessionStateStore;
  }

  clearChatSession(chatSessionId: string): void {
    this.toolOutputStore.prune(chatSessionId);
    this.sessionStateStore.clear(chatSessionId);
    this.traceStore.clear(chatSessionId);
    globalTwoPassCompactionCache.clear(chatSessionId);
    globalTerminalMonitorGuard.clearPrefix(`${chatSessionId}:`);
  }

  clearTerminalSession(terminalSessionId: string): void {
    this.toolOutputStore.pruneTerminalSessionEverywhere(terminalSessionId);
  }

  async waitForActiveTurn(chatSessionId: string): Promise<void> {
    await this.activeTurnPromises.get(chatSessionId)?.catch(() => {});
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Whether a turn is currently registered for `chatSessionId`. The chat panel
   * uses this to reconcile its Stop button against the runtime: the shared
   * streaming set can outlive a turn whose completion notification was lost, and
   * a missing turn is proof the composer is idle again.
   */
  hasActiveTurn(chatSessionId: string): boolean {
    return this.activeTurnPromises.has(chatSessionId);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const chatSessionId = input.chatSessionId;
    let turnPromise: Promise<TurnResult> | null = null;
    try {
      const driver = this.drivers.get(input.backend);
      if (!driver) {
        throw new Error(`No TurnDriver registered for backend "${input.backend}"`);
      }

      if (this.activeTurnPromises.has(chatSessionId)) {
        const error = new Error(`Agent turn already in progress for session ${chatSessionId}`);
        (error as Error & { code?: string }).code = 'AGENT_TURN_BUSY';
        throw error;
      }

      turnPromise = this.runTurnInternal(input, driver);
      this.activeTurnPromises.set(chatSessionId, turnPromise);
      return await turnPromise;
    } finally {
      if (turnPromise && this.activeTurnPromises.get(chatSessionId) === turnPromise) {
        this.activeTurnPromises.delete(chatSessionId);
      }
      // Single choke point for the chat panel's streaming flag. Drivers and the
      // panel clear it on their own happy paths, but a driver that throws, an
      // aborted turn, a missing driver, or a busy-session rejection could leave
      // the shared set holding the id — the panel then reads it as "still
      // streaming" and shows the Stop button forever.
      input.ui?.setStreamingForScope?.(chatSessionId, false);
    }
  }

  private async runTurnInternal(input: TurnInput, driver: TurnDriver): Promise<TurnResult> {
    const turnId = nextTurnId();
    const chatSessionId = input.chatSessionId;
    const toolOutputStore = this.getToolOutputStore(chatSessionId);
    const toolResultDedup = new ToolResultDedup();
    toolResultDedup.beginTurn();
    const sessionStateStore = this.sessionStateStore;

    if (input.backend === 'catty') {
      sessionStateStore.mergeFromUserGoal(chatSessionId, input.userText);
    }

    this.activeTurns.set(chatSessionId, {
      turnId,
      backend: input.backend,
      driver,
    });

    const toolCallMeta = new Map<string, { toolName: string; args: Record<string, unknown> }>();

    const emit = (
      partial: Omit<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>
        & Partial<Pick<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>>,
    ) => {
      let event = {
        id: partial.id,
        type: partial.type,
        sessionId: partial.sessionId ?? chatSessionId,
        chatSessionId: partial.chatSessionId ?? chatSessionId,
        backend: partial.backend ?? input.backend,
        timestamp: partial.timestamp ?? Date.now(),
        turnId: partial.turnId ?? turnId,
        ...partial,
      } as AgentEvent;

      if (event.type === 'tool_result') {
        event = {
          ...event,
          result: redactSecretsForModel(event.result),
        };
      }

      if (event.type === 'tool_call') {
        event = {
          ...event,
          args: redactSecretsInValueForModel(event.args),
        };
        toolCallMeta.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
        });
      }
      if (event.type === 'tool_result') {
        const toolResultIsError = event.isError || isFailedToolResult(event.result);
        const meta = toolCallMeta.get(event.toolCallId);
        const toolName = event.toolName ?? meta?.toolName;
        if (toolName) {
          sessionStateStore.updateFromToolResult(
            chatSessionId,
            toolName,
            meta?.args,
            event.result,
            toolResultIsError,
          );
          if (
            !toolResultIsError
            && (toolName === 'session_close' || toolName === 'session.close')
            && typeof meta?.args.sessionId === 'string'
          ) {
            toolOutputStore.pruneTerminalSessionEverywhere(meta.args.sessionId);
          }
        }
      }
      if (event.type === 'model_delta' && event.text) {
        sessionStateStore.mergeFromAssistantContent(chatSessionId, event.text);
      }
      if (event.type === 'file_change' && event.status === 'completed') {
        sessionStateStore.mergeFileChanges(
          chatSessionId,
          event.changes.map(change => change.path),
        );
      }
      if (event.type === 'plan_update') {
        sessionStateStore.mergePlan(chatSessionId, event.items);
      }

      this.traceStore.append(event);
      for (const listener of this.listeners) {
        listener(event);
      }
    };

    emit({
      id: `turn-start-${turnId}`,
      type: 'turn_start',
      backendLabel: input.backend === 'external-sdk'
        ? ('agentConfig' in input ? input.agentConfig.name : undefined)
        : 'catty',
    } as AgentEvent);

    let reason: TurnResult['reason'] = 'completed';

    try {
      await driver.run(input, {
        turnId,
        chatSessionId,
        sessionId: chatSessionId,
        backend: input.backend,
        signal: input.signal,
        emit,
        toolOutputStore,
        toolResultDedup,
        sessionStateStore,
      });
      if (input.signal.aborted) {
        reason = 'aborted';
      }
    } catch (err) {
      reason = 'error';
      emit({
        id: `turn-error-${turnId}`,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      } as AgentEvent);
      throw err;
    } finally {
      emit({
        id: `turn-end-${turnId}`,
        type: 'turn_end',
        reason,
      } as AgentEvent);
      this.activeTurns.delete(chatSessionId);
    }

    return { turnId, reason };
  }

  async stopTurn(chatSessionId: string, reason: 'user' | 'slash' = 'user'): Promise<void> {
    const active = this.activeTurns.get(chatSessionId);
    active?.driver.abort?.(chatSessionId);
    await stopAgentTurn({
      chatSessionId,
      reason,
      backend: active?.backend ?? 'catty',
    });
    await this.waitForActiveTurn(chatSessionId);
  }

  async steerTurn(input: TurnSteerInput): Promise<TurnSteerResult> {
    const active = this.activeTurns.get(input.chatSessionId);
    if (!active) return { status: 'inactive' };
    if (!active.driver.steer) return { status: 'unsupported' };
    return active.driver.steer(input);
  }
}
