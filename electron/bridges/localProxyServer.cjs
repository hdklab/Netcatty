"use strict";

/**
 * Local proxy server hosted by the main process: one TCP listener that speaks
 * both SOCKS5 and HTTP proxy protocol on the same port, so a machine running
 * Netcatty can act as a proxy server for other devices.
 *
 * Design notes:
 * - Protocol is detected from the first byte: 0x05 => SOCKS5, anything else is
 *   parsed as an HTTP proxy request (CONNECT tunnel or absolute-form forward).
 * - Optionally chains to an upstream HTTP / SOCKS5 proxy (the saved proxy
 *   profiles in the vault). Command proxies cannot be used as an upstream
 *   because they are a stdio pipe bound to one SSH target.
 * - Optional username/password (SOCKS5 RFC 1929 + HTTP Basic) for listeners
 *   exposed to the LAN.
 * - Deliberately no SOCKS5 BIND / UDP ASSOCIATE: this is a forward proxy only.
 */

const net = require("node:net");
const { timingSafeEqual } = require("node:crypto");

const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_SOCKS_HANDSHAKE_BYTES = 2 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

const SOCKS_VERSION = 0x05;

const SOCKS_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  connectionNotAllowed: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  ttlExpired: 0x06,
  commandNotSupported: 0x07,
  addressNotSupported: 0x08,
};

function toText(value) {
  return String(value ?? "").trim();
}

function isUsablePort(port) {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Split "host:port", "[::1]:port" or a bare host (defaultPort) into parts. */
function splitHostPort(raw, defaultPort = 0) {
  const text = toText(raw);
  if (!text) return null;
  const bracket = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : defaultPort };
  }
  const lastColon = text.lastIndexOf(":");
  if (lastColon > 0 && text.indexOf(":") === lastColon) {
    const host = text.slice(0, lastColon);
    const portText = text.slice(lastColon + 1);
    if (/^\d+$/.test(portText)) {
      return { host, port: Number(portText) };
    }
  }
  return { host: text, port: defaultPort };
}

function credentialsMatch(expected, received) {
  if (!expected) return true;
  if (!received) return false;
  const expectedUser = Buffer.from(toText(expected.username), "utf8");
  const receivedUser = Buffer.from(toText(received.username), "utf8");
  const expectedPass = Buffer.from(String(expected.password ?? ""), "utf8");
  const receivedPass = Buffer.from(String(received.password ?? ""), "utf8");
  const userOk = expectedUser.length === receivedUser.length
    && timingSafeEqual(expectedUser, receivedUser);
  const passOk = expectedPass.length === receivedPass.length
    && timingSafeEqual(expectedPass, receivedPass);
  return userOk && passOk;
}

function formatProxyAuthorization(username, password) {
  const token = Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function parseProxyAuthorization(headerValue) {
  const text = toText(headerValue);
  const match = text.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1].trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const index = decoded.indexOf(":");
  if (index < 0) return null;
  return { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
}

/** Parse the request head of an HTTP proxy request (first line + headers). */
function parseHttpProxyHead(head) {
  const text = String(head || "");
  const endOfLine = text.indexOf("\r\n");
  const requestLine = endOfLine >= 0 ? text.slice(0, endOfLine) : text;
  const match = requestLine.match(/^([A-Za-z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/);
  if (!match) return null;
  const headers = {};
  const lines = endOfLine >= 0 ? text.slice(endOfLine + 2).split("\r\n") : [];
  for (const line of lines) {
    if (!line) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { method: match[1].toUpperCase(), target: match[2], version: match[3], headers, raw: text };
}

/**
 * Rewrite an absolute-form proxy request into an origin-form one so it can be
 * sent straight to the origin server, dropping hop-by-hop proxy headers.
 */
function rewriteForwardHeadToOriginForm(request) {
  if (!request) return Buffer.alloc(0);
  const raw = String(request.target || "");
  let path = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      path = `${url.pathname || "/"}${url.search || ""}`;
    } catch {
      path = raw;
    }
  }
  const lines = String(request.raw || "").split("\r\n");
  const out = [`${request.method} ${path} ${request.version}`];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const index = line.indexOf(":");
    const name = index > 0 ? line.slice(0, index).trim().toLowerCase() : "";
    if (name === "proxy-authorization" || name === "proxy-connection") continue;
    out.push(line);
  }
  return Buffer.from(`${out.join("\r\n")}\r\n\r\n`, "utf8");
}

/**
 * Resolve the dial target of an HTTP proxy request.
 * kind "tunnel"  => CONNECT, reply 200 and relay raw bytes.
 * kind "forward" => absolute-form / host-header request, relay raw bytes.
 */
function resolveHttpTarget(request) {
  if (!request) return null;
  if (request.method === "CONNECT") {
    const parsed = splitHostPort(request.target, 0);
    if (!parsed?.host || !isUsablePort(parsed.port)) return null;
    return { kind: "tunnel", host: parsed.host, port: parsed.port };
  }
  const raw = toText(request.target);
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (absolute) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const defaultPort = url.protocol === "https:" ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;
    if (!url.hostname || !isUsablePort(port)) return null;
    return { kind: "forward", host: url.hostname.replace(/^\[|\]$/g, ""), port };
  }
  const hostHeader = request.headers?.host;
  const parsed = splitHostPort(hostHeader, 80);
  if (!parsed?.host || !isUsablePort(parsed.port)) return null;
  return { kind: "forward", host: parsed.host, port: parsed.port };
}

function connectTcp(host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      // Keep a no-op listener so an error between now and the caller's own
      // handler cannot crash the main process.
      socket.on("error", () => {});
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/**
 * Read from a flowing socket until `take(buffer)` returns a value.
 * `take` returns null to ask for more bytes, or { value, rest } where `rest` is
 * unshifted back onto the socket for the caller.
 */
function readFromSocket(socket, take, options = {}) {
  const maxBytes = options.maxBytes || MAX_HTTP_HEADER_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (fn, payload) => {
      cleanup();
      fn(payload);
    };
    const timer = setTimeout(() => finish(reject, new Error("Handshake timed out")), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
    }
    function onClose() {
      finish(reject, new Error("Connection closed during handshake"));
    }
    function onError(error) {
      finish(reject, error);
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        finish(reject, new Error("Handshake exceeded the maximum size"));
        return;
      }
      let result;
      try {
        result = take(buffer);
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (!result) return;
      cleanup();
      if (result.rest?.length) socket.unshift(result.rest);
      resolve(result.value);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.resume();
  });
}

/** SOCKS5 CONNECT to `target` through a SOCKS5 upstream proxy. */
async function connectThroughSocks5Upstream(upstream, target, timeoutMs) {
  const socket = await connectTcp(upstream.host, upstream.port, timeoutMs);
  const hasAuth = Boolean(toText(upstream.username));
  const methods = hasAuth ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));

  const greeting = await readFromSocket(socket, (buffer) => {
    if (buffer.length < 2) return null;
    const version = buffer[0];
    const method = buffer[1];
    return { value: { version, method }, rest: buffer.subarray(2) };
  }, { timeoutMs });
  if (greeting.version !== SOCKS_VERSION || greeting.method === 0xff) {
    socket.destroy();
    throw new Error("Upstream SOCKS5 proxy rejected the authentication methods");
  }
  if (greeting.method === 0x02) {
    if (!hasAuth) {
      socket.destroy();
      throw new Error("Upstream SOCKS5 proxy requires credentials");
    }
    const username = Buffer.from(toText(upstream.username), "utf8");
    const password = Buffer.from(String(upstream.password ?? ""), "utf8");
    if (username.length > 255 || password.length > 255) {
      socket.destroy();
      throw new Error("Upstream SOCKS5 credentials are too long");
    }
    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]));
    const authReply = await readFromSocket(socket, (buffer) => {
      if (buffer.length < 2) return null;
      return { value: buffer[1], rest: buffer.subarray(2) };
    }, { timeoutMs });
    if (authReply !== 0x00) {
      socket.destroy();
      throw new Error("Upstream SOCKS5 proxy rejected the credentials");
    }
  } else if (greeting.method !== 0x00) {
    socket.destroy();
    throw new Error("Upstream SOCKS5 proxy chose an unsupported authentication method");
  }

  const hostBytes = Buffer.from(target.host, "utf8");
  const isIpv4 = net.isIP(target.host) === 4;
  const isIpv6 = net.isIP(target.host) === 6;
  let addressField;
  if (isIpv4) {
    addressField = Buffer.from([0x01, ...target.host.split(".").map(Number)]);
  } else if (isIpv6) {
    addressField = Buffer.alloc(17);
    addressField[0] = 0x04;
    const segments = expandIpv6(target.host);
    for (let index = 0; index < 8; index += 1) {
      addressField.writeUInt16BE(segments[index], 1 + index * 2);
    }
  } else {
    if (hostBytes.length === 0 || hostBytes.length > 255) {
      socket.destroy();
      throw new Error("Target host name is not usable for SOCKS5");
    }
    addressField = Buffer.concat([Buffer.from([0x03, hostBytes.length]), hostBytes]);
  }
  const portField = Buffer.alloc(2);
  portField.writeUInt16BE(target.port, 0);
  socket.write(Buffer.concat([
    Buffer.from([SOCKS_VERSION, 0x01, 0x00]),
    addressField,
    portField,
  ]));

  const reply = await readFromSocket(socket, (buffer) => {
    if (buffer.length < 5) return null;
    const addressType = buffer[3];
    const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? buffer[4] + 1 : 0;
    if (!addressLength) throw new Error("Upstream SOCKS5 proxy sent an unsupported address type");
    const total = 4 + addressLength + 2;
    if (buffer.length < total) return null;
    return { value: buffer[1], rest: buffer.subarray(total) };
  }, { timeoutMs });
  if (reply !== 0x00) {
    socket.destroy();
    throw new Error(`Upstream SOCKS5 proxy refused the connection (code ${reply})`);
  }
  return socket;
}

function expandIpv6(address) {
  const [head, tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [
    ...headParts,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...tailParts,
  ].filter((part) => part.length > 0);
  return parts.slice(0, 8).map((part) => parseInt(part || "0", 16) || 0);
}

/** TLS-less CONNECT tunnel through an HTTP upstream proxy. */
async function connectThroughHttpUpstream(upstream, target, timeoutMs) {
  const socket = await connectTcp(upstream.host, upstream.port, timeoutMs);
  const lines = [
    `CONNECT ${target.host}:${target.port} HTTP/1.1`,
    `Host: ${target.host}:${target.port}`,
  ];
  if (toText(upstream.username)) {
    lines.push(`Proxy-Authorization: ${formatProxyAuthorization(upstream.username, upstream.password)}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const status = await readFromSocket(socket, (buffer) => {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker < 0) return null;
    const head = buffer.subarray(0, marker).toString("utf8");
    const statusLine = head.split("\r\n")[0] || "";
    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    if (!match) throw new Error("Upstream HTTP proxy sent an invalid response");
    return { value: Number(match[1]), rest: buffer.subarray(marker + 4) };
  }, { timeoutMs });
  if (status !== 200) {
    socket.destroy();
    throw new Error(`Upstream HTTP proxy refused the tunnel (status ${status})`);
  }
  return socket;
}

async function dialTarget(upstream, target, kind, timeoutMs) {
  if (!upstream) return connectTcp(target.host, target.port, timeoutMs);
  if (upstream.type === "socks5") {
    return connectThroughSocks5Upstream(upstream, target, timeoutMs);
  }
  if (upstream.type === "http") {
    // A plain HTTP forward can be handed to the upstream verbatim; only a
    // tunnel needs CONNECT.
    if (kind === "forward") return connectTcp(upstream.host, upstream.port, timeoutMs);
    return connectThroughHttpUpstream(upstream, target, timeoutMs);
  }
  throw new Error(`Unsupported upstream proxy type: ${upstream.type}`);
}

function socks5Reply(code, host = "0.0.0.0", port = 0) {
  const ipv4 = net.isIP(host) === 4 ? host.split(".").map(Number) : [0, 0, 0, 0];
  const buffer = Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, ...ipv4, 0, 0]);
  buffer.writeUInt16BE(port, buffer.length - 2);
  return buffer;
}

function mapDialErrorToSocksReply(error) {
  const code = error?.code;
  if (code === "ECONNREFUSED") return SOCKS_REPLY.connectionRefused;
  if (code === "ENETUNREACH") return SOCKS_REPLY.networkUnreachable;
  if (code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "EAI_AGAIN") return SOCKS_REPLY.hostUnreachable;
  if (code === "ETIMEDOUT") return SOCKS_REPLY.ttlExpired;
  return SOCKS_REPLY.generalFailure;
}

function safeDestroy(socket) {
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

function relay(clientSocket, targetSocket, initialToTarget) {
  const destroyBoth = () => {
    safeDestroy(clientSocket);
    safeDestroy(targetSocket);
  };
  clientSocket.on("error", destroyBoth);
  targetSocket.on("error", destroyBoth);
  clientSocket.on("close", destroyBoth);
  targetSocket.on("close", destroyBoth);
  if (initialToTarget?.length) targetSocket.write(initialToTarget);
  clientSocket.pipe(targetSocket);
  targetSocket.pipe(clientSocket);
  clientSocket.resume();
  targetSocket.resume();
}

/**
 * @param {object} options
 * @param {string} [options.host] listen address
 * @param {number} [options.port]
 * @param {null | { type: 'http'|'socks5', host: string, port: number, username?: string, password?: string }} [options.upstream]
 * @param {null | { username: string, password?: string }} [options.auth]
 * @param {(event: object) => void} [options.onEvent]
 * @param {(...args: unknown[]) => void} [options.log]
 */
function createLocalProxyServer(options = {}) {
  const host = toText(options.host) || "127.0.0.1";
  const port = Number(options.port);
  const upstream = options.upstream || null;
  const auth = options.auth || null;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const handshakeTimeoutMs = options.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const dial = options.dialTarget || dialTarget;

  const stats = {
    activeConnections: 0,
    totalConnections: 0,
    requests: 0,
    failures: 0,
    lastError: null,
  };
  const sockets = new Set();
  let listening = false;

  function emit() {
    try {
      onEvent({ ...getStatus() });
    } catch (error) {
      log("[LocalProxy] status listener failed:", error);
    }
  }

  function failConnection(socket, error, requestTarget) {
    stats.failures += 1;
    stats.lastError = error?.message || String(error);
    log("[LocalProxy] request failed:", requestTarget || "", stats.lastError);
    safeDestroy(socket);
    emit();
  }

  function handleConnection(socket) {
    sockets.add(socket);
    stats.activeConnections += 1;
    stats.totalConnections += 1;
    socket.setNoDelay(true);
    let settled = false;
    const handshakeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      failConnection(socket, new Error("Handshake timed out"));
    }, handshakeTimeoutMs);

    const cleanup = () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);
      emit();
    };
    socket.on("close", cleanup);
    socket.on("error", (error) => {
      log("[LocalProxy] client socket error:", error?.message || error);
    });

    let buffer = Buffer.alloc(0);
    let mode = null;

    const finishHandshake = () => {
      settled = true;
      clearTimeout(handshakeTimer);
      socket.off("data", onData);
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!mode) {
        if (buffer.length < 1) return;
        mode = buffer[0] === SOCKS_VERSION ? "socks5" : "http";
      }
      // Bound memory only while the request head is still incomplete: a client
      // may pipeline a body right behind the headers, and that body must not be
      // mistaken for an oversized handshake.
      const headComplete = mode === "http" && buffer.indexOf("\r\n\r\n") >= 0;
      if (!headComplete && buffer.length > MAX_HTTP_HEADER_BYTES + MAX_SOCKS_HANDSHAKE_BYTES) {
        if (!settled) {
          settled = true;
          failConnection(socket, new Error("Request head too large"));
        }
        return;
      }
      if (mode === "socks5") {
        progressSocks5();
      } else {
        progressHttp();
      }
    };

    // ---- SOCKS5 server handshake --------------------------------------
    let socksStage = auth ? "greeting" : "greeting";
    let socksTarget = null;

    const socksFail = (code) => {
      if (settled) return;
      settled = true;
      finishHandshake();
      try {
        socket.write(socks5Reply(code));
      } catch {
        // ignore
      }
      failConnection(socket, new Error(`SOCKS5 handshake rejected (code ${code})`));
    };

    const progressSocks5 = () => {
      while (!settled) {
        if (socksStage === "greeting") {
          if (buffer.length < 2) return;
          const methodCount = buffer[1];
          if (buffer.length < 2 + methodCount) return;
          const methods = Array.from(buffer.subarray(2, 2 + methodCount));
          buffer = buffer.subarray(2 + methodCount);
          const wantsAuth = Boolean(auth);
          const chosen = wantsAuth
            ? (methods.includes(0x02) ? 0x02 : 0xff)
            : (methods.includes(0x00) ? 0x00 : 0xff);
          if (chosen === 0xff) {
            socksFail(0xff);
            return;
          }
          socket.write(Buffer.from([SOCKS_VERSION, chosen]));
          socksStage = chosen === 0x02 ? "credentials" : "request";
          continue;
        }
        if (socksStage === "credentials") {
          if (buffer.length < 2) return;
          if (buffer[0] !== 0x01) {
            socksFail(0x01);
            return;
          }
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passLength = buffer[2 + userLength];
          const total = 2 + userLength + 1 + passLength;
          if (buffer.length < total) return;
          const username = buffer.subarray(2, 2 + userLength).toString("utf8");
          const password = buffer.subarray(3 + userLength, total).toString("utf8");
          buffer = buffer.subarray(total);
          const ok = credentialsMatch(auth, { username, password });
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            settled = true;
            finishHandshake();
            failConnection(socket, new Error("SOCKS5 authentication failed"));
            return;
          }
          socksStage = "request";
          continue;
        }
        if (socksStage === "request") {
          if (buffer.length < 4) return;
          if (buffer[0] !== SOCKS_VERSION) {
            socksFail(SOCKS_REPLY.generalFailure);
            return;
          }
          if (buffer[1] !== 0x01) {
            socksFail(SOCKS_REPLY.commandNotSupported);
            return;
          }
          const addressType = buffer[3];
          let addressLength;
          if (addressType === 0x01) addressLength = 4;
          else if (addressType === 0x04) addressLength = 16;
          else if (addressType === 0x03) {
            if (buffer.length < 5) return;
            addressLength = buffer[4] + 1;
          } else {
            socksFail(SOCKS_REPLY.addressNotSupported);
            return;
          }
          const total = 4 + addressLength + 2;
          if (buffer.length < total) return;
          let targetHost;
          if (addressType === 0x01) {
            targetHost = Array.from(buffer.subarray(4, 8)).join(".");
          } else if (addressType === 0x04) {
            const parts = [];
            for (let index = 0; index < 8; index += 1) {
              parts.push(buffer.readUInt16BE(4 + index * 2).toString(16));
            }
            targetHost = parts.join(":");
          } else {
            targetHost = buffer.subarray(5, 5 + addressLength - 1).toString("utf8");
          }
          const targetPort = buffer.readUInt16BE(4 + addressLength);
          const rest = buffer.subarray(total);
          buffer = Buffer.alloc(0);
          if (!targetHost || !isUsablePort(targetPort)) {
            socksFail(SOCKS_REPLY.addressNotSupported);
            return;
          }
          socksTarget = { host: targetHost, port: targetPort };
          settled = true;
          finishHandshake();
          stats.requests += 1;
          emit();
          dial(upstream, socksTarget, "tunnel", connectTimeoutMs)
            .then((targetSocket) => {
              try {
                socket.write(socks5Reply(SOCKS_REPLY.succeeded));
              } catch (error) {
                safeDestroy(targetSocket);
                failConnection(socket, error, `${targetHost}:${targetPort}`);
                return;
              }
              relay(socket, targetSocket, rest);
            })
            .catch((error) => {
              if (!socket.destroyed) {
                try {
                  socket.write(socks5Reply(mapDialErrorToSocksReply(error)));
                } catch {
                  // ignore
                }
              }
              failConnection(socket, error, `${targetHost}:${targetPort}`);
            });
          return;
        }
        return;
      }
    };

    // ---- HTTP proxy handshake ------------------------------------------
    const progressHttp = () => {
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker < 0) {
        if (buffer.length > MAX_HTTP_HEADER_BYTES) {
          if (!settled) {
            settled = true;
            failConnection(socket, new Error("HTTP request head too large"));
          }
        }
        return;
      }
      const head = buffer.subarray(0, marker).toString("utf8");
      const rest = buffer.subarray(marker + 4);
      buffer = Buffer.alloc(0);
      const request = parseHttpProxyHead(head);
      if (!request) {
        settled = true;
        finishHandshake();
        try {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        } catch {
          // ignore
        }
        failConnection(socket, new Error("Malformed proxy request"));
        return;
      }
      if (auth) {
        const received = parseProxyAuthorization(request.headers["proxy-authorization"]);
        if (!credentialsMatch(auth, received)) {
          settled = true;
          finishHandshake();
          try {
            socket.write(
              "HTTP/1.1 407 Proxy Authentication Required\r\n"
              + 'Proxy-Authenticate: Basic realm="Netcatty proxy"\r\n'
              + "Connection: close\r\n\r\n",
            );
          } catch {
            // ignore
          }
          failConnection(socket, new Error("Proxy authentication required"));
          return;
        }
      }
      const target = resolveHttpTarget(request);
      if (!target) {
        settled = true;
        finishHandshake();
        try {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        } catch {
          // ignore
        }
        failConnection(socket, new Error(`Unsupported proxy target: ${request.target}`));
        return;
      }
      settled = true;
      finishHandshake();
      stats.requests += 1;
      emit();
      const label = `${target.host}:${target.port}`;
      dial(upstream, target, target.kind, connectTimeoutMs)
        .then((targetSocket) => {
          if (target.kind === "tunnel") {
            try {
              socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            } catch (error) {
              safeDestroy(targetSocket);
              failConnection(socket, error, label);
              return;
            }
            relay(socket, targetSocket);
            return;
          }
          // An HTTP upstream expects the absolute-form request verbatim; when we
          // talk to the origin ourselves it must be rewritten to origin-form.
          const usesHttpUpstream = upstream?.type === "http";
          relay(
            socket,
            targetSocket,
            usesHttpUpstream
              ? rest
              : Buffer.concat([rewriteForwardHeadToOriginForm(request), rest]),
          );
        })
        .catch((error) => {
          if (!socket.destroyed) {
            try {
              const status = error?.code === "ECONNREFUSED" ? "502 Bad Gateway" : "502 Bad Gateway";
              socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
            } catch {
              // ignore
            }
          }
          failConnection(socket, error, label);
        });
    };

    socket.on("data", onData);
  }

  const server = net.createServer(handleConnection);
  server.on("error", (error) => {
    log("[LocalProxy] listener error:", error?.message || error);
    stats.lastError = error?.message || String(error);
    emit();
  });

  function getStatus() {
    return {
      running: listening,
      host,
      port: listening ? server.address()?.port ?? port : port,
      upstreamType: upstream?.type || null,
      requiresAuth: Boolean(auth),
      activeConnections: stats.activeConnections,
      totalConnections: stats.totalConnections,
      requests: stats.requests,
      failures: stats.failures,
      lastError: stats.lastError,
    };
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        listening = true;
        stats.lastError = null;
        emit();
        resolve(getStatus());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!listening) {
        resolve();
        return;
      }
      for (const socket of sockets) safeDestroy(socket);
      sockets.clear();
      listening = false;
      server.close(() => {
        stats.activeConnections = 0;
        emit();
        resolve();
      });
    });
  }

  return { listen, close, getStatus, server };
}

module.exports = {
  createLocalProxyServer,
  parseHttpProxyHead,
  resolveHttpTarget,
  parseProxyAuthorization,
  formatProxyAuthorization,
  splitHostPort,
  SOCKS_REPLY,
  MAX_HTTP_HEADER_BYTES,
};
