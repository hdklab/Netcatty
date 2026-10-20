"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const bridge = require("./localProxyServerBridge.cjs");

function createFakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    invoke(channel, payload) {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler for ${channel}`);
      return handler({ sender: {} }, payload);
    },
    has(channel) {
      return handlers.has(channel);
    },
  };
}

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Start on a freshly probed port, retrying when the OS hands us a busy one. */
async function startOnFreePort(ipcMain, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = await findFreePort();
    last = await ipcMain.invoke("netcatty:proxyserver:start", {
      bindHost: "127.0.0.1",
      port,
      ...options,
    });
    if (last.success) return last;
    if (last.error !== "port-in-use") return last;
  }
  return last;
}

function startEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function readUntil(socket, take, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`timed out (have ${buffer.length} bytes)`));
    }, timeoutMs);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const result = take(buffer);
      if (!result) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(result);
    }
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function socks5Connect(port, host, targetPort) {
  const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
  socket.on("error", () => {});
  await readUntil(socket, (buffer) => (buffer.length >= 2 ? true : null));
  const hostBytes = Buffer.from(host, "utf8");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
    hostBytes,
    Buffer.from([targetPort >> 8, targetPort & 0xff]),
  ]));
  const reply = await readUntil(socket, (buffer) => (buffer.length >= 10 ? buffer : null));
  assert.equal(reply[1], 0x00, "SOCKS5 CONNECT should succeed");
  return socket;
}

test("registers the proxy server IPC channels", () => {
  const ipcMain = createFakeIpcMain();
  bridge.registerHandlers(ipcMain);
  assert.ok(ipcMain.has("netcatty:proxyserver:start"));
  assert.ok(ipcMain.has("netcatty:proxyserver:stop"));
  assert.ok(ipcMain.has("netcatty:proxyserver:status"));
});

test("local proxy server bridge", async (t) => {
  await t.test("starts, reports status, forwards traffic, and stops", async (t) => {
  const ipcMain = createFakeIpcMain();
  bridge.registerHandlers(ipcMain);
  const echo = await startEchoServer();
  const port = await findFreePort();
  t.after(async () => {
    await ipcMain.invoke("netcatty:proxyserver:stop");
    echo.server.close();
  });

  const started = await startOnFreePort(ipcMain, { auth: null, upstream: null });
  assert.equal(started.success, true, started.error);
  assert.equal(started.status.running, true);
  assert.equal(started.status.host, "127.0.0.1");
  const boundPort = started.status.port;

  const status = await ipcMain.invoke("netcatty:proxyserver:status");
  assert.equal(status.running, true);

  const socket = await socks5Connect(boundPort, "127.0.0.1", echo.port);
  t.after(() => socket.destroy());
  socket.write("bridge-ping");
  const echoed = await readUntil(socket, (buffer) => (buffer.toString("utf8") === "bridge-ping" ? buffer : null));
  assert.equal(echoed.toString("utf8"), "bridge-ping");

  const stopped = await ipcMain.invoke("netcatty:proxyserver:stop");
  assert.equal(stopped.running, false);
  const afterStop = await ipcMain.invoke("netcatty:proxyserver:status");
  assert.equal(afterStop.running, false);
});

  await t.test("rejects invalid ports and normalizes LAN + auth options", async (t) => {
  const ipcMain = createFakeIpcMain();
  bridge.registerHandlers(ipcMain);
  t.after(() => ipcMain.invoke("netcatty:proxyserver:stop"));

  const badPort = await ipcMain.invoke("netcatty:proxyserver:start", { port: 0 });
  assert.equal(badPort.success, false);
  assert.equal(badPort.error, "invalid-port");

  // A command proxy cannot be an upstream; refusing beats silently going direct.
  const unsupported = await ipcMain.invoke("netcatty:proxyserver:start", {
    bindHost: "127.0.0.1",
    port: await findFreePort(),
    upstream: { type: "command", host: "x", port: 1 },
  });
  assert.equal(unsupported.success, false);
  assert.equal(unsupported.error, "unsupported-upstream");

  const started = await startOnFreePort(ipcMain, {
    bindHost: "0.0.0.0",
    auth: { username: " catty ", password: "secret" },
  });
  assert.equal(started.success, true, started.error);
  assert.equal(started.status.host, "0.0.0.0");
  assert.equal(started.status.requiresAuth, true);
  assert.equal(started.status.upstreamType, null);
  assert.ok(Array.isArray(started.status.lanAddresses));
  for (const address of started.status.lanAddresses) {
    assert.match(address, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.notEqual(address, "127.0.0.1", "loopback is never listed as a LAN address");
  }
});

  await t.test("reports a port collision instead of throwing", async (t) => {
  const ipcMain = createFakeIpcMain();
  bridge.registerHandlers(ipcMain);
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  t.after(() => blocker.close());

  const started = await ipcMain.invoke("netcatty:proxyserver:start", { bindHost: "127.0.0.1", port });
  assert.equal(started.success, false);
  assert.equal(started.error, "port-in-use");
  assert.equal(started.status.running, false);
});

  await t.test("restarting replaces the previous listener", async (t) => {
  const ipcMain = createFakeIpcMain();
  bridge.registerHandlers(ipcMain);
  t.after(() => ipcMain.invoke("netcatty:proxyserver:stop"));

  const first = await startOnFreePort(ipcMain);
  assert.equal(first.success, true, first.error);
  const second = await startOnFreePort(ipcMain);
  assert.equal(second.success, true, second.error);
  assert.notEqual(second.status.port, first.status.port);
  assert.equal(bridge.getStatus().port, second.status.port);
  assert.equal(bridge.getStatus().running, true);
});
});
