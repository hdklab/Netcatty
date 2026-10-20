"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const { createLocalProxyServer } = require("./localProxyServer.cjs");

function startEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startProxy(options = {}) {
  const proxy = createLocalProxyServer({ host: "127.0.0.1", port: 0, ...options });
  return proxy.listen().then(() => proxy);
}

function createReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let closed = false;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on("close", () => {
    closed = true;
    flush();
  });
  function flush() {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const result = waiter.take(buffer);
      if (result) {
        buffer = buffer.subarray(result.consumed);
        waiters.splice(index, 1);
        index -= 1;
        waiter.resolve(result.value);
      } else if (closed) {
        waiters.splice(index, 1);
        index -= 1;
        waiter.reject(new Error("socket closed"));
      }
    }
  }
  return {
    /** Resolve with the buffer once `take(buffer)` returns a value. */
    wait(take, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const result = take(buffer);
        if (result) {
          buffer = buffer.subarray(result.consumed);
          resolve(result.value);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for data (have ${buffer.length} bytes)`));
        }, timeoutMs);
        const waiter = {
          take,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiters.push(waiter);
      });
    },
    async waitForBytes(count) {
      return this.wait((current) => (current.length >= count ? { value: current.subarray(0, count), consumed: count } : null));
    },
    async waitForText(marker) {
      const text = await this.wait((current) => {
        const index = current.indexOf(marker);
        return index >= 0 ? { value: current.subarray(0, index + marker.length), consumed: index + marker.length } : null;
      });
      return text.toString("utf8");
    },
    async readAvailable() {
      return this.wait((current) => (current.length > 0 ? { value: current, consumed: current.length } : null));
    },
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function socks5Handshake(socket, targetHost, targetPort, credentials) {
  const reader = createReader(socket);
  const methods = credentials ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const [version, method] = await reader.waitForBytes(2);
  assert.equal(version, 0x05);
  if (method === 0x02) {
    const username = Buffer.from(credentials.username, "utf8");
    const password = Buffer.from(credentials.password, "utf8");
    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]));
    const [authVersion, authStatus] = await reader.waitForBytes(2);
    assert.equal(authVersion, 0x01);
    assert.equal(authStatus, 0x00);
  }
  const hostBytes = Buffer.from(targetHost, "utf8");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
    hostBytes,
    Buffer.from([targetPort >> 8, targetPort & 0xff]),
  ]));
  const head = await reader.waitForBytes(4);
  assert.equal(head[0], 0x05);
  const addressType = head[3];
  const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (await reader.waitForBytes(1))[0];
  if (addressType === 0x03) {
    await reader.waitForBytes(addressLength + 2);
  } else {
    await reader.waitForBytes(addressLength + 2);
  }
  return { reader, replyCode: head[1] };
}

test("SOCKS5 CONNECT tunnels bytes to the target", async (t) => {
  const echo = await startEchoServer();
  const proxy = await startProxy();
  t.after(async () => {
    await proxy.close();
    echo.server.close();
  });

  const socket = await connect(proxy.getStatus().port);
  t.after(() => socket.destroy());
  const { reader, replyCode } = await socks5Handshake(socket, "127.0.0.1", echo.port);
  assert.equal(replyCode, 0x00);
  socket.write("ping-socks");
  const echoed = await reader.readAvailable();
  assert.equal(echoed.toString("utf8"), "ping-socks");

  const status = proxy.getStatus();
  assert.equal(status.requests, 1);
  assert.equal(status.failures, 0);
  assert.equal(status.totalConnections, 1);
});

test("HTTP CONNECT establishes a tunnel", async (t) => {
  const echo = await startEchoServer();
  const proxy = await startProxy();
  t.after(async () => {
    await proxy.close();
    echo.server.close();
  });

  const socket = await connect(proxy.getStatus().port);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
  const head = await reader.waitForText("\r\n\r\n");
  assert.match(head, /^HTTP\/1\.1 200/);
  socket.write("ping-http");
  const echoed = await reader.readAvailable();
  assert.equal(echoed.toString("utf8"), "ping-http");
});

test("HTTP absolute-form request is forwarded to the origin server", async (t) => {
  const origin = await startHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`path=${req.url}`);
  });
  const proxy = await startProxy();
  t.after(async () => {
    await proxy.close();
    origin.server.close();
  });

  const socket = await connect(proxy.getStatus().port);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  socket.write(`GET http://127.0.0.1:${origin.port}/hello HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\nConnection: close\r\n\r\n`);
  const response = await reader.waitForText("path=/hello");
  assert.match(response, /HTTP\/1\.1 200/);
});

test("a body pipelined behind the request head is forwarded, not rejected", async (t) => {
  const origin = await startHttpServer((req, res) => {
    let size = 0;
    req.on("data", (chunk) => { size += chunk.length; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`body=${size}`);
    });
  });
  const proxy = await startProxy();
  t.after(async () => {
    await proxy.close();
    origin.server.close();
  });

  const body = Buffer.alloc(24 * 1024, 0x61);
  const socket = await connect(proxy.getStatus().port);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  // Head and an oversized body arrive in the same chunk: the server must not
  // treat the body as an oversized handshake.
  socket.write(Buffer.concat([
    Buffer.from(`POST http://127.0.0.1:${origin.port}/upload HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${origin.port}\r\n`
      + `Content-Length: ${body.length}\r\n`
      + "Connection: close\r\n\r\n"),
    body,
  ]));
  const response = await reader.waitForText(`body=${body.length}`);
  assert.match(response, /HTTP\/1\.1 200/);
});

test("SOCKS5 requires credentials when a password is configured", async (t) => {
  const echo = await startEchoServer();
  const proxy = await startProxy({ auth: { username: "catty", password: "s3cret" } });
  t.after(async () => {
    await proxy.close();
    echo.server.close();
  });
  const port = proxy.getStatus().port;

  const anonymous = await connect(port);
  t.after(() => anonymous.destroy());
  const reader = createReader(anonymous);
  anonymous.write(Buffer.from([0x05, 0x01, 0x00]));
  const [version, method] = await reader.waitForBytes(2);
  assert.equal(version, 0x05);
  assert.equal(method, 0xff);

  const authorized = await connect(port);
  t.after(() => authorized.destroy());
  const { reader: authReader, replyCode } = await socks5Handshake(
    authorized,
    "127.0.0.1",
    echo.port,
    { username: "catty", password: "s3cret" },
  );
  assert.equal(replyCode, 0x00);
  authorized.write("authed");
  assert.equal((await authReader.readAvailable()).toString("utf8"), "authed");
});

test("HTTP CONNECT answers 407 without Proxy-Authorization", async (t) => {
  const echo = await startEchoServer();
  const proxy = await startProxy({ auth: { username: "catty", password: "s3cret" } });
  t.after(async () => {
    await proxy.close();
    echo.server.close();
  });
  const port = proxy.getStatus().port;

  const denied = await connect(port);
  t.after(() => denied.destroy());
  const deniedReader = createReader(denied);
  denied.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\n\r\n`);
  const deniedHead = await deniedReader.waitForText("\r\n\r\n");
  assert.match(deniedHead, /^HTTP\/1\.1 407/);
  assert.match(deniedHead, /Proxy-Authenticate: Basic/);

  const allowed = await connect(port);
  t.after(() => allowed.destroy());
  const allowedReader = createReader(allowed);
  const token = Buffer.from("catty:s3cret").toString("base64");
  allowed.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nProxy-Authorization: Basic ${token}\r\n\r\n`);
  const allowedHead = await allowedReader.waitForText("\r\n\r\n");
  assert.match(allowedHead, /^HTTP\/1\.1 200/);
  allowed.write("ok");
  assert.equal((await allowedReader.readAvailable()).toString("utf8"), "ok");
});

test("chains SOCKS5 clients through an upstream SOCKS5 proxy", async (t) => {
  const echo = await startEchoServer();
  const upstream = await startProxy();
  const front = await startProxy({
    upstream: { type: "socks5", host: "127.0.0.1", port: upstream.getStatus().port },
  });
  t.after(async () => {
    await front.close();
    await upstream.close();
    echo.server.close();
  });

  const socket = await connect(front.getStatus().port);
  t.after(() => socket.destroy());
  const { reader, replyCode } = await socks5Handshake(socket, "127.0.0.1", echo.port);
  assert.equal(replyCode, 0x00);
  socket.write("chained-socks");
  assert.equal((await reader.readAvailable()).toString("utf8"), "chained-socks");
  assert.equal(upstream.getStatus().requests, 1);
  assert.equal(front.getStatus().requests, 1);
});

test("chains HTTP CONNECT clients through an upstream HTTP proxy", async (t) => {
  const echo = await startEchoServer();
  const upstream = await startProxy();
  const front = await startProxy({
    upstream: { type: "http", host: "127.0.0.1", port: upstream.getStatus().port },
  });
  t.after(async () => {
    await front.close();
    await upstream.close();
    echo.server.close();
  });

  const socket = await connect(front.getStatus().port);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\n\r\n`);
  const head = await reader.waitForText("\r\n\r\n");
  assert.match(head, /^HTTP\/1\.1 200/);
  socket.write("chained-http");
  assert.equal((await reader.readAvailable()).toString("utf8"), "chained-http");
  assert.equal(upstream.getStatus().requests, 1);
});

test("records a failure when the target refuses connections", async (t) => {
  const proxy = await startProxy();
  t.after(async () => proxy.close());

  const closed = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

  const socket = await connect(proxy.getStatus().port);
  t.after(() => socket.destroy());
  const { replyCode } = await socks5Handshake(socket, "127.0.0.1", closed);
  assert.equal(replyCode, 0x05);
  const status = proxy.getStatus();
  assert.equal(status.failures, 1);
  assert.ok(status.lastError);
});

test("reports the bound port and refuses to start twice on the same address", async (t) => {
  const proxy = await startProxy();
  t.after(async () => proxy.close());
  const port = proxy.getStatus().port;
  assert.ok(port > 0);

  const duplicate = createLocalProxyServer({ host: "127.0.0.1", port });
  await assert.rejects(() => duplicate.listen(), /EADDRINUSE/);
});
