import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_DEFAULTS, isCursorAvailableForMode, isCursorRuntimeInstalled } from "./types";
import { MANAGED_AGENT_KEYS } from "../../../../infrastructure/ai/managedAgents";

test("isCursorRuntimeInstalled ignores bundled SDK flags", () => {
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: true,
    sdkInstalled: true,
  }), false);
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor SDK",
    available: false,
    installed: false,
    sdkInstalled: true,
    cliBinPath: null,
    cliLoginOk: false,
  }), false);
});

test("isCursorRuntimeInstalled is true for Agent CLI path or CLI login", () => {
  assert.equal(isCursorRuntimeInstalled({
    path: "/usr/local/bin/cursor-agent",
    version: "Cursor Agent CLI",
    available: false,
    sdkInstalled: true,
    cliBinPath: "/usr/local/bin/cursor-agent",
    cliLoginOk: false,
  }), true);
  assert.equal(isCursorRuntimeInstalled({
    path: "cursor",
    version: "Cursor Agent CLI",
    available: true,
    sdkInstalled: true,
    cliLoginOk: true,
  }), true);
});

test("isCursorAvailableForMode still allows API-key mode from bundled SDK", () => {
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: false,
    sdkInstalled: true,
    apiKeyOk: true,
  }, "api-key"), true);
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: true,
    installed: false,
    apiKeyOk: true,
  }, "api-key"), true);
  assert.equal(isCursorAvailableForMode({
    path: "cursor",
    version: "Cursor SDK",
    available: false,
    installed: false,
    sdkInstalled: true,
    cliLoginOk: false,
  }, "cli-login"), false);
});

test('every managed agent has registration defaults with a name, icon and SDK backend', () => {
  // A managed agent that resolves without these shows up as a bare command path
  // in the agent picker and cannot be sent to (sdkBackend is the routing value).
  for (const key of MANAGED_AGENT_KEYS) {
    const defaults = AGENT_DEFAULTS[key];
    assert.ok(defaults, `${key} must have AGENT_DEFAULTS`);
    assert.equal(typeof defaults.name, 'string', `${key} needs a display name`);
    assert.ok(defaults.name.trim().length > 0, `${key} display name must not be empty`);
    assert.equal(typeof defaults.icon, 'string', `${key} needs an icon key`);
    assert.ok(defaults.icon.trim().length > 0, `${key} icon key must not be empty`);
    assert.equal(defaults.sdkBackend, key, `${key} must route through its own SDK backend`);
  }
});

test('DeepSeek Harness and Hermes are registered with their display names', () => {
  assert.equal(AGENT_DEFAULTS.dsh.name, 'DeepSeek Harness');
  assert.equal(AGENT_DEFAULTS.dsh.icon, 'dsh');
  assert.equal(AGENT_DEFAULTS.hermes.name, 'Hermes');
  assert.equal(AGENT_DEFAULTS.hermes.icon, 'hermes');
});
