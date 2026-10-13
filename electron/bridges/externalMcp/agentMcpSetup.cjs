"use strict";

/**
 * Register Netcatty's external MCP server inside a coding agent's OWN
 * configuration, so an agent enabled in Netcatty's AI panel can reach the
 * user's terminals (`get_environment`, `terminal_execute`, SFTP, vault …).
 *
 * Why a per-agent writer instead of injecting per turn: the panel injects the
 * MCP server into the drivers that accept one (codex / claude / grok / copilot /
 * cursor / opencode / mimo / hermes …), but an agent CLI that takes its MCP
 * servers from its own profile — dsh, whose `headless` profile has no MCP row —
 * gets no tools unless the row is installed. Installing writes to files the
 * user owns, so the UI must ask before calling `install()`.
 *
 * Targets (see AGENT_MCP_TARGETS):
 *  - `client-setup`: codex / claude / grok — reuse the External MCP settings
 *    cards' own `mcp add` + skill installers, injected by the controller.
 *  - `cli`: hermes / opencode — run the CLI's own `mcp add` (the CLI stays the
 *    authority on its config format).
 *  - `dsh-profile`: append a managed patch block to the dsh profile's
 *    `cordis.patch.yml`, inserting a `@deepseek-ai/dsh-mcp-client` row that
 *    spawns Netcatty's launcher.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { runBoundedCliCommand } = require("./boundedCliCommand.cjs");
const {
  EXTERNAL_MCP_DISCOVERY_ENV_VAR,
  getExternalMcpLauncherPath,
} = require("../../cli/externalMcpDiscoveryPath.cjs");

/** Server name every client registers Netcatty under. */
const NETCATTY_MCP_SERVER_NAME = "netcatty";
/** dsh plugin that bridges a stdio MCP server into a profile's tool registry. */
const DSH_MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";
/** The dsh profile Netcatty boots (see dshDriver.resolveDshProfile). */
const DSH_DEFAULT_PROFILE = "headless";
const DSH_MANAGED_BLOCK_START = "# >>> netcatty-mcp (managed by Netcatty) >>>";
const DSH_MANAGED_BLOCK_END = "# <<< netcatty-mcp (managed by Netcatty) <<<";
/** dsh MCP tool-call budget; large enough for a slow remote command. */
const DSH_TOOL_CALL_TIMEOUT_MS = 120000;

const CLI_ADD_TIMEOUT_MS = 60_000;

/**
 * agent key (DiscoveredAgent.command) -> how its CLI is wired to Netcatty MCP.
 * Keys not listed here cannot be installed automatically.
 */
const AGENT_MCP_TARGETS = {
  codex: { kind: "client-setup" },
  claude: { kind: "client-setup" },
  grok: { kind: "client-setup" },
  hermes: {
    kind: "cli",
    cli: "hermes",
    // `hermes mcp add` prompts "Enable all N tools?"; feed the default answer.
    addInput: "Y\n",
    buildAddArgs: ({ launcherPath, discoveryFilePath }) => [
      "mcp",
      "add",
      NETCATTY_MCP_SERVER_NAME,
      "--command",
      launcherPath,
      ...buildEnvFlags("--env", discoveryFilePath),
    ],
  },
  opencode: {
    kind: "cli",
    cli: "opencode",
    buildAddArgs: ({ launcherPath, discoveryFilePath }) => [
      "mcp",
      "add",
      NETCATTY_MCP_SERVER_NAME,
      // Write the user-level config, not a project-scoped one.
      "--global",
      ...buildEnvFlags("--env", discoveryFilePath),
      "--",
      launcherPath,
    ],
  },
  dsh: { kind: "dsh-profile" },
};

const SUPPORTED_AGENT_MCP_KEYS = Object.freeze(Object.keys(AGENT_MCP_TARGETS));

function buildEnvFlags(flag, discoveryFilePath) {
  if (!discoveryFilePath) return [];
  return [flag, `${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${discoveryFilePath}`];
}

function isSupportedAgentMcpKey(agentKey) {
  return Object.prototype.hasOwnProperty.call(AGENT_MCP_TARGETS, String(agentKey || ""));
}

function expandHome(inputPath, homeDir) {
  const value = String(inputPath || "").trim();
  if (!value) return null;
  if (value === "~") return homeDir;
  if (value.startsWith(`~/`)) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(homeDir, value);
}

/** Single-quote a YAML scalar (paths may contain spaces or `#`). */
function toYamlSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function resolveDshPaths(env, homeDir, profileOverride) {
  const dshHome = expandHome(env.DSH_HOME, homeDir) || path.join(homeDir, ".dsh");
  const profile = String(profileOverride || env.DSH_PROFILE || "").trim() || DSH_DEFAULT_PROFILE;
  const profileDir = path.join(dshHome, "profiles", profile);
  return { dshHome, profile, profileDir, patchFile: path.join(profileDir, "cordis.patch.yml") };
}

function resolveHermesConfigFile(env, homeDir) {
  const hermesHome = expandHome(env.HERMES_HOME, homeDir) || path.join(homeDir, ".hermes");
  return path.join(hermesHome, "config.yaml");
}

function resolveOpencodeConfigFiles(env, homeDir) {
  const configRoot = expandHome(env.XDG_CONFIG_HOME, homeDir) || path.join(homeDir, ".config");
  return [
    path.join(configRoot, "opencode", "opencode.json"),
    path.join(configRoot, "opencode", "opencode.jsonc"),
  ];
}

/** Strip `//` and `/* *​/` comments so a JSONC config can be parsed as JSON. */
function parseJsonc(text) {
  const withoutBlockComments = String(text || "").replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => stripTrailingLineComment(line))
    .join("\n");
  return JSON.parse(withoutLineComments);
}

function stripTrailingLineComment(line) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

function buildDshManagedBlock({ launcherPath, discoveryFilePath }) {
  const lines = [
    DSH_MANAGED_BLOCK_START,
    "- insert:",
    "    - id: netcatty-mcp",
    `      name: ${toYamlSingleQuoted(DSH_MCP_CLIENT_PLUGIN)}`,
    "      config:",
    "        transport: stdio",
    `        serverName: ${NETCATTY_MCP_SERVER_NAME}`,
    `        command: ${toYamlSingleQuoted(launcherPath)}`,
    "        args: []",
  ];
  if (discoveryFilePath) {
    lines.push("        env:", `          ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}: ${toYamlSingleQuoted(discoveryFilePath)}`);
  } else {
    lines.push("        env: {}");
  }
  lines.push(
    "        failOnStartupError: false",
    `        toolCallTimeoutMs: ${DSH_TOOL_CALL_TIMEOUT_MS}`,
    "        reconnect:",
    "          enabled: true",
    "          initialDelayMs: 1000",
    "          maxDelayMs: 60000",
    "          maxAttempts: 60",
    DSH_MANAGED_BLOCK_END,
  );
  return lines.join("\n");
}

function findManagedBlock(text) {
  const source = String(text || "");
  const start = source.indexOf(DSH_MANAGED_BLOCK_START);
  if (start === -1) return null;
  const endMarkerIndex = source.indexOf(DSH_MANAGED_BLOCK_END, start);
  if (endMarkerIndex === -1) return null;
  const end = endMarkerIndex + DSH_MANAGED_BLOCK_END.length;
  return { start, end, block: source.slice(start, end) };
}

/** Remove our managed block, leaving every other line byte-identical. */
function stripManagedBlock(text) {
  const found = findManagedBlock(text);
  if (!found) return String(text || "");
  const before = String(text || "").slice(0, found.start);
  const after = String(text || "").slice(found.end);
  return `${before}${after}`.replace(/\n{3,}/g, "\n\n");
}

/** True when a patch file has no YAML entries at all (only comments/blank/`[]`). */
function hasNoYamlEntries(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .every((line) => line === "[]");
}

/**
 * Append (or refresh) the managed block. A bare `[]` placeholder — the dsh
 * profile template ships one — is dropped, since `[]` followed by list items is
 * not a valid top-level array.
 */
function upsertManagedBlock(existingText, block) {
  const base = stripManagedBlock(existingText);
  const baseLines = base.split("\n").filter((line) => line.trim() !== "[]");
  const trimmed = baseLines.join("\n").replace(/\s+$/, "");
  if (!trimmed) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

function createAgentMcpSetup(options = {}) {
  const deps = {
    fs: options.fs || fs,
    fsp: options.fsp || fsp,
    homedir: options.homedir || (() => os.homedir()),
    env: options.env || process.env,
    getLauncherPath: options.getLauncherPath || getExternalMcpLauncherPath,
    getDiscoveryFilePath: options.getDiscoveryFilePath || (() => null),
    /** controller-provided: (agentKey) => client-setup status (codex/claude/grok). */
    getClientSetupStatus: options.getClientSetupStatus || null,
    /** controller-provided: (agentKey) => run the client-setup install. */
    installClientSetup: options.installClientSetup || null,
    /** (cliName) => absolute path or null, resolved against the login shell env. */
    resolveCli: options.resolveCli || null,
    runCli: options.runCli || null,
    dshProfile: options.dshProfile || null,
  };

  const shell = {
    prepareCommandForSpawn: options.prepareCommandForSpawn || null,
    spawn: options.spawn || null,
    stripAnsi: options.stripAnsi || ((text) => String(text ?? "")),
  };

  async function readTextIfPresent(filePath) {
    try {
      return await deps.fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function exists(targetPath) {
    try {
      await deps.fsp.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async function runCliCommand(command, args, { input } = {}) {
    if (typeof deps.runCli === "function") {
      return await deps.runCli(command, args, { input, timeoutMs: CLI_ADD_TIMEOUT_MS });
    }
    const { prepareCommandForSpawn, stripAnsi } = require("../ai/shellUtils.cjs");
    return await runBoundedCliCommand(
      {
        prepareCommandForSpawn: shell.prepareCommandForSpawn || prepareCommandForSpawn,
        spawn: shell.spawn || require("node:child_process").spawn,
        stripAnsi: shell.stripAnsi || stripAnsi,
      },
      command,
      args,
      { timeoutMs: CLI_ADD_TIMEOUT_MS, input },
    );
  }

  async function resolveCli(command) {
    if (typeof deps.resolveCli === "function") {
      return (await deps.resolveCli(command)) || null;
    }
    const { getShellEnv, resolveCliFromPath } = require("../ai/shellUtils.cjs");
    const shellEnv = await getShellEnv();
    return resolveCliFromPath(command, shellEnv) || null;
  }

  function buildLauncherContext() {
    const launcherPath = deps.getLauncherPath() || null;
    const discoveryFilePath = deps.getDiscoveryFilePath() || null;
    return { launcherPath, discoveryFilePath };
  }

  /** Per-target install status; `installed` is what gates the ask-before-install prompt. */
  async function getStatus({ agentKey } = {}) {
    const key = String(agentKey || "");
    const target = AGENT_MCP_TARGETS[key];
    if (!target) {
      return { ok: true, agentKey: key, supported: false, installed: false, state: "unsupported" };
    }

    if (target.kind === "client-setup") {
      if (typeof deps.getClientSetupStatus !== "function") {
        return { ok: false, agentKey: key, supported: true, installed: false, state: "error", error: "Client setup is unavailable." };
      }
      const status = await deps.getClientSetupStatus(key);
      const state = status?.state || "error";
      // A CLI that is not installed cannot be configured: asking the user to
      // install Netcatty's MCP for it would only fail.
      const cliMissing = state === "codex_not_found"
        || state === "claude_not_found"
        || state === "grok_not_found";
      return {
        ok: true,
        agentKey: key,
        supported: !cliMissing,
        installed: state === "configured",
        state,
        detail: status?.command || status?.existingCommand || null,
        error: status?.error || null,
      };
    }

    if (target.kind === "cli") {
      const cliPath = await resolveCli(target.cli);
      if (!cliPath) {
        return { ok: true, agentKey: key, supported: false, installed: false, state: "cli_not_found" };
      }
      const installed = await isInstalledForCliTarget(key, target, cliPath);
      return {
        ok: true,
        agentKey: key,
        supported: true,
        installed,
        state: installed ? "installed" : "not_installed",
        executable: cliPath,
      };
    }

    // dsh-profile
    const paths = resolveDshPaths(deps.env, deps.homedir(), deps.dshProfile);
    if (!(await exists(paths.profileDir))) {
      return {
        ok: true,
        agentKey: key,
        supported: false,
        installed: false,
        state: "profile_missing",
        patchFile: paths.patchFile,
      };
    }
    const current = await readTextIfPresent(paths.patchFile);
    const found = current ? findManagedBlock(current) : null;
    if (!found) {
      return {
        ok: true,
        agentKey: key,
        supported: true,
        installed: false,
        state: "not_installed",
        patchFile: paths.patchFile,
        profile: paths.profile,
      };
    }
    const { launcherPath, discoveryFilePath } = buildLauncherContext();
    const expected = launcherPath ? buildDshManagedBlock({ launcherPath, discoveryFilePath }) : null;
    const installed = Boolean(expected) && found.block.trim() === expected.trim();
    return {
      ok: true,
      agentKey: key,
      supported: true,
      installed,
      state: installed ? "installed" : "stale",
      patchFile: paths.patchFile,
      profile: paths.profile,
    };
  }

  async function isInstalledForCliTarget(agentKey, target, cliPath) {
    const homeDir = deps.homedir();
    if (agentKey === "hermes") {
      const configFile = resolveHermesConfigFile(deps.env, homeDir);
      const text = await readTextIfPresent(configFile);
      if (text === null) return false;
      return new RegExp(`^\\s+${NETCATTY_MCP_SERVER_NAME}:\\s*$`, "m").test(text)
        || new RegExp(`^\\s+${NETCATTY_MCP_SERVER_NAME}:\\s*\\{`, "m").test(text);
    }
    if (agentKey === "opencode") {
      for (const configFile of resolveOpencodeConfigFiles(deps.env, homeDir)) {
        const text = await readTextIfPresent(configFile);
        if (text === null) continue;
        try {
          const doc = parseJsonc(text);
          if (doc?.mcp?.servers?.[NETCATTY_MCP_SERVER_NAME]) return true;
        } catch {
          // Unparsable config: fall back to a substring check for this path only.
          if (text.includes(`"${NETCATTY_MCP_SERVER_NAME}"`)) return true;
        }
      }
      return false;
    }
    // Unknown CLI target: rely on the CLI's own list output.
    try {
      const result = await runCliCommand(cliPath, ["mcp", "list"]);
      return result.exitCode === 0
        && new RegExp(`^\\s*${NETCATTY_MCP_SERVER_NAME}\\b`, "m").test(String(result.stdout || ""));
    } catch {
      return false;
    }
  }

  async function installDshProfile() {
    const paths = resolveDshPaths(deps.env, deps.homedir(), deps.dshProfile);
    const { launcherPath, discoveryFilePath } = buildLauncherContext();
    if (!launcherPath) {
      return { ok: false, state: "error", error: "Netcatty's MCP launcher path is unavailable." };
    }
    if (!(await exists(paths.profileDir))) {
      return { ok: false, state: "profile_missing", patchFile: paths.patchFile };
    }
    const current = (await readTextIfPresent(paths.patchFile)) || "";
    const next = upsertManagedBlock(current, buildDshManagedBlock({ launcherPath, discoveryFilePath }));
    await deps.fsp.writeFile(paths.patchFile, next, "utf8");
    // Read back: the block (not the write call) is what makes the row real.
    const written = (await readTextIfPresent(paths.patchFile)) || "";
    const found = findManagedBlock(written);
    const installed = Boolean(found) && found.block.trim() === buildDshManagedBlock({ launcherPath, discoveryFilePath }).trim();
    return {
      ok: installed,
      state: installed ? "installed" : "error",
      installed,
      patchFile: paths.patchFile,
      profile: paths.profile,
      error: installed ? null : "The netcatty-mcp patch block was not written to the dsh profile.",
    };
  }

  async function installCliTarget(agentKey, target) {
    const { launcherPath, discoveryFilePath } = buildLauncherContext();
    if (!launcherPath) {
      return { ok: false, state: "error", error: "Netcatty's MCP launcher path is unavailable." };
    }
    const cliPath = await resolveCli(target.cli);
    if (!cliPath) {
      return { ok: false, state: "cli_not_found", error: `Could not find the \`${target.cli}\` executable.` };
    }
    const result = await runCliCommand(
      cliPath,
      target.buildAddArgs({ launcherPath, discoveryFilePath }),
      { input: target.addInput },
    );
    if (result.exitCode !== 0) {
      return {
        ok: false,
        state: "error",
        error: summarizeCliFailure(result, `${target.cli} mcp add failed`),
      };
    }
    const installed = await isInstalledForCliTarget(agentKey, target, cliPath);
    return {
      ok: installed,
      state: installed ? "installed" : "error",
      installed,
      error: installed ? null : `${target.cli} reported success but ${NETCATTY_MCP_SERVER_NAME} is not in its config yet.`,
    };
  }

  async function install({ agentKey } = {}) {
    const key = String(agentKey || "");
    const target = AGENT_MCP_TARGETS[key];
    if (!target) {
      return { ok: false, agentKey: key, state: "unsupported", installed: false };
    }
    try {
      if (target.kind === "client-setup") {
        if (typeof deps.installClientSetup !== "function") {
          return { ok: false, agentKey: key, state: "error", installed: false, error: "Client setup is unavailable." };
        }
        const result = await deps.installClientSetup(key);
        const installed = result?.state === "configured" || result?.installed === true;
        return {
          ok: installed,
          agentKey: key,
          state: result?.state || (installed ? "installed" : "error"),
          installed,
          error: result?.error || null,
        };
      }
      const result = target.kind === "cli"
        ? await installCliTarget(key, target)
        : await installDshProfile();
      return { agentKey: key, ...result };
    } catch (error) {
      return {
        ok: false,
        agentKey: key,
        state: "error",
        installed: false,
        error: error?.message || String(error),
      };
    }
  }

  return {
    isSupported: isSupportedAgentMcpKey,
    getStatus,
    install,
  };
}

function summarizeCliFailure(result, fallback) {
  const text = String(result?.stderr || result?.stdout || "").trim();
  if (!text) return fallback;
  return text.split("\n").slice(-3).join(" ").slice(0, 300);
}

module.exports = {
  AGENT_MCP_TARGETS,
  SUPPORTED_AGENT_MCP_KEYS,
  DSH_DEFAULT_PROFILE,
  DSH_MANAGED_BLOCK_END,
  DSH_MANAGED_BLOCK_START,
  NETCATTY_MCP_SERVER_NAME,
  buildDshManagedBlock,
  createAgentMcpSetup,
  findManagedBlock,
  isSupportedAgentMcpKey,
  parseJsonc,
  resolveDshPaths,
  stripManagedBlock,
  upsertManagedBlock,
};
