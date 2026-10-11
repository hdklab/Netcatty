"use strict";

/**
 * Hermes Agent (hermes) driver — one-shot CLI path.
 *
 * Hermes is Nous Research's agent CLI (`hermes`, https://hermes.nousresearch.com).
 * This driver uses its one-shot mode: `hermes -z "<prompt>"` sends a single
 * prompt and prints ONLY the final response text to stdout — no banner, no
 * spinner, no tool previews, no session_id line — then exits. stdout is
 * streamed to the renderer as assistant text and the turn finishes when the
 * process exits.
 *
 * Model selection: `-m <model>` is a documented Hermes flag, so the model picked
 * in Netcatty is passed per turn; without it Hermes uses its own configured
 * model (which listHermesModels reports as the current one).
 *
 * Model discovery (listHermesModels) reads Hermes' own local state only — never
 * credentials:
 *   - `$HERMES_HOME/config.yaml` (default `~/.hermes`) → the `model:` block
 *     (`default`, `provider`, `base_url`);
 *   - `$HERMES_HOME/provider_models_cache.json` →
 *     `{ "<provider>": { models: [...] } }`, the per-provider list the CLI's own
 *     model picker caches.
 * The configured model is always included, so the picker still shows something
 * truthful when the provider cache is absent or stale.
 *
 * Deliberately not mapped yet (same minimal shape as the dsh driver):
 * - session resume (`resumeSessionId`) — every turn is a fresh `hermes -z` run;
 * - tool-call / file-change / plan events — only text deltas are emitted;
 * - attachments;
 * - provider overrides (`--provider`).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");

/** Keep the tail of stderr for the error message without unbounded growth. */
const MAX_STDERR_CHARS = 8 * 1024;

/**
 * Hermes' state directory. The CLI resolves it from `HERMES_HOME`, falling back
 * to `~/.hermes` (its launcher honours the same variable).
 */
function readHermesHome(env = process.env) {
  const configured = typeof env?.HERMES_HOME === "string" ? env.HERMES_HOME.trim() : "";
  return configured || path.join(os.homedir(), ".hermes");
}

/**
 * Minimal read of the top-level `model:` block in config.yaml: it is a flat map
 * of three keys by contract, and pulling a YAML parser into the main process for
 * that would be overkill.
 */
function parseHermesModelConfig(raw) {
  const out = {};
  let inModel = false;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (/^model:\s*(?:#.*)?$/.test(line)) {
      inModel = true;
      continue;
    }
    if (!inModel) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (value) out[key] = value;
  }
  return {
    defaultModel: out.default || null,
    provider: out.provider || null,
    baseUrl: out.base_url || null,
  };
}

/** Models the CLI cached for a provider (`provider_models_cache.json`). */
function readHermesProviderModels(home, provider) {
  if (!provider) return [];
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, "provider_models_cache.json"), "utf8"),
    );
    const models = parsed?.[provider]?.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
  } catch {
    return [];
  }
}

/** Catalog for the picker: cached provider models, configured model first. */
function listHermesModels({ env = process.env } = {}) {
  const home = readHermesHome(env);
  let config = { defaultModel: null, provider: null, baseUrl: null };
  try {
    config = parseHermesModelConfig(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
  } catch {
    // No config yet: Hermes would use its own defaults.
  }

  const ids = [];
  if (config.defaultModel) ids.push(config.defaultModel);
  for (const id of readHermesProviderModels(home, config.provider)) {
    if (!ids.includes(id)) ids.push(id);
  }

  return {
    currentModelId: config.defaultModel,
    models: ids.map((id) => ({ id, name: id })),
  };
}

function runHermesTurn({ prompt, cwd, env, binPath, emitter, signal, model }) {
  return new Promise((resolve, reject) => {
    const executable = binPath || "hermes";
    const args = [];
    // Documented flag: `hermes -m <model>`.
    if (model) args.push("-m", String(model));
    args.push("-z", String(prompt ?? ""));
    const spec = prepareCommandForSpawn(executable, args);

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: cwd || undefined,
        env: env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: spec.shell,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => emitter.text(chunk));

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
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code, closeSignal) => {
      cleanup();
      if (signal?.aborted) {
        resolve();
        return;
      }
      if (code === 0) {
        // Drivers own the renderer-side "done" IPC; without it the SDK turn
        // promise never settles and the composer stays on Stop after a
        // successful answer.
        emitter.emitDone?.();
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(
        detail || `hermes exited with ${closeSignal ? `signal ${closeSignal}` : `code ${code}`}`,
      ));
    });
  });
}

module.exports = {
  runHermesTurn,
  readHermesHome,
  parseHermesModelConfig,
  readHermesProviderModels,
  listHermesModels,
};
