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

function runDshTurn({ prompt, cwd, env, binPath, emitter, signal }) {
  return new Promise((resolve, reject) => {
    const executable = binPath || "dsh";
    const spec = prepareCommandForSpawn(executable, ["headless", String(prompt ?? "")]);

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
  REASONING_LABEL,
};
