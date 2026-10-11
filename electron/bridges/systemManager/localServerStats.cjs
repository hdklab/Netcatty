"use strict";

/**
 * Server stats for a LOCAL terminal session.
 *
 * `netcatty:ssh:stats` runs its probe over an SSH connection, so a local shell
 * came back with "Session not found or not connected" and the System > Overview
 * tab stayed empty. There is no transport to probe here — the machine running
 * the app *is* the target — so read it straight from Node's os module plus the
 * usual /proc files, and hand back the same ServerStats shape the SSH path
 * returns (see application/state/useServerStats.ts).
 *
 * CPU and network need a delta between two samples; the previous counters are
 * kept in module scope, which is enough because the panel polls every few
 * seconds from a single main process.
 */

const fs = require("node:fs");
const os = require("node:os");

let previousCpuSample = null;   // [{ idle, total }] per core
let previousNetSample = null;   // { at, rx, tx }

function readTextFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Parse /proc/meminfo into a { Key: kilobytes } map. */
function parseMeminfo(raw) {
  const out = {};
  for (const line of String(raw || "").split("\n")) {
    const match = /^([A-Za-z_()0-9]+):\s+(\d+)/.exec(line);
    if (match) out[match[1]] = Number(match[2]);
  }
  return out;
}

/** Parse /etc/os-release into a flat map (PRETTY_NAME, NAME, ...). */
function parseOsRelease(raw) {
  const out = {};
  for (const line of String(raw || "").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

function toMb(kilobytes) {
  return Number.isFinite(kilobytes) ? Math.round(kilobytes / 1024) : null;
}

function readCpuSample() {
  return os.cpus().map((cpu) => {
    const times = cpu.times || {};
    const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
    return { idle: Number(times.idle || 0), total };
  });
}

/** Per-core + overall CPU percentage between two samples; null until we have two. */
function computeCpuUsage(previous, current) {
  if (!previous || previous.length !== current.length) return { cpu: null, cpuPerCore: [] };
  const perCore = [];
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < current.length; i += 1) {
    const dIdle = current[i].idle - previous[i].idle;
    const dTotal = current[i].total - previous[i].total;
    perCore.push(dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0);
    idleDelta += dIdle;
    totalDelta += dTotal;
  }
  const cpu = totalDelta > 0
    ? Math.round((1 - idleDelta / totalDelta) * 100)
    : perCore.length ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : null;
  return { cpu, cpuPerCore: perCore };
}

function readNetworkTotals() {
  const dir = "/sys/class/net";
  let rx = 0;
  let tx = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === "lo") continue;
      rx += Number(readTextFileSafe(`${dir}/${name}/statistics/rx_bytes`)) || 0;
      tx += Number(readTextFileSafe(`${dir}/${name}/statistics/tx_bytes`)) || 0;
    }
  } catch {
    return null;
  }
  return { at: Date.now(), rx, tx };
}

function readRootDisk() {
  try {
    const stats = fs.statfsSync("/");
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const usedBytes = totalBytes - freeBytes;
    const toGb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
    return {
      diskTotal: toGb(totalBytes),
      diskUsed: toGb(usedBytes),
      diskPercent: Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 100))),
    };
  } catch {
    return null;
  }
}

function collectLocalServerStats() {
  const cpuSample = readCpuSample();
  const { cpu, cpuPerCore } = computeCpuUsage(previousCpuSample, cpuSample);
  previousCpuSample = cpuSample;

  const meminfo = parseMeminfo(readTextFileSafe("/proc/meminfo"));
  const totalMemKb = Number.isFinite(meminfo.MemTotal) ? meminfo.MemTotal : Math.round(os.totalmem() / 1024);
  const freeKb = Number.isFinite(meminfo.MemFree) ? meminfo.MemFree : Math.round(os.freemem() / 1024);
  const buffersKb = meminfo.Buffers ?? 0;
  const cachedKb = meminfo.Cached ?? 0;
  const usedKb = Math.max(0, totalMemKb - freeKb - buffersKb - cachedKb);

  const net = readNetworkTotals();
  let netRxSpeed = 0;
  let netTxSpeed = 0;
  if (net && previousNetSample) {
    const seconds = Math.max(0.001, (net.at - previousNetSample.at) / 1000);
    netRxSpeed = Math.max(0, Math.round((net.rx - previousNetSample.rx) / seconds));
    netTxSpeed = Math.max(0, Math.round((net.tx - previousNetSample.tx) / seconds));
  }
  previousNetSample = net;

  const disk = readRootDisk();
  const osRelease = parseOsRelease(readTextFileSafe("/etc/os-release"));

  return {
    hostname: os.hostname(),
    osName: osRelease.PRETTY_NAME || osRelease.NAME || `${os.type()} ${os.release()}`,
    kernelRelease: os.release(),
    uptimeSeconds: Math.round(os.uptime()),
    loadAverage: os.loadavg(),
    cpu,
    cpuCores: cpuSample.length || null,
    cpuPerCore,
    gpu: null,
    gpuName: null,
    gpuMemUsed: null,
    gpuMemTotal: null,
    memTotal: toMb(totalMemKb),
    memUsed: toMb(usedKb),
    memFree: toMb(freeKb),
    memBuffers: toMb(buffersKb),
    memCached: toMb(cachedKb),
    swapTotal: toMb(meminfo.SwapTotal ?? 0),
    swapUsed: toMb(Math.max(0, (meminfo.SwapTotal ?? 0) - (meminfo.SwapFree ?? 0))),
    topProcesses: [],
    diskPercent: disk?.diskPercent ?? null,
    diskUsed: disk?.diskUsed ?? null,
    diskTotal: disk?.diskTotal ?? null,
    disks: [],
    netRxSpeed,
    netTxSpeed,
    latencyMs: 0,
    netInterfaces: [],
    lastUpdated: Date.now(),
  };
}

/** Reset the cached deltas (used by tests). */
function resetLocalServerStatsSampling() {
  previousCpuSample = null;
  previousNetSample = null;
}

module.exports = {
  collectLocalServerStats,
  resetLocalServerStatsSampling,
  parseMeminfo,
  parseOsRelease,
  computeCpuUsage,
};
