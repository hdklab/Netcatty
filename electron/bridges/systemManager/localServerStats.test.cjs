"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  collectLocalServerStats,
  computeCpuUsage,
  parseMeminfo,
  parseOsRelease,
  resetLocalServerStatsSampling,
} = require("./localServerStats.cjs");

test("parseMeminfo reads the kilobyte fields", () => {
  const parsed = parseMeminfo("MemTotal:       15961548 kB\nMemFree:         1234 kB\nBuffers: 10 kB\n");
  assert.equal(parsed.MemTotal, 15961548);
  assert.equal(parsed.MemFree, 1234);
  assert.equal(parsed.Buffers, 10);
});

test("parseOsRelease strips quotes and keeps the pretty name", () => {
  const parsed = parseOsRelease('NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\n');
  assert.equal(parsed.NAME, "Debian GNU/Linux");
  assert.equal(parsed.PRETTY_NAME, "Debian GNU/Linux 13 (trixie)");
  assert.equal(parsed.ID, "debian");
});

test("computeCpuUsage needs two samples and reports per-core deltas", () => {
  assert.deepEqual(computeCpuUsage(null, [{ idle: 0, total: 100 }]), { cpu: null, cpuPerCore: [] });
  const previous = [{ idle: 50, total: 100 }, { idle: 100, total: 100 }];
  const current = [{ idle: 60, total: 200 }, { idle: 190, total: 200 }];
  const { cpu, cpuPerCore } = computeCpuUsage(previous, current);
  assert.deepEqual(cpuPerCore, [90, 10]);
  assert.equal(cpu, 50);
});

test("collectLocalServerStats returns the ServerStats shape for this machine", () => {
  resetLocalServerStatsSampling();
  const first = collectLocalServerStats();
  const second = collectLocalServerStats();
  assert.equal(typeof second.hostname, "string");
  assert.equal(typeof second.kernelRelease, "string");
  assert.ok(Number.isFinite(second.cpuCores) && second.cpuCores > 0);
  assert.ok(Number.isFinite(second.memTotal) && second.memTotal > 0);
  assert.equal(second.cpuPerCore.length, second.cpuCores);
  assert.ok(Number.isFinite(second.lastUpdated));
  // second sample has a CPU delta to work with, the first one cannot.
  assert.equal(first.cpu, null);
  assert.ok(Number.isFinite(second.cpu));
  assert.deepEqual(second.topProcesses, []);
  assert.deepEqual(second.netInterfaces, []);
});
