"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  DSH_MANAGED_BLOCK_END,
  DSH_MANAGED_BLOCK_START,
  createAgentMcpSetup,
  findManagedBlock,
  parseJsonc,
  stripManagedBlock,
  upsertManagedBlock,
} = require("./agentMcpSetup.cjs");

const LAUNCHER_PATH = "/opt/netcatty/resources/app.asar.unpacked/electron/cli/netcatty-external-mcp";
const DISCOVERY_PATH = "/home/user/.config/netcatty/external-mcp/discovery.json";
const DSH_PROFILE_TEMPLATE = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries.",
  "[]",
  "",
].join("\n");

let rootDir;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nc-agent-mcp-"));
});

function createSetup(overrides = {}) {
  return createAgentMcpSetup({
    homedir: () => rootDir,
    env: {},
    getLauncherPath: () => LAUNCHER_PATH,
    getDiscoveryFilePath: () => DISCOVERY_PATH,
    ...overrides,
  });
}

async function seedDshProfile(profile = "headless") {
  const profileDir = path.join(rootDir, ".dsh", "profiles", profile);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, "cordis.patch.yml"), DSH_PROFILE_TEMPLATE, "utf8");
  return profileDir;
}

describe("agent MCP setup: supported keys", () => {
  it("reports unsupported agents instead of inventing an install path", async () => {
    const setup = createSetup();
    const status = await setup.getStatus({ agentKey: "mimo" });
    assert.equal(status.supported, false);
    assert.equal(status.state, "unsupported");

    const result = await setup.install({ agentKey: "mimo" });
    assert.equal(result.ok, false);
    assert.equal(result.state, "unsupported");
  });
});

describe("agent MCP setup: dsh profile", () => {
  it("writes the netcatty-mcp row into the profile patch file and reports installed", async () => {
    const profileDir = await seedDshProfile();
    const setup = createSetup();

    const before = await setup.getStatus({ agentKey: "dsh" });
    assert.equal(before.supported, true);
    assert.equal(before.installed, false);
    assert.equal(before.state, "not_installed");
    assert.equal(before.patchFile, path.join(profileDir, "cordis.patch.yml"));

    const result = await setup.install({ agentKey: "dsh" });
    assert.equal(result.ok, true);
    assert.equal(result.state, "installed");

    const written = await fs.readFile(path.join(profileDir, "cordis.patch.yml"), "utf8");
    assert.match(written, /@deepseek-ai\/dsh-mcp-client/);
    assert.match(written, /serverName: netcatty/);
    assert.ok(written.includes(LAUNCHER_PATH));
    assert.ok(written.includes(`NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE: '${DISCOVERY_PATH}'`));
    // The template's `[]` placeholder must go: `[]` plus list items is invalid YAML.
    assert.ok(!written.split("\n").some((line) => line.trim() === "[]"));

    const after = await setup.getStatus({ agentKey: "dsh" });
    assert.equal(after.installed, true);
    assert.equal(after.state, "installed");
  });

  it("keeps other entries in the patch file and re-running stays idempotent", async () => {
    const profileDir = await seedDshProfile();
    const patchFile = path.join(profileDir, "cordis.patch.yml");
    const foreign = [
      "- id: ui-settings-general",
      "  name: \"@deepseek-ai/dsh-client-ui-settings-general\"",
      "  config:",
      "    welcomeNoticeVersion: 2026-09-28.1",
      "",
    ].join("\n");
    await fs.writeFile(patchFile, foreign, "utf8");
    const setup = createSetup();

    assert.equal((await setup.install({ agentKey: "dsh" })).ok, true);
    const first = await fs.readFile(patchFile, "utf8");
    assert.ok(first.includes("ui-settings-general"));
    assert.equal((await setup.install({ agentKey: "dsh" })).ok, true);
    const second = await fs.readFile(patchFile, "utf8");
    assert.equal(second, first);
    assert.equal(second.split(DSH_MANAGED_BLOCK_START).length, 2);
  });

  it("treats a row pointing at a stale launcher path as not installed", async () => {
    await seedDshProfile();
    const setup = createSetup();
    await setup.install({ agentKey: "dsh" });

    const moved = createSetup({ getLauncherPath: () => "/moved/netcatty-external-mcp" });
    const status = await moved.getStatus({ agentKey: "dsh" });
    assert.equal(status.supported, true);
    assert.equal(status.installed, false);
    assert.equal(status.state, "stale");
  });

  it("does not offer to install when the dsh profile does not exist", async () => {
    const setup = createSetup();
    const status = await setup.getStatus({ agentKey: "dsh" });
    assert.equal(status.supported, false);
    assert.equal(status.state, "profile_missing");
    assert.equal((await setup.install({ agentKey: "dsh" })).state, "profile_missing");
  });

  it("respects DSH_HOME and DSH_PROFILE overrides", async () => {
    const dshHome = path.join(rootDir, "custom-dsh");
    const profileDir = path.join(dshHome, "profiles", "tui");
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, "cordis.patch.yml"), "[]\n", "utf8");
    const setup = createSetup({ env: { DSH_HOME: dshHome, DSH_PROFILE: "tui" } });

    const status = await setup.getStatus({ agentKey: "dsh" });
    assert.equal(status.profile, "tui");
    assert.equal((await setup.install({ agentKey: "dsh" })).ok, true);
    assert.match(await fs.readFile(path.join(profileDir, "cordis.patch.yml"), "utf8"), /netcatty-mcp/);
  });
});

describe("agent MCP setup: CLI targets", () => {
  it("registers hermes through its own `mcp add` and detects the config row", async () => {
    const calls = [];
    const configFile = path.join(rootDir, ".hermes", "config.yaml");
    const setup = createSetup({
      resolveCli: async (command) => (command === "hermes" ? "/usr/local/bin/hermes" : null),
      runCli: async (command, args, options) => {
        calls.push({ command, args, options });
        await fs.mkdir(path.dirname(configFile), { recursive: true });
        await fs.writeFile(configFile, [
          "mcp_servers:",
          "  netcatty:",
          "    command: " + LAUNCHER_PATH,
          "    enabled: true",
          "",
        ].join("\n"), "utf8");
        return { exitCode: 0, stdout: "added", stderr: "" };
      },
    });

    assert.equal((await setup.getStatus({ agentKey: "hermes" })).installed, false);
    const result = await setup.install({ agentKey: "hermes" });
    assert.equal(result.ok, true);
    assert.equal(result.state, "installed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/local/bin/hermes");
    assert.deepEqual(calls[0].args, [
      "mcp", "add", "netcatty",
      "--command", LAUNCHER_PATH,
      "--env", `NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE=${DISCOVERY_PATH}`,
    ]);
    // `hermes mcp add` asks "Enable all N tools?"; without stdin it cancels.
    assert.equal(calls[0].options.input, "Y\n");
    assert.equal((await setup.getStatus({ agentKey: "hermes" })).installed, true);
  });

  it("reports a missing CLI instead of failing the enable flow", async () => {
    const setup = createSetup({ resolveCli: async () => null });
    const status = await setup.getStatus({ agentKey: "hermes" });
    assert.equal(status.supported, false);
    assert.equal(status.state, "cli_not_found");
  });

  it("registers opencode globally and reads a JSONC config for status", async () => {
    const configFile = path.join(rootDir, ".config", "opencode", "opencode.jsonc");
    const calls = [];
    const setup = createSetup({
      resolveCli: async (command) => (command === "opencode" ? "/usr/local/bin/opencode" : null),
      runCli: async (command, args) => {
        calls.push({ command, args });
        await fs.mkdir(path.dirname(configFile), { recursive: true });
        await fs.writeFile(configFile, [
          "{",
          "  // Netcatty MCP server",
          '  "mcp": { "servers": { "netcatty": { "type": "local", "command": ["' + LAUNCHER_PATH + '"] } } }',
          "}",
          "",
        ].join("\n"), "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await setup.install({ agentKey: "opencode" });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      "mcp", "add", "netcatty",
      "--global",
      "--env", `NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE=${DISCOVERY_PATH}`,
      "--", LAUNCHER_PATH,
    ]);
    assert.equal((await setup.getStatus({ agentKey: "opencode" })).installed, true);
  });

  it("surfaces the CLI output when the add command fails", async () => {
    const setup = createSetup({
      resolveCli: async () => "/usr/local/bin/opencode",
      runCli: async () => ({ exitCode: 1, stdout: "", stderr: "boom: bad config" }),
    });
    const result = await setup.install({ agentKey: "opencode" });
    assert.equal(result.ok, false);
    assert.equal(result.state, "error");
    assert.match(result.error, /boom: bad config/);
  });
});

describe("agent MCP setup: client-setup delegation (codex/claude/grok)", () => {
  it("maps the client setup state onto installed/not installed", async () => {
    let installed = false;
    const setup = createSetup({
      getClientSetupStatus: async () => ({ state: installed ? "configured" : "not_configured" }),
      installClientSetup: async () => {
        installed = true;
        return { state: "configured" };
      },
    });

    assert.equal((await setup.getStatus({ agentKey: "codex" })).installed, false);
    const result = await setup.install({ agentKey: "codex" });
    assert.equal(result.installed, true);
    assert.equal(result.state, "configured");
    assert.equal((await setup.getStatus({ agentKey: "codex" })).installed, true);
  });

  it("does not offer to install for a CLI that is not on the machine", async () => {
    const setup = createSetup({
      getClientSetupStatus: async () => ({ state: "codex_not_found" }),
      installClientSetup: async () => {
        throw new Error("should not run");
      },
    });

    const status = await setup.getStatus({ agentKey: "codex" });
    assert.equal(status.supported, false);
    assert.equal(status.state, "codex_not_found");
    assert.equal((await setup.install({ agentKey: "codex" })).ok, false);
  });
});

describe("agent MCP setup: patch-file helpers", () => {
  it("removes only the managed block", () => {
    const block = [DSH_MANAGED_BLOCK_START, "- insert:", "    - id: netcatty-mcp", DSH_MANAGED_BLOCK_END].join("\n");
    const source = `${block}\n\n- id: keep-me\n`;
    const stripped = stripManagedBlock(source);
    assert.ok(!stripped.includes(DSH_MANAGED_BLOCK_START));
    assert.match(stripped, /- id: keep-me/);
    assert.equal(findManagedBlock(stripped), null);
  });

  it("drops the `[]` placeholder when inserting entries", () => {
    const block = [DSH_MANAGED_BLOCK_START, "- insert:", DSH_MANAGED_BLOCK_END].join("\n");
    const result = upsertManagedBlock("# comment\n[]\n", block);
    assert.ok(!result.split("\n").some((line) => line.trim() === "[]"));
    assert.match(result, /# comment/);
    assert.match(result, /- insert:/);
  });

  it("parses JSONC with line and block comments", () => {
    const parsed = parseJsonc('{\n  /* c */\n  "mcp": { "servers": {} }, // trailing\n  "url": "https://x//y"\n}');
    assert.deepEqual(parsed, { mcp: { servers: {} }, url: "https://x//y" });
  });
});
