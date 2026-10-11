"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const DRIVER_PATH = require.resolve("./hermesDriver.cjs");
const CHILD_PROCESS_IDS = new Set(["node:child_process", "child_process"]);

/**
 * Run `fn` with `node:child_process` replaced by a fake that records the spawn
 * call and returns a manually driven child, so the driver's stdout/stderr/exit
 * handling can be exercised without launching hermes.
 */
async function withFakeSpawn(fn) {
  const calls = [];
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

test("runs hermes oneshot in the session cwd and streams stdout as text", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter, text, done } = makeEmitter();
    const turn = driver.runHermesTurn({
      prompt: "say pong",
      cwd: "/work/project",
      env: { PATH: "/usr/bin" },
      binPath: "/usr/local/bin/hermes",
      emitter,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/local/bin/hermes");
    assert.deepEqual(calls[0].args, ["-z", "say pong"]);
    assert.equal(calls[0].options.cwd, "/work/project");
    assert.equal(calls[0].options.env.PATH, "/usr/bin");

    const child = calls[0].child;
    child.stdout.emit("data", "po");
    child.stdout.emit("data", "ng\n");
    child.emit("close", 0, null);
    await turn;
    assert.deepEqual(done, [true], "driver must signal the done IPC");

    assert.deepEqual(text, ["po", "ng\n"]);
  });
});

test("passes the launching environment through unchanged (no env file merge)", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const env = { PATH: "/usr/bin", HERMES_HOME: "/custom/hermes" };
    const turn = driver.runHermesTurn({ prompt: "hi", env, emitter, binPath: "hermes" });
    const child = calls[0].child;
    child.emit("close", 0, null);
    await turn;

    assert.deepEqual(calls[0].options.env, env);
  });
});

test("rejects with the stderr detail when hermes exits non-zero", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runHermesTurn({ prompt: "boom", emitter, binPath: "hermes" });

    const child = calls[0].child;
    child.stderr.emit("data", "no provider configured\n");
    child.emit("close", 2, null);

    await assert.rejects(turn, /no provider configured/);
  });
});

test("falls back to the exit code when stderr is empty", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runHermesTurn({ prompt: "boom", emitter, binPath: "hermes" });
    calls[0].child.emit("close", 3, null);

    await assert.rejects(turn, /hermes exited with code 3/);
  });
});

test("kills the child on abort without surfacing an error", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const controller = new AbortController();
    const turn = driver.runHermesTurn({
      prompt: "long task",
      emitter,
      binPath: "hermes",
      signal: controller.signal,
    });

    const child = calls[0].child;
    controller.abort();
    await flush();
    assert.deepEqual(child.kills, ["SIGTERM"]);

    child.emit("close", null, "SIGTERM");
    await turn;
  });
});

test("passes the chosen model as -m before the one-shot prompt", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runHermesTurn({
      prompt: "say pong",
      model: "deepseek-chat",
      emitter,
      binPath: "hermes",
    });
    assert.deepEqual(calls[0].args, ["-m", "deepseek-chat", "-z", "say pong"]);
    calls[0].child.emit("close", 0, null);
    await turn;
  });
});

test("omits -m when no model was chosen (Hermes keeps its configured one)", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter } = makeEmitter();
    const turn = driver.runHermesTurn({ prompt: "hi", emitter, binPath: "hermes" });
    assert.deepEqual(calls[0].args, ["-z", "hi"]);
    calls[0].child.emit("close", 0, null);
    await turn;
  });
});

test("lists the configured model plus the provider cache for the picker", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-hermes-home-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    [
      "# Hermes config",
      "model:",
      "  default: deepseek-flash",
      "  provider: deepseek",
      "  base_url: https://api.deepseek.com",
      "agent:",
      "  max_turns: 150",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "provider_models_cache.json"),
    JSON.stringify({
      deepseek: { fp: "x", at: 1, models: ["deepseek-flash", "deepseek-v4-pro", " ", 7] },
      openrouter: { models: ["anthropic/claude-fable-5"] },
    }),
    "utf8",
  );

  try {
    const { parseHermesModelConfig, readHermesProviderModels, listHermesModels, readHermesHome } =
      require("./hermesDriver.cjs");

    assert.deepEqual(parseHermesModelConfig(fs.readFileSync(path.join(dir, "config.yaml"), "utf8")), {
      defaultModel: "deepseek-flash",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
    });
    assert.deepEqual(readHermesProviderModels(dir, "deepseek"), ["deepseek-flash", "deepseek-v4-pro"]);
    // A provider the cache does not know, and no provider at all, are both empty.
    assert.deepEqual(readHermesProviderModels(dir, "acme"), []);
    assert.deepEqual(readHermesProviderModels(dir, null), []);

    assert.deepEqual(listHermesModels({ env: { HERMES_HOME: dir } }), {
      currentModelId: "deepseek-flash",
      models: [
        { id: "deepseek-flash", name: "deepseek-flash" },
        { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
      ],
    });
    // HERMES_HOME is honoured; a missing home yields an empty catalog, not a throw.
    assert.equal(readHermesHome({ HERMES_HOME: dir }), dir);
    assert.deepEqual(listHermesModels({ env: { HERMES_HOME: path.join(dir, "missing") } }), {
      currentModelId: null,
      models: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
