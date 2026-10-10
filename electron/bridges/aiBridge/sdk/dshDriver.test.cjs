"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

const DRIVER_PATH = require.resolve("./dshDriver.cjs");
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
  return {
    text,
    emitter: {
      text(chunk) {
        if (chunk) text.push(chunk);
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("runs dsh headless in the session cwd and streams stdout as text", async () => {
  await withFakeSpawn(async ({ driver, calls }) => {
    const { emitter, text } = makeEmitter();
    const turn = driver.runDshTurn({
      prompt: "say pong",
      cwd: "/work/project",
      env: { DEEPSEEK_API_KEY: "secret" },
      binPath: "/usr/bin/dsh",
      emitter,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["headless", "say pong"]);
    assert.equal(calls[0].options.cwd, "/work/project");
    assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, "secret");

    const child = calls[0].child;
    child.stdout.emit("data", "pong\n");
    child.emit("close", 0, null);
    await turn;

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
