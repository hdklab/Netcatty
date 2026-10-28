"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const compressUploadBridge = require("./compressUploadBridge.cjs");

// The remote capability probe is a self-test script, not `tar --version`.
const isRemoteTarProbeCommand = (command) => String(command).includes("netcatty-probe");

test("compressed commits to the same remote folder are serialized", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  const first = run("sftp-1:/target/folder", null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first-end");
    active -= 1;
  });
  const second = run("sftp-1:/target/folder", null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("second-start");
    active -= 1;
  });
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.equal(compressUploadBridge._getCompressionTargetLockCountForTests(), 0);
});

test("compressed commits through different SFTP channels share the endpoint target lock", async () => {
  compressUploadBridge.init({
    sftpClients: new Map([
      ["window-a-sftp", { __netcattyEndpointKey: "host|route|auth" }],
      ["window-b-sftp", { __netcattyEndpointKey: "host|route|auth" }],
    ]),
    transferBridge: {},
  });
  const resolveKey = compressUploadBridge._resolveCompressionTargetKeyForTests;
  const firstKey = resolveKey("window-a-sftp", "/target/./nested/..", "folder");
  const secondKey = resolveKey("window-b-sftp", "/target", "folder");
  assert.equal(firstKey, secondKey);

  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  const first = run(firstKey, null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => { releaseFirst = resolve; });
    active -= 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = run(secondKey, null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test("an aborted lock waiter cannot let a later compressed commit bypass the active owner", async () => {
  const run = compressUploadBridge._runWithCompressionTargetLockForTests;
  let releaseFirst;
  let thirdStarted = false;
  const first = run("sftp-1:/target/abort", null, () => new Promise((resolve) => {
    releaseFirst = resolve;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = run("sftp-1:/target/abort", controller.signal, async () => {});
  controller.abort(new Error("cancelled waiter"));
  await assert.rejects(second, /cancelled waiter/);
  const third = run("sftp-1:/target/abort", null, async () => { thirdStarted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdStarted, false);
  releaseFirst();
  await Promise.all([first, third]);
  assert.equal(thirdStarted, true);
});

test("worker-backed compressed pause and resume publish ordered lifecycle", async () => {
  const handlers = new Map();
  const events = [];
  let finishStart;
  const startGate = new Promise((resolve) => { finishStart = resolve; });
  compressUploadBridge.init({
    sftpClients: new Map(),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      async request(channel) {
        if (channel === "netcatty:compress:start") return startGate;
        if (channel === "netcatty:compress:pause") {
          return { success: true, deferred: false };
        }
        return { success: true };
      },
    },
  });

  const starting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );
  await handlers.get("netcatty:compress:pause")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );
  await handlers.get("netcatty:compress:resume")(
    { sender: { id: 1 } },
    { compressionId: "compressed-worker" },
  );

  assert.deepEqual(events, [
    {
      type: "pausing",
      transferId: "compressed-worker",
      lifecycleEpoch: 1,
      lifecycleState: "pausing",
    },
    {
      type: "paused",
      transferId: "compressed-worker",
      lifecycleEpoch: 1,
      lifecycleState: "paused",
    },
    {
      type: "resumed",
      transferId: "compressed-worker",
      lifecycleEpoch: 2,
      lifecycleState: "transferring",
    },
  ]);
  finishStart({ compressionId: "compressed-worker", success: true });
  await starting;
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("worker compression lifecycle epochs survive a reused id and clear after the latest start settles", async () => {
  const handlers = new Map();
  let finishFirst;
  let finishSecond;
  const firstGate = new Promise((resolve) => { finishFirst = resolve; });
  const secondGate = new Promise((resolve) => { finishSecond = resolve; });
  let startCalls = 0;
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:compress:start") {
          startCalls += 1;
          return startCalls === 1 ? firstGate : secondGate;
        }
        return Promise.resolve({ success: true });
      },
    },
  });

  const firstStarting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-lifetime" },
  );
  const secondStarting = handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-lifetime" },
  );
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 1);

  finishFirst({ compressionId: "compression-cache-lifetime", success: true });
  await firstStarting;
  assert.equal(
    compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(),
    1,
    "an older completion must not clear the newer start's lifecycle state",
  );

  finishSecond({ compressionId: "compression-cache-lifetime", success: true });
  await secondStarting;
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("worker compression lifecycle epoch clears after a synchronous start failure", () => {
  const handlers = new Map();
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    terminalWorkerManager: {
      request(channel) {
        if (channel === "netcatty:compress:start") throw new Error("worker unavailable");
        return Promise.resolve({ success: true });
      },
    },
  });

  assert.throws(() => handlers.get("netcatty:compress:start")(
    { sender: { id: 1 } },
    { compressionId: "compression-cache-sync-failure" },
  ), /worker unavailable/);
  assert.equal(compressUploadBridge._getWorkerCompressionLifecycleEpochCountForTests(), 0);
});

test("cancelling while the remote tar probe is pending publishes cancelled", async () => {
  const handlers = new Map();
  const events = [];
  let remoteProbeStarted;
  const remoteProbeGate = new Promise((resolve) => { remoteProbeStarted = resolve; });
  const remoteStream = new (require("node:events").EventEmitter)();
  remoteStream.stderr = new (require("node:events").EventEmitter)();
  remoteStream.close = () => {};
  remoteStream.end = () => {};
  remoteStream.destroy = () => {};
  const sender = { id: 1, send() {} };

  compressUploadBridge.init({
    sftpClients: new Map([["sftp-probe", {
      client: {
        exec(_command, callback) {
          callback(null, remoteStream);
          remoteProbeStarted();
        },
      },
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });

  const starting = handlers.get("netcatty:compress:start")({ sender }, {
    compressionId: "cancel-during-probe",
    folderPath: "/unused",
    targetPath: "/unused",
    sftpId: "sftp-probe",
    folderName: "unused",
    totalBytes: 1,
  });
  await remoteProbeGate;
  await handlers.get("netcatty:compress:cancel")({ sender }, {
    compressionId: "cancel-during-probe",
  });
  await starting;

  assert.equal(events.at(-1)?.type, "cancelled");
  assert.equal(events.some((event) => event.type === "failed"), false);
});

test("compressed upload holds its SFTP session until remote extraction settles", async (t) => {
  const handlers = new Map();
  const calls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-lease-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let extractionStarted;
  const extractionGate = new Promise((resolve) => { extractionStarted = resolve; });
  let cleanupStarted;
  const cleanupGate = new Promise((resolve) => { cleanupStarted = resolve; });
  const streams = [];
  const cleanupStreams = [];
  let extractionStream = null;
  const makeStream = () => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.close = () => stream.emit("close", 1);
    stream.end = () => {};
    stream.destroy = () => {};
    streams.push(stream);
    return stream;
  };
  const sshClient = {
    exec(command, callback) {
      const stream = makeStream();
      callback(null, stream);
      if (isRemoteTarProbeCommand(command)) {
        process.nextTick(() => {
          stream.emit("data", Buffer.from("netcatty-tar-probe-ok"));
          stream.emit("close", 0);
        });
      } else if (command.includes("tar -xzf")) {
        extractionStream = stream;
        extractionStarted();
      } else {
        cleanupStreams.push(stream);
        cleanupStarted();
      }
    },
  };

  compressUploadBridge.init({
    sftpClients: new Map([["sftp-compressed", {
      client: sshClient,
      __netcattyEndpointKey: "endpoint:compressed",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(leaseId, payload) {
        calls.push(`acquire:${leaseId}:${payload.targetSftpId}`);
        return [payload.targetSftpId];
      },
      releaseTransferSessionLeases(leaseId, sftpIds) {
        calls.push(`release:${leaseId}:${sftpIds.join(",")}`);
      },
      async startInternalTransfer() {
        calls.push("upload");
        return { success: true };
      },
      async cancelTransfer() { return { success: true }; },
      broadcastGlobalTransferEvent() {},
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });

  const sender = { id: 1, send() {} };
  const starting = handlers.get("netcatty:compress:start")({ sender }, {
    compressionId: "compressed-lifecycle",
    folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-compressed",
    folderName: "folder",
    totalBytes: 7,
  });
  let startSettled = false;
  void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
  await extractionGate;

  assert.deepEqual(calls, [
    "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
    "upload",
  ]);

  extractionStream.emit("close", 0);
  await cleanupGate;
  assert.deepEqual(
    calls,
    [
      "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
      "upload",
    ],
    "the outer SFTP lease must remain held while remote cleanup is still running",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startSettled, false, "compressed upload must await remote cleanup before releasing its lease");
  for (const stream of cleanupStreams) stream.emit("close", 0);
  await starting;

  assert.deepEqual(calls, [
    "acquire:compress-lifecycle:compressed-lifecycle:sftp-compressed",
    "upload",
    "release:compress-lifecycle:compressed-lifecycle:sftp-compressed",
  ]);
});

test("compressed upload never deletes AppleDouble files across the target parent", async (t) => {
  const remoteCommands = [];
  const harness = createSuccessfulCompressionHarness(t, {
    onRemoteCommand(command) { remoteCommands.push(command); },
  });

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "no-parent-cleanup",
    folderPath: harness.folderPath,
    targetPath: "/srv/shared",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, true);
  assert.equal(
    remoteCommands.some((command) => /\bfind\b[\s\S]*\._\*/.test(command)),
    false,
    "cleanup must not scan and delete pre-existing ._* files under the whole target parent",
  );
  assert.equal(
    remoteCommands.some((command) => /^rm -f /.test(command)),
    true,
    "the uploaded archive still receives a bounded best-effort cleanup",
  );
});

function createSuccessfulCompressionHarness(t, { onRemoteCommand, onUpload } = {}) {
  const handlers = new Map();
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-harness-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sshClient = {
    writable: true,
    exec(command, callback) {
      onRemoteCommand?.(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = () => {};
      stream.destroy = () => {};
      callback(null, stream);
      process.nextTick(() => {
        if (isRemoteTarProbeCommand(command)) stream.emit("data", Buffer.from("netcatty-tar-probe-ok"));
        stream.emit("close", 0);
      });
    },
  };
  compressUploadBridge._resetCompressionSupportCacheForTests?.();
  compressUploadBridge.init({
    sftpClients: new Map([["sftp-harness", {
      client: sshClient,
      __netcattyEndpointKey: "endpoint:harness",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
      async startInternalTransfer(_event, payload) {
        onUpload?.(payload);
        return { success: true };
      },
      async cancelTransfer() { return { success: true }; },
    },
  });
  compressUploadBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  return { handlers, events, folderPath, sender: { id: 1, send() {} } };
}

test("support preflight is reused by the immediately following compressed start", async (t) => {
  let remoteProbeCalls = 0;
  const harness = createSuccessfulCompressionHarness(t, {
    onRemoteCommand(command) {
      if (isRemoteTarProbeCommand(command)) remoteProbeCalls += 1;
    },
  });
  const support = await harness.handlers.get("netcatty:compress:checkSupport")(
    { sender: harness.sender },
    { sftpId: "sftp-harness" },
  );
  assert.equal(support.supported, true);

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "cached-support-start",
    folderPath: harness.folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, true);
  assert.equal(remoteProbeCalls, 1);
});

test("remote archive paths are unique for concurrent operation identities", async (t) => {
  const uploadedPaths = [];
  const harness = createSuccessfulCompressionHarness(t, {
    onUpload(payload) { uploadedPaths.push(payload.targetPath); },
  });

  await Promise.all([
    harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
      compressionId: "archive-one",
      folderPath: harness.folderPath,
      targetPath: "/tmp",
      sftpId: "sftp-harness",
      folderName: "folder",
      totalBytes: 7,
    }),
    harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
      compressionId: "archive-two",
      folderPath: harness.folderPath,
      targetPath: "/tmp",
      sftpId: "sftp-harness",
      folderName: "folder",
      totalBytes: 7,
    }),
  ]);

  assert.equal(uploadedPaths.length, 2);
  assert.notEqual(uploadedPaths[0], uploadedPaths[1]);
});

test("a late cancel after completion cannot overwrite the completed terminal event", async (t) => {
  const harness = createSuccessfulCompressionHarness(t);
  await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "completed-before-cancel",
    folderPath: harness.folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });
  const terminalBefore = harness.events.filter((event) => (
    event.transferId === "completed-before-cancel"
    && ["completed", "cancelled", "failed"].includes(event.type)
  ));
  assert.deepEqual(terminalBefore.map((event) => event.type), ["completed"]);

  await harness.handlers.get("netcatty:compress:cancel")({ sender: harness.sender }, {
    compressionId: "completed-before-cancel",
  });
  const terminalAfter = harness.events.filter((event) => (
    event.transferId === "completed-before-cancel"
    && ["completed", "cancelled", "failed"].includes(event.type)
  ));
  assert.deepEqual(terminalAfter.map((event) => event.type), ["completed"]);
});

test("cancelling a settled compression that left the registry reports success", async (t) => {
  const harness = createSuccessfulCompressionHarness(t);
  await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "settled-before-cancel",
    folderPath: harness.folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-harness",
    folderName: "folder",
    totalBytes: 7,
  });

  const result = await harness.handlers.get("netcatty:compress:cancel")({ sender: harness.sender }, {
    compressionId: "settled-before-cancel",
  });
  assert.equal(result.success, true);
  assert.equal(result.inactive, true);

  const resultUnknownId = await harness.handlers.get("netcatty:compress:cancel")({ sender: harness.sender }, {
    compressionId: "never-started",
  });
  assert.equal(resultUnknownId.success, true);
  assert.equal(resultUnknownId.inactive, true);
});

test("compressed upload skips remote tar exec on single-channel SSH", async () => {
  let execCalls = 0;
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([
      ["sftp-1", {
        __netcattySingleChannelSsh: true,
        client: {
          exec() {
            execCalls += 1;
            throw new Error("must not exec on single-channel SSH");
          },
        },
      }],
    ]),
    transferBridge: {},
  });

  const result = await compressUploadBridge._checkCompressedUploadSupportForTests(null, {
    sftpId: "sftp-1",
  });

  assert.equal(result.supported, false);
  assert.equal(result.remoteTar, false);
  assert.equal(execCalls, 0);
});

test("single-channel compressed upload stays on per-file SFTP even when the terminal is idle", async () => {
  let execCalls = 0;
  const prompt = "[dev@host ~]$ ";
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([
      ["sftp-shell", {
        __netcattySingleChannelSsh: true,
        __netcattyEndpointKey: "ep-shell",
        client: {
          exec() {
            execCalls += 1;
            throw new Error("must not exec on single-channel SSH");
          },
        },
      }],
    ]),
    sessions: new Map([
      ["term-shell", {
        singleChannelSsh: true,
        connRef: { endpointKey: "ep-shell" },
        _promptTrackTail: prompt,
        stream: { writable: true, write() {}, on() {}, removeListener() {} },
      }],
    ]),
    transferBridge: {},
  });

  const result = await compressUploadBridge._checkCompressedUploadSupportForTests(null, {
    sftpId: "sftp-shell",
  });

  assert.equal(result.supported, false);
  assert.equal(result.remoteTar, false);
  assert.equal(execCalls, 0);
});

test("single-channel compressed upload falls back while the terminal line is busy", async () => {
  let execCalls = 0;
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([
      ["sftp-busy", {
        __netcattySingleChannelSsh: true,
        __netcattyEndpointKey: "ep-busy",
        client: { exec() { execCalls += 1; throw new Error("must not exec"); } },
      }],
    ]),
    sessions: new Map([
      ["term-busy", {
        singleChannelSsh: true,
        connRef: { endpointKey: "ep-busy" },
        _promptTrackTail: "[dev@host ~]$ ll ",
        stream: { writable: true, write() {}, on() {}, removeListener() {} },
      }],
    ]),
    transferBridge: {},
  });

  const result = await compressUploadBridge._checkCompressedUploadSupportForTests(null, {
    sftpId: "sftp-busy",
  });

  assert.equal(result.remoteTar, false);
  assert.equal(execCalls, 0);
});

test("single-channel compressed upload does not extract through the terminal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-shell-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let execCalls = 0;
  const writes = [];
  const stream = new EventEmitter();
  stream.writable = true;
  stream.write = (line) => {
    writes.push(String(line));
    const marker = String(line).match(/NETCATTY_EXTRACT_[a-z0-9_]+/i);
    if (!marker) return true;
    process.nextTick(() => stream.emit("data", Buffer.from("\n" + marker[0] + " 0\n")));
    return true;
  };

  const handlers = new Map();
  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([
      ["sftp-extract", {
        __netcattySingleChannelSsh: true,
        __netcattyEndpointKey: "ep-extract",
        client: {
          writable: true,
          exec() {
            execCalls += 1;
            throw new Error("must not exec on single-channel SSH");
          },
        },
      }],
    ]),
    sessions: new Map([
      ["term-extract", {
        singleChannelSsh: true,
        connRef: { endpointKey: "ep-extract" },
        _promptTrackTail: "[dev@host ~]$ ",
        stream,
      }],
    ]),
    transferBridge: {
      acquireTransferSessionLeases() { return ["sftp-extract"]; },
      releaseTransferSessionLeases() {},
      async startInternalTransfer() { return { success: true }; },
      async cancelTransfer() { return { success: true }; },
      broadcastGlobalTransferEvent() {},
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });

  const result = await handlers.get("netcatty:compress:start")({ sender: { id: 1, send() {} } }, {
    compressionId: "shell-extract",
    folderPath,
    targetPath: "/tmp",
    sftpId: "sftp-extract",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, undefined);
  assert.equal(result.fallback, true, "single-channel hosts must fall back to the regular upload");
  assert.match(result.error, /single-channel/i);
  assert.equal(execCalls, 0);
  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// Unsupported archive format (tar present, gzip/`-z` missing) must fall back to
// the regular file-by-file upload instead of failing the folder.
// ---------------------------------------------------------------------------

function createRemoteTarFailureHarness(t, { failCommand, stderr }) {
  const handlers = new Map();
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-tar-format-"));
  const folderPath = path.join(root, "folder");
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, "file.txt"), "payload");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sshClient = {
    writable: true,
    exec(command, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = () => {};
      stream.destroy = () => {};
      callback(null, stream);
      process.nextTick(() => {
        if (isRemoteTarProbeCommand(command)) {
          stream.emit("data", Buffer.from("netcatty-tar-probe-ok"));
          stream.emit("close", 0);
          return;
        }
        if (failCommand(command)) {
          stream.stderr.emit("data", Buffer.from(stderr));
          stream.emit("close", 2);
          return;
        }
        stream.emit("close", 0);
      });
    },
  };

  compressUploadBridge._resetCompressionSupportCacheForTests();
  compressUploadBridge.init({
    sftpClients: new Map([["sftp-tar-format", {
      client: sshClient,
      __netcattyEndpointKey: "endpoint:tar-format",
    }]]),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent(event) { events.push(event); },
      async startInternalTransfer() { return { success: true }; },
      async cancelTransfer() { return { success: true }; },
    },
  });
  compressUploadBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });
  return { handlers, events, folderPath, sender: { id: 1, send() {} } };
}

test("the remote tar probe requires a working gzip round trip, not just a tar binary", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell test");
  const command = compressUploadBridge._buildRemoteTarProbeCommandForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-tar-probe-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A real tar satisfies the probe.
  const ok = require("node:child_process").spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /netcatty-tar-probe-ok/);

  // A tar that exists but cannot handle -z (BusyBox without the gzip applet)
  // must fail the probe, so the uploader never starts a doomed compression.
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin);
  const fakeTar = path.join(fakeBin, "tar");
  fs.writeFileSync(
    fakeTar,
    "#!/bin/sh\ncase \" $* \" in *\" -z\"*|*\"-czf\"*|*\"-xzf\"*) echo \"tar: invalid option -- 'z'\" >&2; exit 2;; esac\nexec /bin/tar \"$@\"\n",
    { mode: 0o755 },
  );
  const rejected = require("node:child_process").spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stdout, /netcatty-tar-probe-ok/);
});

test("an unsupported tar archive format falls back to the regular upload", async (t) => {
  const harness = createRemoteTarFailureHarness(t, {
    failCommand: (command) => command.includes("tar -xzf"),
    stderr: "tar: invalid option -- 'z'\n",
  });

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "format-unsupported",
    folderPath: harness.folderPath,
    targetPath: "/srv/target",
    sftpId: "sftp-tar-format",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.success, undefined);
  assert.equal(result.fallback, true, "the renderer must retry this folder without compression");
  const terminal = harness.events.at(-1);
  assert.equal(terminal.type, "failed", "the compressed row must not stay in transferring");
  assert.match(String(terminal.error), /gzip|invalid option|not supported/i);

  // The verdict is cached so the remaining folders of the same batch skip
  // compression instead of failing the same way once per folder.
  const support = await harness.handlers.get("netcatty:compress:checkSupport")(
    { sender: harness.sender },
    { sftpId: "sftp-tar-format" },
  );
  assert.equal(support.supported, false);
});

test("a real extraction failure is not reported as an unsupported format", async (t) => {
  const harness = createRemoteTarFailureHarness(t, {
    failCommand: (command) => command.includes("tar -xzf"),
    stderr: "cp: cannot create regular file '/srv/target/x': Permission denied\n",
  });

  const result = await harness.handlers.get("netcatty:compress:start")({ sender: harness.sender }, {
    compressionId: "extract-permission-denied",
    folderPath: harness.folderPath,
    targetPath: "/srv/target",
    sftpId: "sftp-tar-format",
    folderName: "folder",
    totalBytes: 7,
  });

  assert.equal(result.fallback, undefined);
  assert.match(String(result.error), /Permission denied/);
  // A real failure must not poison the capability cache for later folders.
  const support = await harness.handlers.get("netcatty:compress:checkSupport")(
    { sender: harness.sender },
    { sftpId: "sftp-tar-format" },
  );
  assert.equal(support.supported, true);
});

test("only archive-format failures count as a capability fallback", () => {
  const isUnsupported = compressUploadBridge._isUnsupportedTarFormatErrorForTests;

  // tar exists but this archive format / these flags are not supported.
  for (const message of [
    "Remote extraction failed: tar: invalid option -- 'z'",
    "Remote extraction failed: tar: unrecognized option '--exclude'",
    "Remote extraction failed: tar: z: unknown function modifier",
    "Remote extraction failed: tar: gzip: not found",
    "Remote extraction failed: sh: gzip: not found",
    "Remote extraction failed: tar: Cannot exec gzip: No such file or directory",
    "Remote extraction failed: tar: can't run gzip: No such file or directory",
    "Remote extraction failed: tar: Unrecognized archive format",
    "Failed to start tar: spawn tar ENOENT",
    "Remote extraction failed: tar: invalid tar magic",
  ]) {
    assert.equal(isUnsupported(new Error(message)), true, message);
  }

  // Real transfer problems must stay hard failures.
  for (const message of [
    "Remote extraction failed: cp: cannot create regular file '/srv/x': Permission denied",
    "Remote extraction failed: tar: Cannot open: No space left on device",
    "Remote extraction failed: tar: Cannot open: Is a directory",
    "Remote command timed out after 60 seconds",
    "Remote extraction failed: exit code 1",
  ]) {
    assert.equal(isUnsupported(new Error(message)), false, message);
  }
});

test("the remote extraction script runs on a BusyBox tar that rejects GNU long options", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell test");
  const { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-extract-busybox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = path.join(root, "src");
  fs.mkdirSync(path.join(source, "folder", "sub"), { recursive: true });
  fs.writeFileSync(path.join(source, "folder", "payload.txt"), "payload");
  fs.writeFileSync(path.join(source, "folder", ".DS_Store"), "junk");
  fs.writeFileSync(path.join(source, "folder", "sub", "._payload.txt"), "junk");

  const targetDir = path.join(root, "target");
  fs.mkdirSync(targetDir);
  const archivePath = path.join(targetDir, "upload.tar.gz");
  const created = spawnSync("tar", [
    "-czf", archivePath, "-C", source,
    "--exclude=._*", "--exclude=.DS_Store", "folder",
  ], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  const command = compressUploadBridge._buildAtomicRemoteExtractionCommandForTests({
    compressionId: "abcdef1234567890",
    archivePath,
    targetDir,
    folderName: "folder",
  });
  // BusyBox tar answers "tar: unrecognized option '--exclude=._*'" and fails
  // the whole upload; the archive we send never contains those entries anyway.
  assert.doesNotMatch(command, /--exclude/);

  // A tar shaped like BusyBox's (long options rejected) must still extract.
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "tar"), [
    "#!/bin/sh",
    "for arg in \"$@\"; do",
    "  case \"$arg\" in",
    "    --?*) echo \"tar: unrecognized option '$arg'\" >&2; exit 1;;",
    "  esac",
    "done",
    "exec /bin/tar \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });

  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(fs.readFileSync(path.join(targetDir, "folder", "payload.txt"), "utf8"), "payload");
  assert.equal(fs.existsSync(path.join(targetDir, "folder", ".DS_Store")), false);
  assert.equal(fs.existsSync(path.join(targetDir, "folder", "sub", "._payload.txt")), false);
  assert.equal(fs.existsSync(path.join(targetDir, ".netcatty-compress-abcdef1234567890.stage")), false);
  assert.equal(fs.existsSync(archivePath), false, "the uploaded archive is cleaned up");
});
