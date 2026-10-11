"use strict";

/**
 * DeepSeek Harness (dsh) driver — one-shot CLI path.
 *
 * dsh (`@deepseek-ai/dsh`, https://github.com/deepseek-ai/deepseek-harness) is
 * DeepSeek's own open-source agent harness. This driver uses its `headless`
 * profile: `dsh headless "<task>"` runs the task from the session cwd, prints
 * its result and exits. stdout is streamed to the renderer as assistant text
 * and the turn finishes when the process exits.
 *
 * dsh owns its own model/provider configuration (`$DSH_HOME`, the
 * DEEPSEEK_API_KEY environment variable, or a custom provider added in its Web
 * UI), so this driver only forwards the environment it is handed — plus
 * `$DSH_HOME/env`, which a terminal launch sources but an app-spawned child
 * would otherwise miss (see readDshEnvFile).
 *
 * Model selection: dsh takes no `--model` flag, so a model chosen in Netcatty is
 * applied as a one-turn profile patch (`--patch <file>` overriding the
 * `agent-default-model` entry's `model`), which is how dsh composes profiles.
 * The user's own profile files are never touched.
 *
 * Model discovery (listDshModels) reads `dsh --profile <p> --dump-config` and
 * reports the model that profile is configured with; dsh exposes no larger
 * enumeration, so the renderer keeps its curated presets alongside it.
 *
 * Deliberately not mapped yet (minimal first step):
 * - session resume (`resumeSessionId`) — every turn is a fresh dsh run;
 * - tool-call / file-change / plan events — only text deltas are emitted;
 * - attachments;
 * - splitting the leading `dsh: reasoning:` block into a reasoning event.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");

/** Keep the tail of stderr for the error message without unbounded growth. */
const MAX_STDERR_CHARS = 8 * 1024;

/** dsh prints this label before its thinking block; it is not user content. */
const REASONING_LABEL = "dsh: reasoning:";

/**
 * dsh keeps its launch environment in `$DSH_HOME/env` (default `~/.dsh/env`),
 * which the `dsh` wrapper sources in a terminal but an app-spawned child never
 * sees. Load it so a chat turn is keyed the same way as `dsh` on the command
 * line; variables already present in the launching environment win, so an
 * explicit per-agent env in Netcatty still overrides the file.
 */
function readDshEnvFile(baseEnv = process.env) {
  const configuredHome = typeof baseEnv?.DSH_HOME === "string" ? baseEnv.DSH_HOME.trim() : "";
  const home = configuredHome || path.join(os.homedir(), ".dsh");
  let raw;
  try {
    raw = fs.readFileSync(path.join(home, "env"), "utf8");
  } catch {
    return {};
  }

  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Merge the dsh env file under the launching environment. */
function buildDshEnv(env) {
  const base = env || process.env;
  return { ...readDshEnvFile(base), ...base };
}

/** The dsh profile the app boots (`DSH_PROFILE`, default `headless`). */
function resolveDshProfile(env = process.env) {
  const configured = typeof env?.DSH_PROFILE === "string" ? env.DSH_PROFILE.trim() : "";
  return configured || "headless";
}

/**
 * Read the `agent-default-model` entry out of `dsh --profile <p> --dump-config`
 * (a YAML listing of the composed profile tree). Returns nulls when the entry or
 * its config is missing instead of throwing.
 */
function parseDshDefaultModel(raw) {
  const result = { provider: null, model: null };
  let inEntry = false;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const idMatch = /^-\s*id:\s*(\S+)\s*$/.exec(line);
    if (idMatch) {
      inEntry = idMatch[1] === "agent-default-model";
      continue;
    }
    if (!inEntry) continue;
    if (/^-\s/.test(line)) {
      inEntry = false;
      continue;
    }
    const kv = /^\s+(provider|model):\s*(.+?)\s*$/.exec(line);
    // `!!js` expressions are code, not literal ids; ignore them.
    if (kv && !kv[2].startsWith("!!")) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

/** Run a short-lived dsh command and resolve with its stdout (never rejects). */
function captureDsh(executable, args, env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const spec = prepareCommandForSpawn(executable, args);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        env: env || process.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: spec.shell,
      });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** The model/provider that profile is configured with ({} when unavailable). */
async function readDshDefaultModel({ binPath, env } = {}) {
  const executable = binPath || "dsh";
  const profile = resolveDshProfile(env);
  const out = await captureDsh(executable, ["--profile", profile, "--dump-config"], env);
  return parseDshDefaultModel(out);
}

/**
 * Catalog for the picker. dsh exposes only the active model, so that single
 * entry is the truthful answer; the renderer merges its curated presets on top
 * and a chosen preset is applied per turn through prepareDshModelPatch.
 */
async function listDshModels({ binPath, env } = {}) {
  const current = await readDshDefaultModel({ binPath, env });
  return {
    currentModelId: current.model || null,
    models: current.model ? [{ id: current.model, name: current.model }] : [],
  };
}

/** Directory for the transient one-turn profile patch file. */
function resolveDshPatchDir() {
  try {
    // Netcatty's own temp directory (AGENTS.md: never write to os.tmpdir()).
    const { getTempFilePath } = require("../../tempDirBridge.cjs");
    const file = getTempFilePath("dsh-model-patch.yml");
    if (file) return path.dirname(file);
  } catch {
    // Not running inside Electron (unit tests): fall back to an OS temp dir.
  }
  return path.join(os.tmpdir(), "netcatty-dsh");
}

/**
 * Write a one-turn profile patch overriding `agent-default-model.config.model`
 * and return `{ patchPath, profile }`. dsh replaces the entry rather than
 * merging it, so the provider is copied from the current config.
 */
async function prepareDshModelPatch({ model, binPath, env } = {}) {
  const profile = resolveDshProfile(env);
  const current = await readDshDefaultModel({ binPath, env });
  const dir = resolveDshPatchDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `dsh-model-${process.pid}-${Date.now()}.yml`);
  const lines = ["- id: agent-default-model", "  config:"];
  if (current.provider) lines.push(`    provider: ${current.provider}`);
  lines.push(`    model: ${model}`);
  await fs.promises.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { patchPath: file, profile };
}

function runDshTurn({ prompt, cwd, env, binPath, emitter, signal, patchPath, profile }) {
  return new Promise((resolve, reject) => {
    const executable = binPath || "dsh";
    // With a model override dsh is invoked explicitly (profile + patch) because
    // the `headless` shorthand takes no launcher flags; otherwise the shorthand
    // stays exactly as it was.
    const args = patchPath
      ? ["--profile", profile || resolveDshProfile(env), "--patch", patchPath, String(prompt ?? "")]
      : ["headless", String(prompt ?? "")];
    const spec = prepareCommandForSpawn(executable, args);

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: cwd || undefined,
        env: buildDshEnv(env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: spec.shell,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    let stdoutHead = "";
    let strippedLabel = false;

    const emitStdout = (chunk) => {
      if (strippedLabel) {
        emitter.text(chunk);
        return;
      }
      stdoutHead += chunk;
      // Wait for enough of the stream to decide whether the reasoning label is
      // present, then stop buffering.
      if (stdoutHead.length < REASONING_LABEL.length && REASONING_LABEL.startsWith(stdoutHead)) {
        return;
      }
      strippedLabel = true;
      const trimmed = stdoutHead.startsWith(REASONING_LABEL)
        ? stdoutHead.slice(REASONING_LABEL.length).replace(/^\r?\n/, "")
        : stdoutHead;
      stdoutHead = "";
      emitter.text(trimmed);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", emitStdout);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    const abort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process already gone.
      }
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", abort);
      if (patchPath) {
        try {
          fs.unlinkSync(patchPath);
        } catch {
          // Already removed (or never written).
        }
      }
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code, closeSignal) => {
      cleanup();
      if (stdoutHead && !strippedLabel) {
        // Stream ended before the label check completed.
        emitter.text(stdoutHead.startsWith(REASONING_LABEL)
          ? stdoutHead.slice(REASONING_LABEL.length).replace(/^\r?\n/, "")
          : stdoutHead);
        stdoutHead = "";
      }
      if (signal?.aborted) {
        resolve();
        return;
      }
      if (code === 0) {
        // The renderer's SDK turn promise only settles when the main process
        // signals "done" (see sdkAgentAdapter.onAiSdkAgentDone). Every other
        // driver emits it; skipping it left the chat composer stuck on Stop and
        // the send gate held after a perfectly successful answer.
        emitter.emitDone?.();
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(
        detail || `dsh exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}`,
      ));
    });
  });
}

module.exports = {
  runDshTurn,
  readDshEnvFile,
  buildDshEnv,
  resolveDshProfile,
  parseDshDefaultModel,
  readDshDefaultModel,
  listDshModels,
  prepareDshModelPatch,
  REASONING_LABEL,
};
