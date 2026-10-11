"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildHermesAcpInitializeParams,
  buildHermesAcpSessionNewParams,
  buildHermesAcpSpawnArgs,
  createHermesAcpClientHandlers,
  emitHermesAcpUsage,
  handleHermesAcpMessage,
  hermesAcpContentText,
  releaseTerminals,
  translateHermesAcpUpdate,
} = require("./hermesAcpDriver.cjs");
const { getDriver, listBackends } = require("./index.cjs");

const DRIVER_PATH = require.resolve("./hermesAcpDriver.cjs");
const HERMES_DRIVER_PATH = require.resolve("./hermesDriver.cjs");
const CHILD_PROCESS_IDS = new Set(["node:child_process", "child_process"]);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    reasoning: (value) => calls.push(["reasoning", value]),
    reasoningEnd: () => calls.push(["reasoningEnd"]),
    toolCall: (name, args, id) => calls.push(["toolCall", name, args, id]),
    toolResult: (id, result, name) => calls.push(["toolResult", id, result, name]),
    sessionId: (id) => calls.push(["sessionId", id]),
    usage: (usage) => calls.push(["usage", usage]),
    warning: (itemId, message) => calls.push(["warning", itemId, message]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

/** A manually driven child process stand-in (no real spawn). */
function makeFakeChild({ onRequest } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  const stdin = new EventEmitter();
  stdin.destroyed = false;
  stdin.writable = true;
  stdin.writes = [];
  stdin.write = (line, cb) => {
    stdin.writes.push(String(line));
    let message = null;
    try { message = JSON.parse(String(line).trim()); } catch { message = null; }
    if (message && typeof onRequest === "function") {
      queueMicrotask(() => onRequest(message, { child, stdin }));
    }
    if (typeof cb === "function") queueMicrotask(() => cb());
    return true;
  };
  stdin.end = () => {};
  child.stdin = stdin;
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.killed = true;
    queueMicrotask(() => child.emit("close", 0, null));
    return true;
  };
  return child;
}

function emitLine(child, payload) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
}

/** Fake child that answers initialize / session/new / session/prompt. */
function makeAcpChild({ sessionId = "acp-sess-1", onPrompt, promptError } = {}) {
  return makeFakeChild({
    onRequest: (message, { child }) => {
      if (message.method === "initialize") {
        emitLine(child, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "hermes-agent", version: "0.21.6" },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { resume: {}, fork: {}, list: {} },
            },
            authMethods: [{ id: "deepseek", name: "deepseek runtime credentials" }],
          },
        });
        return;
      }
      if (message.method === "session/new") {
        emitLine(child, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId,
            models: {
              currentModelId: "deepseek:deepseek-flash",
              availableModels: [
                { modelId: "deepseek:deepseek-flash", name: "DeepSeek · deepseek-flash" },
              ],
            },
            modes: { currentModeId: "default", availableModes: [] },
          },
        });
        return;
      }
      if (message.method === "session/prompt") {
        if (typeof onPrompt === "function") onPrompt(child, message);
        if (promptError) {
          emitLine(child, { jsonrpc: "2.0", id: message.id, error: promptError });
          return;
        }
        emitLine(child, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
            usage: {
              cachedReadTokens: 48512,
              inputTokens: 48854,
              outputTokens: 57,
              thoughtTokens: 0,
              totalTokens: 48911,
            },
          },
        });
        return;
      }
      emitLine(child, { jsonrpc: "2.0", id: message.id, result: {} });
    },
  });
}

/**
 * Run `fn` with `node:child_process` replaced by a fake `spawn` driven by
 * `responder({ command, args, options, index })`. The ACP driver and the
 * hermesDriver fallback (which captures its own `spawn`) are both re-required
 * so both see the fake.
 */
async function withFakeSpawn(responder, fn) {
  const calls = [];
  const originalLoad = Module._load;
  const fakeSpawn = (command, args, options) => {
    const child = responder({ command, args, options, index: calls.length });
    calls.push({ command, args, options, child });
    return child;
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (CHILD_PROCESS_IDS.has(request)) {
      return { spawn: fakeSpawn, execFile: () => {}, execFileSync: () => "" };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[DRIVER_PATH];
  delete require.cache[HERMES_DRIVER_PATH];
  try {
    const driver = require(DRIVER_PATH);
    return await fn({ driver, calls });
  } finally {
    Module._load = originalLoad;
    delete require.cache[DRIVER_PATH];
    delete require.cache[HERMES_DRIVER_PATH];
  }
}

const forceKill = (child, signal) => { child.kill(signal); };

test("buildHermesAcpInitializeParams advertises fs + terminal client capabilities", () => {
  const init = buildHermesAcpInitializeParams();
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(init.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
  assert.equal(init.clientCapabilities.terminal, true);
  assert.equal(init.clientInfo.name, "netcatty");
});

test("buildHermesAcpSpawnArgs runs the acp subcommand", () => {
  assert.deepEqual(buildHermesAcpSpawnArgs(), ["acp"]);
});

test("buildHermesAcpSessionNewParams keeps absolute cwd and MCP stdio entries", () => {
  const params = buildHermesAcpSessionNewParams({
    cwd: "relative-dir",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "node",
      args: ["mcp.cjs"],
      env: { A: "1" },
    }],
  });
  assert.ok(path.isAbsolute(params.cwd));
  assert.equal(params.mcpServers[0].name, "netcatty-remote-hosts");
  assert.equal(params.mcpServers[0].type, "stdio");
  assert.deepEqual(params.mcpServers[0].env, [{ name: "A", value: "1" }]);
});

test("hermesAcpContentText flattens ACP content blocks", () => {
  assert.equal(hermesAcpContentText("plain"), "plain");
  assert.equal(hermesAcpContentText({ text: "block" }), "block");
  assert.equal(
    hermesAcpContentText([
      { type: "content", content: { type: "text", text: "line1" } },
      { type: "content", content: { type: "text", text: "line2" } },
    ]),
    "line1\nline2",
  );
  assert.equal(hermesAcpContentText(null), "");
});

test("translateHermesAcpUpdate maps real Hermes update shapes to emitter events", () => {
  const emitter = makeEmitter();
  const state = {};
  translateHermesAcpUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { text: "plan", type: "text" },
  }, emitter, state);
  translateHermesAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { text: "Hi", type: "text" },
  }, emitter, state);
  translateHermesAcpUpdate({
    sessionUpdate: "tool_call",
    kind: "execute",
    locations: [],
    title: "terminal: echo HELLO_ACP_PROBE",
    toolCallId: "tc-1",
    content: [{ content: { text: "$ echo HELLO_ACP_PROBE", type: "text" }, type: "content" }],
  }, emitter, state);
  translateHermesAcpUpdate({
    sessionUpdate: "tool_call_update",
    kind: "execute",
    status: "completed",
    toolCallId: "tc-1",
    content: [{
      content: { text: "terminal result\n- **output:** HELLO_ACP_PROBE\n- **exit_code:** 0", type: "text" },
      type: "content",
    }],
  }, emitter, state);
  translateHermesAcpUpdate({
    sessionUpdate: "usage_update",
    size: 1000000,
    used: 24724,
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["reasoning", "plan"],
    ["reasoningEnd"],
    ["text", "Hi"],
    ["toolCall", "terminal: echo HELLO_ACP_PROBE", {
      kind: "execute",
      title: "terminal: echo HELLO_ACP_PROBE",
      content: "$ echo HELLO_ACP_PROBE",
    }, "tc-1"],
    ["toolResult", "tc-1", "terminal result\n- **output:** HELLO_ACP_PROBE\n- **exit_code:** 0", "terminal: echo HELLO_ACP_PROBE"],
    ["usage", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 24724 }],
  ]);
});

test("translateHermesAcpUpdate defers generic kinds (text/thought) to the shared translator", () => {
  const emitter = makeEmitter();
  translateHermesAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { text: "chunk", type: "text" },
  }, emitter, {});
  assert.deepEqual(emitter.calls, [["text", "chunk"]]);
});

test("emitHermesAcpUsage maps prompt-result usage incl. thoughtTokens and usage_update", () => {
  const emitter = makeEmitter();
  emitHermesAcpUsage(emitter, {
    cachedReadTokens: 48512,
    inputTokens: 48854,
    outputTokens: 57,
    thoughtTokens: 12,
    totalTokens: 48911,
  });
  emitHermesAcpUsage(emitter, { size: 1000000, used: 24724 });
  assert.deepEqual(emitter.calls, [
    ["usage", {
      inputTokens: 48854,
      cachedInputTokens: 48512,
      outputTokens: 57,
      reasoningTokens: 12,
      totalTokens: 48911,
    }],
    ["usage", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 24724 }],
  ]);
});

test("handleHermesAcpMessage routes session/update notifications and session ids", () => {
  const emitter = makeEmitter();
  const state = { acceptUpdates: true };
  handleHermesAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "ok", type: "text" } },
    },
  }, { emitter, state, pending: new Map() });
  assert.equal(state.sessionId, "s1");
  assert.deepEqual(emitter.calls, [["text", "ok"], ["sessionId", "s1"]]);
});

test("handleHermesAcpMessage suppresses history replay until prompt accepts updates", () => {
  const emitter = makeEmitter();
  const state = { acceptUpdates: false };
  handleHermesAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "previous reply", type: "text" } },
    },
  }, { emitter, state, pending: new Map() });
  assert.deepEqual(emitter.calls, []);
  state.acceptUpdates = true;
  handleHermesAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { text: "this turn", type: "text" } },
    },
  }, { emitter, state, pending: new Map() });
  assert.deepEqual(emitter.calls, [["text", "this turn"]]);
});

test("handleHermesAcpMessage answers session/request_permission with an offered optionId", () => {
  const written = [];
  const state = {
    autoAllowPermissions: true,
    writeResponse: (id, result) => written.push([id, result]),
  };
  handleHermesAcpMessage({
    jsonrpc: "2.0",
    id: 42,
    method: "session/request_permission",
    params: {
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    },
  }, { emitter: makeEmitter(), state, pending: new Map() });
  assert.equal(written.length, 1);
  assert.equal(written[0][0], 42);
  assert.equal(written[0][1].outcome.optionId, "allow-once");
});

test("handleHermesAcpMessage dispatches fs/read_text_file client requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-acp-fs-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hello-from-disk", "utf8");
  const written = [];
  const state = {
    autoAllowPermissions: true,
    clientHandlers: createHermesAcpClientHandlers({ cwd: dir }),
    writeResponse: (id, result) => written.push([id, result]),
    writeError: (id, error) => written.push([id, error]),
  };
  try {
    handleHermesAcpMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "fs/read_text_file",
      params: { path: "a.txt" },
    }, { emitter: makeEmitter(), state, pending: new Map() });
    await flush();
    assert.deepEqual(written, [[7, { content: "hello-from-disk" }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client handlers read/write files and drive a terminal lifecycle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-acp-term-"));
  const terminalChild = makeFakeChild();
  const handlers = createHermesAcpClientHandlers({
    cwd: dir,
    spawnImpl: () => terminalChild,
  });
  try {
    handlers["fs/write_text_file"]({ path: "nested/out.txt", content: "written" });
    assert.equal(fs.readFileSync(path.join(dir, "nested/out.txt"), "utf8"), "written");
    assert.deepEqual(handlers["fs/read_text_file"]({ path: "nested/out.txt" }), { content: "written" });

    const created = handlers["terminal/create"]({ command: "echo", args: ["hi"] });
    assert.match(created.terminalId, /^hermes-term-/);
    terminalChild.stdout.emit("data", "hi\n");
    const waiting = handlers["terminal/wait_for_exit"]({ terminalId: created.terminalId });
    terminalChild.emit("close", 0, null);
    assert.deepEqual(await waiting, { exitCode: 0, signal: null });
    const output = handlers["terminal/output"]({ terminalId: created.terminalId });
    assert.match(output.output, /hi/);
    assert.equal(output.exitStatus.exitCode, 0);
    handlers["terminal/release"]({ terminalId: created.terminalId });
    assert.equal(handlers.terminals.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fs/read_text_file honours line and limit independently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-acp-lines-"));
  fs.writeFileSync(
    path.join(dir, "lines.txt"),
    ["one", "two", "three", "four", "five"].join("\n"),
    "utf8",
  );
  const handlers = createHermesAcpClientHandlers({ cwd: dir });
  try {
    const read = (params) => handlers["fs/read_text_file"]({ path: "lines.txt", ...params }).content;
    assert.equal(read({}), "one\ntwo\nthree\nfour\nfive");
    // `limit` without `line` means "the first N lines", not the whole file.
    assert.equal(read({ limit: 2 }), "one\ntwo");
    assert.equal(read({ line: 3 }), "three\nfour\nfive");
    assert.equal(read({ line: 2, limit: 2 }), "two\nthree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseTerminals SIGTERMs the open children and empties the map", () => {
  const running = makeFakeChild();
  const finished = makeFakeChild();
  const terminals = new Map([
    ["t-running", { child: running, done: false }],
    ["t-done", { child: finished, done: true }],
  ]);

  releaseTerminals(terminals, { forceKillImpl: forceKill, graceMs: 60_000 });

  assert.deepEqual(running.kills, ["SIGTERM"]);
  assert.deepEqual(finished.kills, [], "a finished terminal is left alone");
  assert.equal(terminals.size, 0);
});

test("a finished turn releases the terminals the agent opened", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-acp-release-"));
  let terminalChild = null;
  try {
    await withFakeSpawn(
      ({ args }) => {
        if (args.includes("acp")) {
          return makeAcpChild({
            onPrompt: (child) => {
              // The agent asks the client to run something long-lived and never
              // releases it — the turn end has to clean it up.
              emitLine(child, {
                jsonrpc: "2.0",
                id: 77,
                method: "terminal/create",
                params: { command: "sleep", args: ["600"], cwd: dir },
              });
              emitLine(child, {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "acp-sess-1",
                  update: { sessionUpdate: "agent_message_chunk", content: { text: "started", type: "text" } },
                },
              });
            },
          });
        }
        terminalChild = makeFakeChild();
        return terminalChild;
      },
      async ({ driver, calls }) => {
        const emitter = makeEmitter();
        const result = await driver.runHermesAcpTurn({
          prompt: "start the dev server",
          binPath: "/usr/bin/hermes",
          env: { PATH: "/usr/bin" },
          emitter,
          forceKillImpl: forceKill,
        });

        assert.equal(result.runtime, "acp");
        assert.equal(calls.length, 2, "the agent process and the terminal child were spawned");
        assert.ok(terminalChild, "terminal/create spawned a child");
        assert.ok(
          terminalChild.kills.includes("SIGTERM"),
          "the terminal child is signalled when the turn ends",
        );
        assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "started"));
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesAcpTurn streams reasoning, tools, usage and ends with done", async () => {
  await withFakeSpawn(
    ({ args }) => {
      if (args.includes("acp")) {
        return makeAcpChild({
          onPrompt: (child) => {
            emitLine(child, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "acp-sess-1",
                update: { sessionUpdate: "agent_thought_chunk", content: { text: "think", type: "text" } },
              },
            });
            emitLine(child, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "acp-sess-1",
                update: {
                  sessionUpdate: "tool_call",
                  kind: "execute",
                  title: "terminal: echo HELLO_ACP_PROBE",
                  toolCallId: "tc-1",
                  content: [{ content: { text: "$ echo HELLO_ACP_PROBE", type: "text" }, type: "content" }],
                },
              },
            });
            emitLine(child, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "acp-sess-1",
                update: {
                  sessionUpdate: "tool_call_update",
                  kind: "execute",
                  status: "completed",
                  toolCallId: "tc-1",
                  content: [{ content: { text: "HELLO_ACP_PROBE", type: "text" }, type: "content" }],
                },
              },
            });
            emitLine(child, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "acp-sess-1",
                update: { sessionUpdate: "agent_message_chunk", content: { text: "done", type: "text" } },
              },
            });
            emitLine(child, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "acp-sess-1",
                update: { sessionUpdate: "usage_update", size: 1000000, used: 24724 },
              },
            });
          },
        });
      }
      return makeFakeChild();
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      const result = await driver.runHermesAcpTurn({
        prompt: "Run echo HELLO_ACP_PROBE",
        binPath: "/usr/bin/hermes",
        env: { PATH: "/usr/bin" },
        emitter,
        forceKillImpl: forceKill,
      });

      assert.equal(calls.length, 1, "no fallback when ACP succeeds");
      assert.deepEqual(calls[0].args, ["acp"]);
      assert.equal(result.runtime, "acp");
      assert.equal(result.sessionId, "acp-sess-1");
      assert.ok(emitter.calls.some((c) => c[0] === "reasoning" && c[1] === "think"));
      assert.ok(emitter.calls.some((c) => c[0] === "reasoningEnd"));
      assert.ok(emitter.calls.some((c) => c[0] === "toolCall" && c[1] === "terminal: echo HELLO_ACP_PROBE"));
      assert.ok(emitter.calls.some(
        (c) => c[0] === "toolResult" && c[1] === "tc-1" && c[2] === "HELLO_ACP_PROBE",
      ));
      assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "done"));
      assert.ok(emitter.calls.some((c) => c[0] === "sessionId" && c[1] === "acp-sess-1"));
      const usage = emitter.calls.filter((c) => c[0] === "usage");
      assert.equal(usage.length, 2, "usage_update then prompt-result usage");
      assert.deepEqual(usage[1][1], {
        inputTokens: 48854,
        cachedInputTokens: 48512,
        outputTokens: 57,
        reasoningTokens: 0,
        totalTokens: 48911,
      });
      assert.ok(emitter.calls.some((c) => c[0] === "done"), "successful turn must emitDone");
      assert.ok(!emitter.calls.some((c) => c[0] === "error"));
    },
  );
});

test("runHermesAcpTurn falls back to the one-shot CLI when the ACP spawn fails", async () => {
  await withFakeSpawn(
    ({ args }) => {
      if (args.includes("acp")) {
        const child = makeFakeChild();
        const err = new Error("spawn hermes ENOENT");
        err.code = "ENOENT";
        queueMicrotask(() => child.emit("error", err));
        return child;
      }
      // One-shot `hermes -z` fallback.
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "pong\n");
        queueMicrotask(() => child.emit("close", 0, null));
      });
      return child;
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      await driver.runHermesAcpTurn({
        prompt: "say pong",
        binPath: "/usr/bin/hermes",
        emitter,
        forceKillImpl: forceKill,
      });

      assert.deepEqual(calls.map((c) => c.args), [["acp"], ["-z", "say pong"]]);
      assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "pong\n"));
      assert.ok(emitter.calls.some((c) => c[0] === "done"), "fallback must finish the turn");
    },
  );
});

test("runHermesAcpTurn falls back when the process closes before session/new", async () => {
  await withFakeSpawn(
    ({ args }) => {
      if (args.includes("acp")) {
        const child = makeFakeChild();
        // initialize never answered; process dies.
        queueMicrotask(() => child.emit("close", 1, null));
        return child;
      }
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", "fallback answer\n");
        queueMicrotask(() => child.emit("close", 0, null));
      });
      return child;
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      await driver.runHermesAcpTurn({
        prompt: "hi",
        binPath: "/usr/bin/hermes",
        emitter,
        forceKillImpl: forceKill,
      });
      assert.deepEqual(calls.map((c) => c.args), [["acp"], ["-z", "hi"]]);
      assert.ok(emitter.calls.some((c) => c[0] === "text" && c[1] === "fallback answer\n"));
      assert.ok(emitter.calls.some((c) => c[0] === "done"));
    },
  );
});

test("runHermesAcpTurn reports a prompt error without falling back (session existed)", async () => {
  await withFakeSpawn(
    ({ args }) => {
      if (args.includes("acp")) {
        return makeAcpChild({ promptError: { code: -32000, message: "model overloaded" } });
      }
      return makeFakeChild();
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      const result = await driver.runHermesAcpTurn({
        prompt: "hi",
        binPath: "/usr/bin/hermes",
        emitter,
        forceKillImpl: forceKill,
      });
      assert.equal(calls.length, 1, "established session must not fall back");
      const err = emitter.calls.find((c) => c[0] === "error");
      assert.ok(err, "prompt JSON-RPC error must emitError");
      assert.match(String(err[1]), /overloaded/);
      assert.ok(!emitter.calls.some((c) => c[0] === "done"));
      assert.equal(result.sessionId, "acp-sess-1");
    },
  );
});

test("runHermesAcpTurn resolves on abort without surfacing an error", async () => {
  await withFakeSpawn(
    ({ args }) => {
      if (args.includes("acp")) return makeFakeChild({ onRequest: () => {} });
      return makeFakeChild();
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      const controller = new AbortController();
      const turn = driver.runHermesAcpTurn({
        prompt: "long task",
        binPath: "/usr/bin/hermes",
        emitter,
        signal: controller.signal,
        abortGraceMs: 1,
        forceKillImpl: forceKill,
      });
      controller.abort();
      await flush();
      await turn;
      assert.equal(calls.length, 1, "abort must not trigger fallback");
      assert.ok(!emitter.calls.some((c) => c[0] === "error"));
      assert.ok(!emitter.calls.some((c) => c[0] === "done"));
    },
  );
});

test("runHermesAcpTurn resumes a prior session via session/resume", async () => {
  const methods = [];
  await withFakeSpawn(
    ({ args }) => {
      if (!args.includes("acp")) return makeFakeChild();
      return makeFakeChild({
        onRequest: (message, { child }) => {
          methods.push(message.method);
          if (message.method === "initialize") {
            emitLine(child, {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            return;
          }
          if (message.method === "session/resume") {
            assert.equal(message.params.sessionId, "prior-1");
            emitLine(child, { jsonrpc: "2.0", id: message.id, result: { sessionId: "prior-1" } });
            return;
          }
          if (message.method === "session/prompt") {
            emitLine(child, {
              jsonrpc: "2.0",
              id: message.id,
              result: { stopReason: "end_turn" },
            });
            return;
          }
          emitLine(child, { jsonrpc: "2.0", id: message.id, result: {} });
        },
      });
    },
    async ({ driver, calls }) => {
      const emitter = makeEmitter();
      const result = await driver.runHermesAcpTurn({
        prompt: "follow up",
        binPath: "/usr/bin/hermes",
        resumeSessionId: "prior-1",
        emitter,
        forceKillImpl: forceKill,
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(methods.filter((m) => m && m.startsWith("session/")), [
        "session/resume",
        "session/prompt",
      ]);
      assert.equal(result.sessionId, "prior-1");
      assert.ok(emitter.calls.some((c) => c[0] === "sessionId" && c[1] === "prior-1"));
      assert.ok(emitter.calls.some((c) => c[0] === "done"));
    },
  );
});

test("registry hermes backend exposes runTurn and keeps hermes model discovery", async () => {
  assert.ok(listBackends().includes("hermes"));
  const driver = getDriver("hermes");
  assert.equal(typeof driver.runTurn, "function");
  assert.equal(typeof driver.listModels, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-acp-home-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    ["model:", "  default: deepseek-flash", "  provider: deepseek", ""].join("\n"),
    "utf8",
  );
  try {
    assert.deepEqual(await driver.listModels({ env: { HERMES_HOME: dir } }), {
      currentModelId: "deepseek-flash",
      models: [{ id: "deepseek-flash", name: "deepseek-flash" }],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
