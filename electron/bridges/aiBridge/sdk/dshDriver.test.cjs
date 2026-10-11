"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const DRIVER_PATH = require.resolve("./dshDriver.cjs");
const { createDshJsonParser, resolveDshPermissionMode } = require("./dshDriver.cjs");
const CHILD_PROCESS_IDS = new Set(["node:child_process", "child_process"]);

/**
 * Run `fn` with `node:child_process` replaced by a fake that records the spawn
 * call and returns a manually driven child, so the driver's stdout/stderr/exit
 * handling can be exercised without launching dsh.
 */
async function withFakeSpawn(fn) {
  const calls = [];
  const children = [];
  const originalLoad = Module._load;

  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
      return true;
    };
    calls.push({ command, args, options, child });
    children.push(child);
    return child;
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (CHILD_PROCESS_IDS.has(request)) {
      return { spawn: fakeSpawn, execFile: () => {}, execFileSync: () => "" };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[DRIVER_PATH];
  try {
    const driver = require(DRIVER_PATH);
    return await fn({ driver, calls });
  } finally {
    Module._load = originalLoad;
    delete require.cache[DRIVER_PATH];
  }
}

function makeEmitter() {
  const text = [];
  const done = [];
  return {
    text,
    done,
    emitter: {
      text(chunk) {
        if (chunk) text.push(chunk);
      },
      emitDone() {
        done.push(true);
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("runs dsh headless in the session cwd and streams stdout as text", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter, text, done } = makeEmitter();
    const turn = driver.runDshTurn({
      prompt: "say pong",
      cwd: "/work/project",
      env: { DEEPSEEK_API_KEY: "secret" },
      binPath: "/usr/bin/dsh",
      emitter,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["headless", "--json", "say pong"]);
    assert.equal(calls[0].options.cwd, "/work/project");
    assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, "secret");

    const child = calls[0].child;
    child.stdout.emit("data", "pong\n");
    child.emit("close", 0, null);
    await turn;
    assert.deepEqual(done, [true], "driver must signal the done IPC");

    assert.deepEqual(text, ["pong\n"]);
  });
});

test("drops the leading dsh reasoning label from the stream", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter, text } = makeEmitter();
    const turn = driver.runDshTurn({ prompt: "hi", emitter, binPath: "dsh" });

    const child = calls[0].child;
    // The label can arrive split across chunks.
    child.stdout.emit("data", "dsh: reas");
    child.stdout.emit("data", "oning:\nthinking hard\n");
    child.stdout.emit("data", "final answer\n");
    child.emit("close", 0, null);
    await turn;

    assert.deepEqual(text, ["thinking hard\n", "final answer\n"]);
  });
});

test("rejects with the stderr detail when dsh exits non-zero", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runDshTurn({ prompt: "boom", emitter, binPath: "dsh" });

    const child = calls[0].child;
    child.stderr.emit("data", "host preparation failed\n");
    child.emit("close", 1, null);

    await assert.rejects(turn, /host preparation failed/);
  });
});

test("resolves and kills the child when the turn is aborted", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const controller = new AbortController();
    const turn = driver.runDshTurn({
      prompt: "long task",
      emitter,
      binPath: "dsh",
      signal: controller.signal,
    });

    const child = calls[0].child;
    controller.abort();
    await flush();
    assert.deepEqual(child.kills, ["SIGTERM"]);

    // A killed process reports a non-zero code; an abort must not surface as an
    // error the renderer has to display.
    child.emit("close", null, "SIGTERM");
    await turn;
  });
});

test("merges $DSH_HOME/env under the launching environment", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-dsh-env-"));
  fs.writeFileSync(
    path.join(dir, "env"),
    [
      "# dsh launch environment",
      "DEEPSEEK_API_KEY='from-file'",
      "export DSH_KEEP=keep-me",
      "DSH_PERMISSION_MODE=workspace-write",
      "MALFORMED LINE",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const { readDshEnvFile, buildDshEnv } = require("./dshDriver.cjs");
    const baseEnv = { DSH_HOME: dir, DEEPSEEK_API_KEY: "from-app", PATH: "/usr/bin" };

    assert.deepEqual(readDshEnvFile(baseEnv), {
      DEEPSEEK_API_KEY: "from-file",
      DSH_KEEP: "keep-me",
      DSH_PERMISSION_MODE: "workspace-write",
    });
    // The launching environment (an explicitly configured per-agent env) wins.
    assert.deepEqual(buildDshEnv(baseEnv), {
      DSH_PERMISSION_MODE: "workspace-write",
      DSH_KEEP: "keep-me",
      DEEPSEEK_API_KEY: "from-app",
      DSH_HOME: dir,
      PATH: "/usr/bin",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawns with the merged env so an app-launched turn is keyed like the CLI", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runDshTurn({
      prompt: "hi",
      env: { PATH: "/usr/bin" },
      emitter,
      binPath: "dsh",
    });
    const child = calls[0].child;
    child.emit("close", 0, null);
    await turn;

    // Whatever ~/.dsh/env holds on this machine is merged in; PATH from the
    // launching environment must survive.
    assert.equal(calls[0].options.env.PATH, "/usr/bin");
  });
});

test("parses the default model out of `dsh --dump-config`", () => {
  const { parseDshDefaultModel, resolveDshProfile } = require("./dshDriver.cjs");
  const dump = [
    "# == @deepseek-ai/dsh-headless",
    "- id: agent",
    "  name: '@deepseek-ai/dsh-agent'",
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    "    provider: deepseek-official",
    "    model: deepseek-flash",
    "# == @deepseek-ai/dsh-base",
    "- id: jobs",
    "  name: '@deepseek-ai/dsh-jobs-local'",
    "  config:",
    "    model: not-this-one",
    "",
  ].join("\n");

  assert.deepEqual(parseDshDefaultModel(dump), {
    provider: "deepseek-official",
    model: "deepseek-flash",
  });
  // A config rendered from code (`!!js`) is not a literal model id.
  assert.deepEqual(
    parseDshDefaultModel("- id: agent-default-model\n  config:\n    model: !!js ctx.model\n"),
    { provider: null, model: null },
  );
  assert.deepEqual(parseDshDefaultModel(""), { provider: null, model: null });
  assert.equal(resolveDshProfile({}), "headless");
  assert.equal(resolveDshProfile({ DSH_PROFILE: "web" }), "web");
});

test("reports the profile's configured model as the dsh catalog", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const promise = driver.listDshModels({ binPath: "/usr/bin/dsh", env: {} });
    assert.deepEqual(calls[0].args, ["--profile", "headless", "--dump-config"]);
    calls[0].child.stdout.emit(
      "data",
      "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-chat\n",
    );
    calls[0].child.emit("close", 0, null);
    assert.deepEqual(await promise, {
      currentModelId: "deepseek-chat",
      models: [{ id: "deepseek-chat", name: "deepseek-chat" }],
    });
  });
});

test("applies a chosen model as a one-turn profile patch that keeps the provider", async () => {
  const fs = require("node:fs");
  await withFakeSpawn(async ({ driver, calls }) => {
    // prepareDshModelPatch reads the current config first (same fake spawn).
    const preparing = driver.prepareDshModelPatch({
      model: "deepseek-chat",
      binPath: "/usr/bin/dsh",
      env: {},
    });
    calls[0].child.stdout.emit(
      "data",
      "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n",
    );
    calls[0].child.emit("close", 0, null);
    const patch = await preparing;

    assert.equal(patch.profile, "headless");
    assert.equal(
      fs.readFileSync(patch.patchPath, "utf8"),
      "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-chat\n",
    );

    // The turn then boots the explicit profile with the overlay, and cleans the
    // transient patch file up once the process exits.
    const { emitter } = makeEmitter();
    const turn = driver.runDshTurn({
      prompt: "say pong",
      emitter,
      binPath: "/usr/bin/dsh",
      patchPath: patch.patchPath,
      profile: patch.profile,
    });
    const turnCall = calls[calls.length - 1];
    assert.deepEqual(turnCall.args, [
      "--profile", "headless", "--patch", patch.patchPath, "--json", "say pong",
    ]);
    turnCall.child.emit("close", 0, null);
    await turn;
    assert.equal(fs.existsSync(patch.patchPath), false);
  });
});

test("keeps the headless shorthand when no model was chosen", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runDshTurn({ prompt: "hi", emitter, binPath: "dsh" });
    assert.deepEqual(calls[0].args, ["headless", "--json", "hi"]);
    calls[0].child.emit("close", 0, null);
    await turn;
  });
});

test("parses dsh --json run events into tool calls, reasoning, usage and text", () => {
  const events = [];
  const emitter = {
    text: (t) => events.push(["text", t]),
    reasoning: (t) => events.push(["reasoning", t]),
    reasoningEnd: () => events.push(["reasoningEnd"]),
    toolCall: (name, args, id) => events.push(["toolCall", name, args, id]),
    toolResult: (id, out, name) => events.push(["toolResult", id, out, name]),
    usage: (u) => events.push(["usage", u]),
    sessionId: (id) => events.push(["sessionId", id]),
    warning: (id, message) => events.push(["warning", message]),
  };
  const parser = createDshJsonParser(emitter);
  const stream = [
    '{"type":"session","sessionId":"s1","cwd":"/tmp"}',
    '{"type":"thinking","text":"先看看目录"}',
    '{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"pwd"}}',
    '{"type":"tool_result","callId":"c1","status":"completed","result":"/tmp\\n"}',
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":1,"totalTokens":12}}',
    '{"type":"text","text":"答案是 /tmp"}',
    '{"type":"final","text":"答案是 /tmp"}',
  ].join("\n") + "\n";
  parser.push(stream);
  parser.flush();

  assert.equal(parser.jsonMode, true);
  assert.deepEqual(events, [
    ["sessionId", "s1"],
    ["reasoning", "先看看目录"],
    ["reasoningEnd"],
    ["toolCall", "bash", { command: "pwd" }, "c1"],
    ["toolResult", "c1", "/tmp\n", "bash"],
    ["usage", { inputTokens: 10, cachedInputTokens: 1, outputTokens: 2, totalTokens: 12 }],
    ["text", "答案是 /tmp"],
  ]);
});

test("thinking events stream as deltas, not as repeated cumulative text", () => {
  const events = [];
  const parser = createDshJsonParser({ reasoning: (t) => events.push(t), reasoningEnd: () => {} });
  parser.push('{"type":"thinking","text":"先"}\n{"type":"thinking","text":"先看目录"}\n');
  assert.deepEqual(events, ["先", "看目录"]);
});

test("a non-JSON line puts the parser into plain-text mode", () => {
  const parser = createDshJsonParser({ text: () => {} });
  parser.push("hello world\n");
  assert.equal(parser.jsonMode, false);
});

test("plain-text fallback keeps the newline between lines", () => {
  const deltas = [];
  const parser = createDshJsonParser({ text: (t) => deltas.push(t) });
  parser.push("line one\nline two\nline three\n");
  assert.deepEqual(deltas, ["line one", "\nline two", "\nline three"]);

  // The payload that actually triggers this: stdout whose first line starts with
  // "{" (so the parser picks json mode) but is not a dsh event stream, so every
  // line lands in the fallback. The answer must survive verbatim.
  const jsonish = [];
  const answer = '{\n  "foo": 1,\n  "bar": 2\n}';
  const jsonParser = createDshJsonParser({ text: (t) => jsonish.push(t) });
  for (const line of answer.split("\n")) jsonParser.push(`${line}\n`);
  assert.equal(jsonish.join(""), answer);
});

test("maps Netcatty permission modes onto dsh's own sandbox policy", () => {
  assert.equal(resolveDshPermissionMode("observer"), "read-only");
  assert.equal(resolveDshPermissionMode("confirm"), "workspace-write");
  assert.equal(resolveDshPermissionMode("auto"), "danger-full-access");
  // Unknown/absent falls back to dsh's own default rather than to full access.
  assert.equal(resolveDshPermissionMode(undefined), "workspace-write");
  assert.equal(resolveDshPermissionMode("nonsense"), "workspace-write");
  assert.equal(resolveDshPermissionMode("  OBSERVER "), "read-only");
});

test("the spawned dsh process receives DSH_PERMISSION_MODE", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runDshTurn({
      prompt: "hi",
      env: {},
      binPath: "/usr/bin/dsh",
      emitter,
      permissionMode: "observer",
    });
    assert.equal(calls[0].options.env.DSH_PERMISSION_MODE, "read-only");
    calls[0].child.emit("close", 0, null);
    await turn;
  });
});
