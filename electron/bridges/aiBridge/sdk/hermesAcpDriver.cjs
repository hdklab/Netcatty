"use strict";

/**
 * Hermes Agent (hermes) ACP turn runner — `hermes acp` JSON-RPC over stdio.
 *
 * The existing one-shot path (`hermes -z <prompt>` in hermesDriver.cjs) prints
 * ONLY the final answer, so the sidebar shows no reasoning, tool calls or real
 * token usage. Hermes ships an Agent Client Protocol server (`hermes acp`) that
 * streams `session/update` notifications for thoughts, message chunks, tool
 * calls/results and context usage. This driver speaks that protocol and maps
 * the updates onto the canonical Netcatty emitter events.
 *
 * Lifecycle (Agent Client Protocol):
 *   initialize → session/new (or session/resume | session/load)
 *   → session/prompt → session/update notifications
 *
 * Credentials: Hermes resolves its own provider credentials from
 * `~/.hermes/.env` (loaded by the ACP adapter at startup), so no
 * `authenticate` call is needed. The advertised authMethods are informational.
 *
 * Generic ACP pieces (json-rpc client, permission responses, MCP server mapping,
 * prompt/init shapes, capability parsing, update translation) are reused from
 * grokAcpDriver.cjs / grokDriver.cjs; Hermes specifics (usage_update, tool
 * content blocks, fs/terminal client handlers, fallback) live here.
 *
 * Fallback: if `hermes acp` cannot be spawned, or the protocol fails BEFORE a
 * session is established, this driver falls back to the existing one-shot
 * `runHermesTurn` so the user still gets an answer.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");
const {
  createLineBuffer,
  emitGrokUsage,
  extractGrokAcpPromptUsage,
  resolveGrokTurnPrompt,
  shouldReportGrokProcessExitFailure,
} = require("./grokDriver.cjs");
const {
  ACP_PROTOCOL_VERSION,
  buildGrokAcpPermissionResponse,
  buildGrokAcpPromptParams,
  buildGrokAcpSessionResumeOrLoadParams,
  createJsonRpcClient,
  parseGrokAcpAgentCapabilities,
  planGrokAcpSessionEstablish,
  resolveGrokAcpCwd,
  toAcpMcpServers,
  translateGrokAcpUpdate,
} = require("./grokAcpDriver.cjs");
const { runHermesTurn } = require("./hermesDriver.cjs");

const HERMES_ACP_ABORT_GRACE_MS = 1_500;
const MAX_HERMES_ACP_LINE_BYTES = 10 * 1024 * 1024;
const MAX_HERMES_ACP_STDERR_CHARS = 64 * 1024;
const HERMES_ACP_REQUEST_TIMEOUT_MS = 30_000;
const HERMES_ACP_PROMPT_TIMEOUT_MS = 30 * 60_000;
const HERMES_ACP_SESSION_TIMEOUT_MS = 30_000;
const HERMES_ACP_TERMINAL_BYTE_LIMIT = 1024 * 1024;

/** argv for `hermes acp` (the ACP server subcommand). */
function buildHermesAcpSpawnArgs() {
  return ["acp"];
}

function signalProcessTree(child, signal, forceKillImpl) {
  if (!child) return;
  if (typeof forceKillImpl === "function") {
    try { forceKillImpl(child, signal); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32" && signal === "SIGKILL" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
      killer.unref?.();
      return;
    } catch {
      // fall through
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

/**
 * Client capabilities advertised to the Hermes ACP server. Netcatty answers the
 * fs/terminal client methods below, so it can honestly advertise them as
 * supported (grok advertises false and handles its own tooling).
 */
function buildHermesAcpInitializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "netcatty", version: "0.0.0" },
  };
}

/**
 * session/new params: absolute cwd + Netcatty MCP servers as ACP stdio entries.
 * No grok-style `_meta` (Hermes does not consume yoloMode/rules).
 */
function buildHermesAcpSessionNewParams({ cwd, injectedMcpServers } = {}) {
  return {
    cwd: resolveGrokAcpCwd(cwd),
    mcpServers: toAcpMcpServers(injectedMcpServers),
  };
}

/** Concatenate ACP content blocks / bare strings into plain text. */
function hermesAcpContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block == null) continue;
      if (typeof block === "string") { parts.push(block); continue; }
      if (typeof block.text === "string") { parts.push(block.text); continue; }
      const inner = block.content;
      if (typeof inner === "string") { parts.push(inner); continue; }
      if (inner && typeof inner.text === "string") { parts.push(inner.text); continue; }
    }
    return parts.join("\n");
  }
  if (typeof content.text === "string") return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** Human-readable tool name for a Hermes `tool_call`. */
function hermesAcpToolName(update) {
  return String(
    update?.toolName
    || update?.tool_name
    || update?.title
    || update?.kind
    || "tool",
  );
}

/** Tool arguments for a `tool_call`: rawInput when present, else content/kind. */
function hermesAcpToolArgs(update) {
  if (update?.rawInput && typeof update.rawInput === "object") return update.rawInput;
  const args = {};
  if (update?.kind) args.kind = String(update.kind);
  if (update?.title) args.title = String(update.title);
  const text = hermesAcpContentText(update?.content);
  if (text) args.content = text;
  return args;
}

function resultToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (typeof result.text === "string") return result.text;
    try { return JSON.stringify(result); } catch { return String(result); }
  }
  return String(result);
}

/** Final text of a `tool_call_update`, or null when the update carries none. */
function hermesAcpToolResultText(update) {
  if (update?.rawOutput != null) return resultToText(update.rawOutput);
  if (update?.content != null) return hermesAcpContentText(update.content);
  if (update?.error != null) return resultToText(update.error);
  return null;
}

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

/**
 * Forward Hermes usage onto the canonical emitter.
 * - prompt result: `{ inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens }`
 * - `usage_update` notification: `{ size, used }` (context-window progress)
 */
function emitHermesAcpUsage(emitter, usage) {
  if (!usage || typeof usage !== "object" || typeof emitter?.usage !== "function") return false;
  // usage_update carries only context-window progress, not a per-turn split.
  if (
    usage.used != null
    && usage.inputTokens == null
    && usage.outputTokens == null
    && usage.input_tokens == null
  ) {
    const used = Number(usage.used) || 0;
    if (!used) return false;
    emitter.usage({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: used,
    });
    return true;
  }
  // Reuse the shared mapper; teach it Hermes' thoughtTokens name.
  const normalized = {
    ...usage,
    reasoningTokens: usage.reasoningTokens ?? usage.thoughtTokens ?? usage.thought_tokens,
  };
  return emitGrokUsage(emitter, normalized);
}

/**
 * Map one Hermes ACP `session/update` payload to emitter calls.
 * Hermes-specific kinds are handled here; text/thought/plan defer to the
 * shared grok translator (identical ACP shapes).
 * @returns {boolean} true when the stream should stop on error
 */
function translateHermesAcpUpdate(update, emitter, state = {}) {
  if (!update || typeof update !== "object") return false;
  const kind = String(update.sessionUpdate || update.type || "");

  switch (kind) {
    case "agent_message_chunk":
    case "message_chunk":
    case "text": {
      state.streamedAny = true;
      return translateGrokAcpUpdate(update, emitter, state);
    }

    case "agent_thought_chunk":
    case "thought_chunk":
    case "thought": {
      state.streamedAny = true;
      return translateGrokAcpUpdate(update, emitter, state);
    }

    case "usage_update": {
      emitHermesAcpUsage(emitter, update);
      return false;
    }

    case "tool_call": {
      closeReasoning(state, emitter);
      const id = update.toolCallId || update.tool_call_id || update.id;
      if (!id) return false;
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();
      const name = hermesAcpToolName(update);
      state.toolNames.set(id, name);
      state.streamedAny = true;
      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        emitter.toolCall(name, hermesAcpToolArgs(update), id);
      }
      return false;
    }

    case "tool_call_update": {
      closeReasoning(state, emitter);
      const id = update.toolCallId || update.tool_call_id || update.id;
      if (!id) return false;
      if (!state.emittedToolResults) state.emittedToolResults = new Set();
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();
      const name = state.toolNames.get(id) || hermesAcpToolName(update);
      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        state.toolNames.set(id, name);
        emitter.toolCall(name, hermesAcpToolArgs(update), id);
      }
      const status = String(update.status || "").toLowerCase();
      const terminal = status === "completed"
        || status === "failed"
        || status === "error"
        || status === "cancelled";
      if ((terminal || update.rawOutput != null) && !state.emittedToolResults.has(id)) {
        state.emittedToolResults.add(id);
        emitter.toolResult(id, hermesAcpToolResultText(update) ?? "", name);
      }
      return false;
    }

    case "error": {
      closeReasoning(state, emitter);
      state.failed = true;
      emitter.emitError(formatHermesError(update.message || update.error || "Hermes ACP turn failed"));
      return true;
    }

    default:
      return translateGrokAcpUpdate(update, emitter, state);
  }
}

/** Build a settled terminal record that buffers stdout/stderr for terminal/*. */
function createTerminalRecord({ child, limit }) {
  const record = {
    child,
    output: "",
    truncated: false,
    exitCode: null,
    signal: null,
    done: false,
    limit,
    waiters: [],
  };
  const settle = () => {
    if (record.done) return;
    record.done = true;
    for (const resolve of record.waiters) {
      try { resolve(); } catch { /* ignore */ }
    }
    record.waiters.length = 0;
  };
  const append = (chunk) => {
    if (record.output.length >= record.limit) { record.truncated = true; return; }
    record.output += String(chunk);
    if (record.output.length > record.limit) {
      record.output = record.output.slice(0, record.limit);
      record.truncated = true;
    }
  };
  child.stdout?.on?.("data", append);
  child.stderr?.on?.("data", append);
  child.on?.("error", (err) => {
    append(`\n${err?.message || err}`);
    if (record.exitCode == null) record.exitCode = -1;
    settle();
  });
  child.on?.("close", (code, sig) => {
    record.exitCode = code;
    record.signal = sig ?? null;
    settle();
  });
  record.wait = () => new Promise((resolve) => {
    if (record.done) { resolve(); return; }
    record.waiters.push(resolve);
  });
  return record;
}

/**
 * ACP client → agent response handlers for the methods the Hermes agent may
 * call back into Netcatty. `session/request_permission` is answered in
 * handleHermesAcpMessage (it needs the Netcatty permission mode); the rest live
 * here. Paths are resolved against the session cwd.
 */
function createHermesAcpClientHandlers({
  cwd,
  fsModule = fs,
  spawnImpl = spawn,
  terminals = new Map(),
} = {}) {
  const fsx = fsModule;
  let seq = 0;

  const resolvePath = (raw) => {
    const value = String(raw || "").trim();
    if (!value) return null;
    return path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
  };

  const requireTerminal = (params) => {
    const id = String(params?.terminalId || "");
    const record = terminals.get(id);
    if (!record) throw new Error(`Unknown terminal: ${id}`);
    return record;
  };

  return {
    terminals,

    "fs/read_text_file"(params) {
      const target = resolvePath(params?.path);
      if (!target) throw new Error("fs/read_text_file requires a path");
      let content = fsx.readFileSync(target, "utf8");
      const line = Number(params?.line);
      const limit = Number(params?.limit);
      if (Number.isFinite(line) && line > 0) {
        const lines = content.split("\n");
        const start = line - 1;
        const end = Number.isFinite(limit) && limit > 0 ? start + limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return { content };
    },

    "fs/write_text_file"(params) {
      const target = resolvePath(params?.path);
      if (!target) throw new Error("fs/write_text_file requires a path");
      fsx.mkdirSync(path.dirname(target), { recursive: true });
      fsx.writeFileSync(target, String(params?.content ?? ""), "utf8");
      return null;
    },

    "terminal/create"(params) {
      const command = String(params?.command || "").trim();
      if (!command) throw new Error("terminal/create requires a command");
      const args = Array.isArray(params?.args) ? params.args.map(String) : [];
      const childCwd = resolvePath(params?.cwd) || cwd || process.cwd();
      const childEnv = params?.env && typeof params.env === "object"
        ? { ...process.env, ...params.env }
        : process.env;
      const limit = Number(params?.outputByteLimit);
      const spawnFn = spawnImpl || spawn;
      const child = spawnFn(command, args, {
        cwd: childCwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const record = createTerminalRecord({
        child,
        limit: Number.isFinite(limit) && limit > 0 ? limit : HERMES_ACP_TERMINAL_BYTE_LIMIT,
      });
      const id = `hermes-term-${++seq}`;
      record.id = id;
      terminals.set(id, record);
      return { terminalId: id };
    },

    "terminal/output"(params) {
      const record = requireTerminal(params);
      const result = { output: record.output, truncated: record.truncated };
      if (record.done) {
        result.exitStatus = { exitCode: record.exitCode, signal: record.signal };
      }
      return result;
    },

    async "terminal/wait_for_exit"(params) {
      const record = requireTerminal(params);
      await record.wait();
      return { exitCode: record.exitCode, signal: record.signal };
    },

    "terminal/kill"(params) {
      const record = requireTerminal(params);
      try { record.child.kill("SIGTERM"); } catch { /* ignore */ }
      return null;
    },

    "terminal/release"(params) {
      const id = String(params?.terminalId || "");
      const record = terminals.get(id);
      if (record && !record.done) {
        try { record.child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      terminals.delete(id);
      return null;
    },
  };
}

function formatHermesError(message) {
  const text = String(message || "").trim();
  return text || "Hermes ACP turn failed";
}

/** Agent → client JSON-RPC request dispatch (fs/terminal + permission). */
function handleHermesAcpClientRequest(message, { state }) {
  const method = String(message.method || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const id = message.id;

  if (method === "session/request_permission" || method === "request_permission") {
    // Non-interactive: auto-allow unless observer mode. optionId comes from args.
    const result = buildGrokAcpPermissionResponse(params, state.autoAllowPermissions !== false);
    state.writeResponse?.(id, result);
    return;
  }

  const handler = state.clientHandlers && typeof state.clientHandlers[method] === "function"
    ? state.clientHandlers[method]
    : null;
  if (!handler) {
    state.writeError?.(id, { code: -32601, message: `Method not supported: ${method}` });
    return;
  }
  Promise.resolve()
    .then(() => handler(params, message))
    .then((result) => state.writeResponse?.(id, result ?? null))
    .catch((err) => state.writeError?.(id, { code: -32603, message: err?.message || String(err) }));
}

/**
 * Handle a parsed JSON-RPC message from `hermes acp`.
 */
function handleHermesAcpMessage(message, { emitter, state, pending, onPromptComplete }) {
  if (!message || typeof message !== "object") return;

  // Agent → client request (has both an id and a method).
  if (message.id != null && message.method) {
    handleHermesAcpClientRequest(message, { state });
    return;
  }

  // Response to one of our requests.
  if (message.id != null && !message.method) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(
          message.error.message || message.error.data || JSON.stringify(message.error),
        ));
      } else {
        // Mark turn complete + emit usage synchronously so teardown/close
        // cannot race past usage emission (UI falls back to estimated Token ~1).
        if (state.promptRequestId != null && message.id === state.promptRequestId) {
          state.turnCompleted = true;
          emitHermesAcpUsage(emitter, extractGrokAcpPromptUsage(message.result));
          onPromptComplete?.(message);
        }
        waiter.resolve(message.result);
      }
    }
    return;
  }

  const method = String(message.method || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "session/update" || method === "hermes/session/update") {
    // session/load may replay history; only accept updates after session/prompt.
    if (state.acceptUpdates === false) {
      if (params.sessionId && !state.sessionId) state.sessionId = params.sessionId;
      return;
    }
    const update = params.update || params.sessionUpdate || params;
    const payload = update?.sessionUpdate || update?.type
      ? update
      : (params.sessionUpdate ? { sessionUpdate: params.sessionUpdate, ...params } : update);
    if (payload) translateHermesAcpUpdate(payload, emitter, state);
    if (params.sessionId && !state.sessionId) {
      state.sessionId = params.sessionId;
      emitter.sessionId?.(params.sessionId);
    }
  }
}

/**
 * Establish a session: try the planned methods until one succeeds.
 * Caller MUST keep acceptUpdates=false until this returns.
 */
async function establishHermesAcpSession(rpc, {
  resumeSessionId,
  cwd,
  injectedMcpServers,
  agentCapabilities,
} = {}) {
  const methods = planGrokAcpSessionEstablish({ resumeSessionId, agentCapabilities });
  let lastError = null;
  for (const method of methods) {
    try {
      if (method === "new") {
        const created = await rpc.request(
          "session/new",
          buildHermesAcpSessionNewParams({ cwd, injectedMcpServers }),
          { timeoutMs: HERMES_ACP_SESSION_TIMEOUT_MS },
        );
        const sessionId = created?.sessionId || created?.session_id;
        if (!sessionId) throw new Error("Hermes ACP session/new did not return a sessionId");
        return { sessionId, method: "new" };
      }
      if (method === "resume" || method === "load") {
        const result = await rpc.request(
          `session/${method}`,
          buildGrokAcpSessionResumeOrLoadParams({
            sessionId: resumeSessionId,
            cwd,
            injectedMcpServers,
          }),
          { timeoutMs: HERMES_ACP_SESSION_TIMEOUT_MS },
        );
        const sessionId = result?.sessionId || result?.session_id || resumeSessionId;
        return { sessionId, method };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Hermes ACP session establish failed");
}

async function runHermesAcpTurn({
  prompt,
  systemPrompt,
  binPath,
  cwd,
  model,
  env,
  permissionMode,
  resumeSessionId,
  historySeed,
  injectedMcpServers,
  emitter,
  signal,
  spawnImpl,
  forceKillImpl,
  abortGraceMs = HERMES_ACP_ABORT_GRACE_MS,
  requestTimeoutMs = HERMES_ACP_REQUEST_TIMEOUT_MS,
  promptTimeoutMs = HERMES_ACP_PROMPT_TIMEOUT_MS,
  // Inject for tests: the one-shot fallback and the client handler factory.
  runFallback = runHermesTurn,
  clientHandlersFactory = createHermesAcpClientHandlers,
  fsModule,
}) {
  const cliPath = String(binPath || "").trim() || "hermes";
  const effectiveCwd = resolveGrokAcpCwd(cwd);
  const childEnv = { ...(env || process.env) };

  const state = {
    sessionId: resumeSessionId || null,
    reasoningOpen: false,
    streamedAssistantText: false,
    streamedAny: false,
    failed: false,
    turnCompleted: false,
    // Suppress session/load history replay until session/prompt starts.
    acceptUpdates: false,
    autoAllowPermissions: String(permissionMode || "confirm").toLowerCase() !== "observer",
    established: false,
    failedBeforeEstablish: false,
    promptRequestId: null,
    writeResponse: null,
    writeError: null,
    clientHandlers: null,
    agentCapabilities: null,
  };

  const runOneShotFallback = () => runFallback({
    prompt: String(prompt ?? ""),
    cwd: effectiveCwd,
    env: childEnv,
    binPath: cliPath,
    emitter,
    signal,
    model,
  });

  // If the spawn itself throws, fall back immediately (binary error).
  let child;
  try {
    const spec = prepareCommandForSpawn(cliPath, buildHermesAcpSpawnArgs());
    const spawnFn = spawnImpl || spawn;
    child = spawnFn(spec.command, spec.args, {
      cwd: effectiveCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: spec.shell,
      detached: process.platform !== "win32",
    });
  } catch {
    if (signal?.aborted) return { sessionId: state.sessionId, runtime: "acp" };
    return await runOneShotFallback();
  }

  let stderrText = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  let stderrEnded = false;
  const stderrDecoder = new StringDecoder("utf8");
  let settled = false;
  let forceKillTimer = null;
  let abortHandler = null;
  let fallbackNeeded = false;
  /** @type {ReturnType<typeof createJsonRpcClient>|null} */
  let rpc = null;

  const isBenignStdinError = (err) => err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED";

  const writeLine = (line) => {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writable === false) return;
    try {
      stdin.write(line, () => {});
    } catch {
      // Peer gone; close handling reports it.
    }
  };

  state.writeResponse = (id, result) => {
    writeLine(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  state.writeError = (id, error) => {
    writeLine(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
  };
  state.clientHandlers = clientHandlersFactory({
    cwd: effectiveCwd,
    fsModule,
    spawnImpl,
  });

  rpc = createJsonRpcClient({
    write: writeLine,
    onMessage: (message, pending) => {
      if (signal?.aborted) return;
      handleHermesAcpMessage(message, { emitter, state, pending });
    },
  });

  // Track the prompt request id so completion is detected synchronously.
  const originalRequest = rpc.request.bind(rpc);
  rpc.request = (method, params, options) => {
    const idBefore = rpc.getNextId();
    if (method === "session/prompt") state.promptRequestId = idBefore;
    return originalRequest(method, params, options);
  };

  const failTurn = (err) => {
    if (state.failed || signal?.aborted || state.turnCompleted) return;
    state.failed = true;
    emitter.emitError(formatHermesError(err?.message || String(err)));
  };

  const lineBuffer = createLineBuffer((line) => {
    if (signal?.aborted) return;
    try {
      rpc.handleLine(line);
    } catch (err) {
      failTurn(err);
    }
  }, MAX_HERMES_ACP_LINE_BYTES);

  child.stdout?.on("data", (chunk) => {
    if (signal?.aborted) return;
    try {
      lineBuffer.push(chunk);
    } catch (err) {
      failTurn(err);
      signalProcessTree(child, "SIGKILL", forceKillImpl);
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (signal?.aborted) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, MAX_HERMES_ACP_STDERR_CHARS - stderrBytes);
    const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
    if (accepted.length > 0) stderrText += stderrDecoder.write(accepted);
    stderrBytes += accepted.length;
    if (accepted.length < buffer.length) stderrTruncated = true;
  });
  if (typeof child.stdin?.on === "function") {
    child.stdin.on("error", (err) => {
      if (isBenignStdinError(err) || settled || state.failed || signal?.aborted || state.turnCompleted) {
        return;
      }
      failTurn(err);
    });
  }

  const closePromise = new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      if (!signal?.aborted) {
        try { lineBuffer.flush(); } catch { /* ignore */ }
      }
      resolve();
    };
    child.on("error", (err) => {
      if (!state.established && !state.streamedAny && !signal?.aborted) {
        // Binary missing / immediate spawn failure → fall back to one-shot.
        state.failedBeforeEstablish = true;
        fallbackNeeded = true;
      } else if (!state.failed && !signal?.aborted) {
        failTurn(err);
      }
      try { rpc?.rejectAll?.(err || new Error("Hermes ACP process error")); } catch { /* ignore */ }
      finish();
    });
    child.on("close", (code, exitSignal) => {
      if (!stderrEnded) {
        stderrEnded = true;
        if (!stderrTruncated || stderrDecoder.lastNeed === 0) stderrText += stderrDecoder.end();
      }
      if (shouldReportGrokProcessExitFailure(state, signal, code, exitSignal)) {
        if (!state.established) {
          state.failedBeforeEstablish = true;
          fallbackNeeded = true;
        } else {
          const stderr = stderrText.trim();
          const detail = code != null && code !== 0
            ? `exited with code ${code}`
            : (exitSignal ? `terminated by signal ${exitSignal}` : "exited before the turn completed");
          state.failed = true;
          emitter.emitError(formatHermesError(stderr || `Hermes ACP ${detail}`));
        }
      }
      try { rpc?.rejectAll?.(new Error("Hermes ACP process closed")); } catch { /* ignore */ }
      finish();
    });

    let terminationStarted = false;
    abortHandler = () => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (state.sessionId) {
        try { rpc.notify("session/cancel", { sessionId: state.sessionId }); } catch { /* ignore */ }
      }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalProcessTree(child, "SIGKILL", forceKillImpl);
        finish();
      }, Math.max(0, abortGraceMs));
      forceKillTimer.unref?.();
      signalProcessTree(child, "SIGTERM", forceKillImpl);
      try { child.stdin?.end(); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  try {
    const initResult = await rpc.request(
      "initialize",
      buildHermesAcpInitializeParams(),
      { timeoutMs: requestTimeoutMs },
    );
    // Credentials come from the user's own Hermes config; no authenticate call.
    state.agentCapabilities = parseGrokAcpAgentCapabilities(initResult);

    const established = await establishHermesAcpSession(rpc, {
      resumeSessionId,
      cwd: effectiveCwd,
      injectedMcpServers,
      agentCapabilities: state.agentCapabilities,
    });
    state.sessionId = established.sessionId;
    state.established = true;
    emitter.sessionId?.(established.sessionId);

    const effectivePrompt = resolveGrokTurnPrompt({
      turnPrompt: prompt,
      historySeed,
      resumeSessionId,
      establishMethod: established.method,
    });

    // Accept streamed updates only for this turn's prompt (not load replay).
    state.acceptUpdates = true;
    await rpc.request(
      "session/prompt",
      buildGrokAcpPromptParams(state.sessionId, effectivePrompt),
      { timeoutMs: promptTimeoutMs },
    );
  } catch (err) {
    if (signal?.aborted || state.failed) {
      // Already reported or user-cancelled.
    } else if (!state.established) {
      // Protocol error before a session existed → one-shot fallback.
      state.failedBeforeEstablish = true;
      fallbackNeeded = true;
    } else {
      state.failed = true;
      const message = err?.message || String(err);
      const stderr = stderrText.trim();
      emitter.emitError(formatHermesError(
        stderr && !message.includes(stderr) ? `${message} (${stderr})` : message,
      ));
    }
  } finally {
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (!settled && child.exitCode == null && !child.killed) {
      signalProcessTree(child, "SIGTERM", forceKillImpl);
    }
    await closePromise;
    if (signal) signal.removeEventListener("abort", abortHandler);
  }

  closeReasoning(state, emitter);

  if (signal?.aborted) {
    return { sessionId: state.sessionId, runtime: "acp" };
  }
  if (fallbackNeeded || state.failedBeforeEstablish) {
    if (signal?.aborted) return { sessionId: state.sessionId, runtime: "acp" };
    return await runOneShotFallback();
  }
  if (state.failed) {
    return { sessionId: state.sessionId, runtime: "acp" };
  }
  if (state.turnCompleted) {
    emitter.emitDone();
  } else {
    state.failed = true;
    emitter.emitError(formatHermesError("Hermes ACP ended before the turn completed"));
  }

  return { sessionId: state.sessionId, runtime: "acp" };
}

module.exports = {
  HERMES_ACP_ABORT_GRACE_MS,
  MAX_HERMES_ACP_LINE_BYTES,
  buildHermesAcpInitializeParams,
  buildHermesAcpSessionNewParams,
  buildHermesAcpSpawnArgs,
  createHermesAcpClientHandlers,
  emitHermesAcpUsage,
  establishHermesAcpSession,
  formatHermesError,
  handleHermesAcpMessage,
  hermesAcpContentText,
  hermesAcpToolArgs,
  hermesAcpToolName,
  hermesAcpToolResultText,
  runHermesAcpTurn,
  translateHermesAcpUpdate,
};
