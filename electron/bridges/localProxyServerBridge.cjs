"use strict";

/**
 * Local proxy server bridge - lets one Netcatty instance act as a proxy server
 * (SOCKS5 + HTTP on one port) for other devices. The listener lives here in the
 * main process; the renderer only owns configuration and status display.
 */

const net = require("node:net");
const os = require("node:os");
const { createLocalProxyServer } = require("./localProxyServer.cjs");

/** Electron is required lazily so the bridge can be unit-tested under plain node. */
function getBrowserWindow() {
  try {
    return require("electron").BrowserWindow || null;
  } catch {
    return null;
  }
}

const STATUS_CHANNEL = "netcatty:proxyserver:status";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LAN_HOSTS = new Set(["0.0.0.0", "::"]);

let current = null;
let broadcastTimer = null;

function normalizeBindHost(value) {
  const text = String(value ?? "").trim();
  if (!text || LOOPBACK_HOSTS.has(text)) return "127.0.0.1";
  if (LAN_HOSTS.has(text)) return "0.0.0.0";
  return "127.0.0.1";
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeUpstream(value) {
  if (!value) return null;
  const type = value.type === "socks5" ? "socks5" : value.type === "http" ? "http" : null;
  if (!type) return undefined;
  const host = String(value.host ?? "").trim();
  const port = normalizePort(value.port);
  if (!host || !port) return undefined;
  const upstream = { type, host, port };
  const username = String(value.username ?? "");
  if (username) {
    upstream.username = username;
    upstream.password = String(value.password ?? "");
  }
  return upstream;
}

function normalizeAuth(value) {
  if (!value) return null;
  const username = String(value.username ?? "").trim();
  if (!username) return null;
  return { username, password: String(value.password ?? "") };
}

const IDLE_STATUS = {
  running: false,
  host: "127.0.0.1",
  port: 1080,
  upstreamType: null,
  requiresAuth: false,
  activeConnections: 0,
  totalConnections: 0,
  requests: 0,
  failures: 0,
  lastError: null,
  lanAddress: null,
  lanAddresses: [],
};

function getStatus() {
  const lanAddresses = pickLanAddresses();
  if (!current) return { ...IDLE_STATUS, lanAddress: lanAddresses[0] || null, lanAddresses };
  return { ...current.proxy.getStatus(), lanAddress: lanAddresses[0] || null, lanAddresses };
}

/**
 * Every usable IPv4 address, used to show the LAN endpoints. Virtual/bridge
 * interfaces (docker, libvirt, VPN tunnels) are skipped so the addresses we
 * display are ones another device on the network can actually reach.
 */
let lanAddressCache = { at: 0, addresses: [] };

function pickLanAddresses() {
  // Status frames fire on every connection event; rescanning interfaces each
  // time is wasted work, and addresses change far less often than that.
  if (Date.now() - lanAddressCache.at < 5000) return lanAddressCache.addresses;
  const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|tailscale|zt|ham|podman|Mihomo|mihomo|lo)/i;
  const addresses = [];
  try {
    for (const [name, entries] of Object.entries(os.networkInterfaces() || {})) {
      if (VIRTUAL.test(name)) continue;
      for (const entry of entries || []) {
        if (!entry || entry.family !== "IPv4" || entry.internal) continue;
        if (entry.address.startsWith("127.") || entry.address.startsWith("169.254.")) continue;
        addresses.push(entry.address);
      }
    }
  } catch {
    // ignore
  }
  const unique = [...new Set(addresses)];
  lanAddressCache = { at: Date.now(), addresses: unique };
  return unique;
}

/** Coalesce connection churn into at most one status frame per 250 ms. */
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastStatus();
  }, 250);
}

function broadcastStatus() {
  const payload = getStatus();
  const BrowserWindow = getBrowserWindow();
  for (const win of BrowserWindow?.getAllWindows?.() || []) {
    if (win?.isDestroyed?.()) continue;
    try {
      win.webContents.send(STATUS_CHANNEL, payload);
    } catch {
      // window may be closing
    }
  }
}

async function stopLocalProxyServer() {
  if (!current) return getStatus();
  const { proxy } = current;
  current = null;
  try {
    await proxy.close();
  } catch (error) {
    console.error("[LocalProxy] failed to close listener:", error);
  }
  console.log("[LocalProxy] proxy service stopped");
  scheduleBroadcast();
  return getStatus();
}

async function startLocalProxyServer(payload = {}) {
  const port = normalizePort(payload.port ?? 1080);
  if (!port) {
    return { success: false, error: "invalid-port", status: getStatus() };
  }
  const host = normalizeBindHost(payload.bindHost ?? payload.host);
  const upstream = normalizeUpstream(payload.upstream);
  if (upstream === undefined) {
    // Never fall back to a direct exit when the caller asked for an upstream:
    // that would silently leak traffic the user meant to route through it.
    return { success: false, error: "unsupported-upstream", status: getStatus() };
  }
  const auth = normalizeAuth(payload.auth);

  await stopLocalProxyServer();

  const proxy = createLocalProxyServer({
    host,
    port,
    upstream,
    auth,
    onEvent: () => scheduleBroadcast(),
    log: (...args) => console.log(...args),
  });

  try {
    await proxy.listen();
  } catch (error) {
    const code = error?.code === "EADDRINUSE"
      ? "port-in-use"
      : error?.code === "EACCES"
        ? "permission-denied"
        : "listen-failed";
    // Expected configuration failures (port already taken, privileged port) are
    // reported to the UI; log one line instead of a stack trace.
    console.warn(`[LocalProxy] failed to start (${code}):`, error?.message || error);
    return { success: false, error: code, detail: error?.message || String(error), status: getStatus() };
  }

  current = { proxy, host, port, upstream, auth };
  console.log(`[LocalProxy] proxy service listening on ${host}:${proxy.getStatus().port}`);
  broadcastStatus();
  return { success: true, status: getStatus() };
}

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:proxyserver:start", (_event, payload) => startLocalProxyServer(payload || {}));
  ipcMain.handle("netcatty:proxyserver:stop", () => stopLocalProxyServer());
  ipcMain.handle("netcatty:proxyserver:status", () => getStatus());
}

module.exports = {
  registerHandlers,
  startLocalProxyServer,
  stopLocalProxyServer,
  getStatus,
  STATUS_CHANNEL,
};
