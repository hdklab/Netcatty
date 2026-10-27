/**
 * Voice Bridge - local speech input and spoken replies for the in-app agent.
 *
 * Mirrors the Hermes voice stack: one Python environment that carries
 * `faster-whisper` (STT) and `edge-tts` (TTS). The renderer records the mic
 * clip, this bridge transcribes it, and synthesizes reply audio back as MP3.
 *
 * Channels:
 *   netcatty:voice:probe      -> { ok, python, stt, tts, candidates }
 *   netcatty:voice:transcribe -> { ok, transcript, error }
 *   netcatty:voice:synthesize -> { ok, audio (base64), mimeType, error }
 *   netcatty:voice:cancel     -> boolean
 *
 * Everything the renderer sends is treated as untrusted input: sizes are
 * capped, commands are never built from strings, and no shell is involved.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TTS_CHARS = 4000;
const PROBE_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const SYNTHESIZE_TIMEOUT_MS = 60_000;

const VOICE_SCRIPT_DIR = path.join(__dirname, "..", "voice");

/**
 * Packaged builds keep these scripts inside app.asar, which Python cannot read.
 * electron-builder's `asarUnpack` writes them to app.asar.unpacked, so rewrite
 * the path whenever the app runs from an archive.
 */
function resolveWorkerScript(fileName) {
  const packed = path.join(VOICE_SCRIPT_DIR, fileName);
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!packed.includes(marker)) return packed;
  const unpacked = packed.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  try {
    if (fs.statSync(unpacked).isFile()) return unpacked;
  } catch {
    // fall through to the packed path so the error mentions the real location
  }
  return packed;
}

const PROBE_WORKER = resolveWorkerScript("probe_worker.py");
const STT_WORKER = resolveWorkerScript("stt_worker.py");

const AUDIO_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

/** Active child processes, keyed by renderer request id, so a cancel can kill them. */
const activeChildren = new Map();

function pickAudioExtension(mimeType) {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[normalized] || "webm";
}

function buildSynthesizeArgs({ text, voice, rate, textFile, mediaFile }) {
  return [
    "-m",
    "edge_tts",
    "--file",
    textFile,
    "--voice",
    voice,
    "--rate",
    rate || "+0%",
    "--write-media",
    mediaFile,
    "--no-progress",
  ];
}

/** The worker may emit library warnings before its JSON line; take the last one. */
function parseWorkerOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // keep looking upward
    }
  }
  return null;
}

function resolveHermesPythonCandidates(homeDir) {
  const candidates = [];
  const installsDir = path.join(homeDir, ".hermes", "installs");
  let installIds = [];
  try {
    installIds = fs.readdirSync(installsDir);
  } catch {
    return candidates;
  }
  for (const installId of installIds) {
    const environmentsDir = path.join(installsDir, installId, "environments");
    let envHashes = [];
    try {
      envHashes = fs.readdirSync(environmentsDir);
    } catch {
      continue;
    }
    for (const envHash of envHashes) {
      const venvPython = path.join(environmentsDir, envHash, "venv", "bin", "python");
      try {
        if (fs.statSync(venvPython).isFile()) candidates.push(venvPython);
      } catch {
        // not a POSIX venv layout
      }
      const winPython = path.join(environmentsDir, envHash, "venv", "Scripts", "python.exe");
      try {
        if (fs.statSync(winPython).isFile()) candidates.push(winPython);
      } catch {
        // windows venv layout does not exist here
      }
    }
  }
  return candidates;
}

/** Ordered, de-duplicated interpreter candidates: explicit setting first, then Hermes, then PATH. */
function resolvePythonCandidates({ pythonPath, homeDir = os.homedir(), env = process.env } = {}) {
  const ordered = [];
  const push = (value) => {
    const trimmed = String(value || "").trim();
    if (trimmed && !ordered.includes(trimmed)) ordered.push(trimmed);
  };
  push(pythonPath);
  push(env.NETCATTY_VOICE_PYTHON);
  for (const candidate of resolveHermesPythonCandidates(homeDir)) push(candidate);
  push("python3");
  push("python");
  return ordered;
}

/**
 * Child environment for every Python we spawn. A PYTHONPATH inherited from the
 * launching shell (Hermes sets one) makes the managed venv import packages it does
 * not own — and pip then reports them "already satisfied" instead of installing.
 */
function pythonChildEnv() {
  const env = { ...process.env };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return env;
}

function runProcess(command, args, { timeoutMs, cwd, requestId, onData } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: pythonChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    if (requestId) activeChildren.set(String(requestId), child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (requestId && activeChildren.get(String(requestId)) === child) {
        activeChildren.delete(String(requestId));
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, code: -2, stdout, stderr: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onData?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onData?.(text);
    });
    child.once("error", (error) => {
      finish({ ok: false, code: -1, stdout, stderr: String(error?.message || error) });
    });
    child.once("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function probePython(pythonPath) {
  const result = await runProcess(pythonPath, [PROBE_WORKER], { timeoutMs: PROBE_TIMEOUT_MS });
  const parsed = parseWorkerOutput(result.stdout);
  return {
    python: pythonPath,
    ok: Boolean(parsed && (parsed.faster_whisper || parsed.edge_tts)),
    stt: parsed?.faster_whisper ?? null,
    tts: parsed?.edge_tts ?? null,
    error: parsed ? undefined : (result.stderr || "probe failed").trim().slice(0, 400),
  };
}

/**
 * Probe verdicts per interpreter, so one mic click does not re-spawn Python for
 * every candidate and an auto-detected engine is reused across turns.
 */
const ENGINE_PROBE_CACHE_LIMIT = 16;
const ENGINE_ATTEMPTS = 4;
const probedEngines = new Map();

function rememberProbe(report) {
  if (report?.python) {
    if (!probedEngines.has(report.python) && probedEngines.size >= ENGINE_PROBE_CACHE_LIMIT) {
      const oldest = probedEngines.keys().next();
      if (!oldest.done) probedEngines.delete(oldest.value);
    }
    probedEngines.set(report.python, report);
  }
  return report;
}

function forgetProbe(pythonPath) {
  probedEngines.delete(String(pythonPath || ""));
}

/**
 * Did the worker fail because this interpreter lacks the module, rather than
 * because the audio or the model was bad? Only that answer justifies trying the
 * next candidate instead of surfacing the error.
 */
function isMissingCapabilityError(message) {
  const text = String(message || "");
  return /No module named '?(faster_whisper|edge_tts)'?/i.test(text)
    || /^(faster_whisper|edge_tts) unavailable/i.test(text.trim());
}

/**
 * Pure selection over known verdicts: an explicit setting always wins (the user
 * overrode auto-detect), otherwise the first candidate whose verdict proves the
 * capability the caller actually needs. `stt` and `tts` live in different
 * environments often enough that "has either" is not good enough.
 */
function pickEnginePython({ pythonPath, capability, candidates = [], verdicts = new Map(), exclude } = {}) {
  const explicit = String(pythonPath || "").trim();
  if (explicit) return explicit;
  for (const candidate of candidates) {
    if (exclude?.has(candidate)) continue;
    const verdict = verdicts.get(candidate);
    if (verdict && verdict[capability]) return candidate;
  }
  return null;
}

/**
 * Resolve the interpreter for one capability, probing candidates in order until
 * one proves it. Returns null when nothing qualifies, so the caller reports a
 * missing engine instead of running the wrong Python and mislabelling the error.
 */
async function resolveVoicePython({
  pythonPath,
  capability,
  exclude,
  candidates,
  probeCandidate = probePython,
} = {}) {
  const explicit = String(pythonPath || "").trim();
  if (explicit) return explicit;
  const ordered = candidates || resolvePythonCandidates({});
  const known = pickEnginePython({ capability, candidates: ordered, verdicts: probedEngines, exclude });
  if (known) return known;
  for (const candidate of ordered) {
    if (exclude?.has(candidate) || probedEngines.has(candidate)) continue;
    const verdict = rememberProbe(await probeCandidate(candidate));
    if (verdict[capability]) return candidate;
  }
  return null;
}

/**
 * Managed voice engine: Netcatty's own venv with faster-whisper + edge-tts, so a
 * machine without a Hermes install (or without either package anywhere) can still
 * dictate. Installed on demand, never silently during a plain probe.
 */
const VOICE_ENV_DIR_NAME = "voice-engine";
const VOICE_PACKAGES = [
  "faster-whisper",
  "edge-tts",
  // faster-whisper's decoder calls av.open(..., metadata_errors="ignore") and av 19
  // dropped that keyword, so the newest av fails every clip with
  // "open() got an unexpected keyword argument 'metadata_errors'".
  "av<19",
];
const VENV_TIMEOUT_MS = 180_000;
const PIP_INSTALL_TIMEOUT_MS = 15 * 60_000;
/** One install at a time: a second mic click joins the running one instead of racing pip. */
let installInFlight = null;

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function managedEnvDir(getDataDir) {
  const base = String(getDataDir?.() || "").trim();
  return base ? path.join(base, VOICE_ENV_DIR_NAME) : "";
}

function managedEnvPython(envDir) {
  if (!envDir) return "";
  return process.platform === "win32"
    ? path.join(envDir, "Scripts", "python.exe")
    : path.join(envDir, "bin", "python");
}

function buildVenvCreateArgs(envDir) {
  return ["-m", "venv", "--clear", envDir];
}

function buildPipInstallArgs(packages = VOICE_PACKAGES) {
  return [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    "--upgrade",
    ...packages,
  ];
}

/**
 * pip streams download/pip warnings continuously; the settings panel only has room
 * for one line, so keep the last meaningful fragment of a chunk.
 */
function summarizeInstallLine(text) {
  const lines = String(text || "")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const cleaned = last.replace(/\s+/g, " ").slice(0, 160);
  // Download bars ("━━━━ 47%") and blank frames carry no information for a label.
  if ((cleaned.match(/[A-Za-z]/g) || []).length < 2) return null;
  return cleaned;
}

/**
 * Install (once) and return the managed interpreter. Shared by the explicit
 * Settings button and the "nothing to transcribe with" path.
 */
async function ensureVoiceEngine({ getDataDir, onProgress, requestId, packages = VOICE_PACKAGES } = {}) {
  const envDir = managedEnvDir(getDataDir);
  if (!envDir) throw new Error("Netcatty has no data directory to install the voice engine into.");
  const envPython = managedEnvPython(envDir);
  const report = (stage, message) => {
    try {
      onProgress?.({ stage, message });
    } catch {
      // a dead renderer must not fail the install
    }
  };

  if (isRegularFile(envPython)) {
    const verdict = rememberProbe(await probePython(envPython));
    if (verdict.stt && verdict.tts) return envPython;
  }
  if (installInFlight) return installInFlight;

  installInFlight = (async () => {
    if (!isRegularFile(envPython)) {
      const failures = [];
      for (const base of resolvePythonCandidates({})) {
        report("venv", base);
        const created = await runProcess(base, buildVenvCreateArgs(envDir), {
          timeoutMs: VENV_TIMEOUT_MS,
          requestId,
        });
        if (created.ok && isRegularFile(envPython)) {
          failures.length = 0;
          break;
        }
        failures.push(`${base}: ${(created.stderr || `exit ${created.code}`).trim().slice(0, 200)}`);
      }
      if (!isRegularFile(envPython)) {
        throw new Error(`Could not create a Python environment (${failures.join("; ") || "no interpreter found"}).`);
      }
    }
    report("install", packages.join(" "));
    const installed = await runProcess(envPython, buildPipInstallArgs(packages), {
      timeoutMs: PIP_INSTALL_TIMEOUT_MS,
      requestId,
      onData: (chunk) => {
        const message = summarizeInstallLine(chunk);
        if (message) report("install", message);
      },
    });
    if (!installed.ok) {
      throw new Error((installed.stderr || installed.stdout || "pip install failed").trim().slice(0, 400));
    }
    report("verify", envPython);
    const verdict = rememberProbe(await probePython(envPython));
    if (!verdict.ok) {
      throw new Error(verdict.error || "the new environment could not import faster-whisper or edge-tts.");
    }
    return envPython;
  })().finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

/**
 * Candidate order for auto-detect: Netcatty's managed engine first (it is the one we
 * control), then whatever the user's machine already has.
 */
function voiceEngineCandidates(getDataDir) {
  const managed = managedEnvPython(managedEnvDir(getDataDir));
  const ordered = resolvePythonCandidates({});
  // Only offer the managed interpreter once it exists: probing a missing path
  // would add a bogus "failed" candidate to every Settings check.
  return managed && isRegularFile(managed) && !ordered.includes(managed) ? [managed, ...ordered] : ordered;
}

/**
 * Find the first interpreter that carries the voice stack. The renderer keeps the
 * result, so this stays a cheap one-shot discovery instead of a per-turn cost.
 */
async function probe({ pythonPath } = {}, { getDataDir } = {}) {
  const candidates = String(pythonPath || "").trim()
    ? resolvePythonCandidates({ pythonPath })
    : voiceEngineCandidates(getDataDir);
  const results = [];
  for (const candidate of candidates) {
    const report = rememberProbe(await probePython(candidate));
    results.push(report);
    if (report.ok && report.stt && report.tts) {
      return { ok: true, ...report, candidates: results };
    }
  }
  const partial = results.find((entry) => entry.ok);
  if (partial) return { ok: false, ...partial, candidates: results };
  return {
    ok: false,
    python: null,
    stt: null,
    tts: null,
    error: results.find((entry) => entry.error)?.error || "No Python environment with faster-whisper and edge-tts was found.",
    candidates: results,
  };
}

function resolveRequestId(payload) {
  const raw = String(payload?.requestId || "").trim();
  return raw || crypto.randomUUID();
}

function writeTempFile(directory, prefix, extension) {
  const name = `voice-${prefix}-${crypto.randomBytes(6).toString("hex")}.${extension}`;
  return path.join(directory, name);
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

async function transcribe(payload = {}, { getDataDir, onProgress } = {}) {
  const requestId = resolveRequestId(payload);
  const explicitPython = String(payload.pythonPath || "").trim();
  const base64 = String(payload.audioBase64 || "");
  if (!base64) return { ok: false, error: "No audio was recorded." };

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return { ok: false, error: "No audio was recorded." };
  if (buffer.length > MAX_AUDIO_BYTES) return { ok: false, error: "Audio clip is too large." };

  const tempDir = payload.tempDir || os.tmpdir();
  const extension = pickAudioExtension(payload.mimeType);
  const audioFile = writeTempFile(tempDir, "stt", extension);
  try {
    fs.writeFileSync(audioFile, buffer);
  } catch (error) {
    return { ok: false, error: `Could not stage the audio clip: ${error?.message || error}` };
  }

  const args = [
    STT_WORKER,
    audioFile,
    String(payload.model || "small"),
    String(payload.language || "zh"),
    String(payload.device || "cpu"),
    String(payload.computeType || "int8"),
  ];
  const attempted = new Set();
  let failure = null;
  let autoInstalled = false;
  try {
    // Auto-detect picks the interpreter that actually carries faster-whisper;
    // taking the first candidate in PATH order transcribed with whatever Python
    // happened to be there and surfaced "faster_whisper unavailable".
    for (let attempt = 0; attempt < ENGINE_ATTEMPTS; attempt += 1) {
      let pythonPath = explicitPython
        || await resolveVoicePython({
          capability: "stt",
          exclude: attempted,
          candidates: voiceEngineCandidates(getDataDir),
        });
      if (!pythonPath && !explicitPython && !autoInstalled && payload.autoInstall !== false) {
        // Nothing on this machine can transcribe: install the managed engine and
        // use it, so the first mic click works instead of failing.
        autoInstalled = true;
        try {
          pythonPath = await ensureVoiceEngine({ getDataDir, onProgress, requestId });
        } catch (error) {
          failure = `Could not install the voice engine: ${error?.message || error}`;
          break;
        }
      }
      if (!pythonPath || attempted.has(pythonPath)) break;
      attempted.add(pythonPath);
      const result = await runProcess(pythonPath, args, {
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        requestId,
        cwd: tempDir,
      });
      const parsed = parseWorkerOutput(result.stdout);
      if (!parsed) {
        // The worker itself failed (crash, timeout): a different interpreter is
        // not the answer, so report the stderr as-is.
        failure = (result.stderr || "The transcription worker produced no output.").trim().slice(0, 600);
        break;
      }
      if (parsed.ok) {
        return {
          ok: true,
          transcript: String(parsed.transcript || "").trim(),
          language: parsed.language ?? null,
          duration: parsed.duration ?? null,
        };
      }
      failure = String(parsed.error || "Transcription failed.");
      if (explicitPython || !isMissingCapabilityError(failure)) break;
      // This interpreter has no faster-whisper: drop the verdict and try the next.
      forgetProbe(pythonPath);
    }
    return { ok: false, error: failure || "No Python environment with faster-whisper was found." };
  } finally {
    safeUnlink(audioFile);
  }
}

async function synthesize(payload = {}, { getDataDir, onProgress } = {}) {
  const requestId = resolveRequestId(payload);
  const explicitPython = String(payload.pythonPath || "").trim();
  const text = String(payload.text || "").trim();
  if (!text) return { ok: false, error: "Nothing to speak." };
  if (text.length > MAX_TTS_CHARS) return { ok: false, error: "Text is too long to speak in one clip." };

  const tempDir = payload.tempDir || os.tmpdir();
  const textFile = writeTempFile(tempDir, "tts", "txt");
  const mediaFile = writeTempFile(tempDir, "tts", "mp3");
  const attempted = new Set();
  let failure = null;
  let autoInstalled = false;
  try {
    fs.writeFileSync(textFile, text, "utf8");
    const args = buildSynthesizeArgs({
      text,
      voice: String(payload.voice || "zh-CN-XiaoxiaoNeural"),
      rate: String(payload.rate || "+0%"),
      textFile,
      mediaFile,
    });
    for (let attempt = 0; attempt < ENGINE_ATTEMPTS; attempt += 1) {
      let pythonPath = explicitPython
        || await resolveVoicePython({
          capability: "tts",
          exclude: attempted,
          candidates: voiceEngineCandidates(getDataDir),
        });
      if (!pythonPath && !explicitPython && !autoInstalled && payload.autoInstall !== false) {
        autoInstalled = true;
        try {
          pythonPath = await ensureVoiceEngine({ getDataDir, onProgress, requestId });
        } catch (error) {
          failure = `Could not install the voice engine: ${error?.message || error}`;
          break;
        }
      }
      if (!pythonPath || attempted.has(pythonPath)) break;
      attempted.add(pythonPath);
      const result = await runProcess(pythonPath, args, {
        timeoutMs: SYNTHESIZE_TIMEOUT_MS,
        requestId,
        cwd: tempDir,
      });
      if (result.ok) {
        const audio = fs.readFileSync(mediaFile);
        if (!audio.length) return { ok: false, error: "edge-tts produced no audio." };
        return { ok: true, audio: audio.toString("base64"), mimeType: "audio/mpeg" };
      }
      failure = (result.stderr || `edge-tts exited with code ${result.code}`).trim().slice(0, 600);
      if (explicitPython || !isMissingCapabilityError(failure)) break;
      forgetProbe(pythonPath);
    }
    return {
      ok: false,
      error: failure || "No Python environment with edge-tts was found.",
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    safeUnlink(textFile);
    safeUnlink(mediaFile);
  }
}

function cancel(requestId) {
  const child = activeChildren.get(String(requestId || ""));
  if (!child) return false;
  activeChildren.delete(String(requestId));
  try {
    child.kill("SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function registerHandlers(ipcMain, { getTempDir, getDataDir } = {}) {
  const tempDirFor = () => {
    try {
      const dir = getTempDir?.();
      if (dir) return dir;
    } catch {
      // fall through to the OS default
    }
    return os.tmpdir();
  };
  /** Install progress goes to the renderer that asked, so a slow first run is visible. */
  const progressFor = (sender) => (progress) => {
    try {
      sender?.send?.("netcatty:voice:install-progress", progress);
    } catch {
      // window closed mid-install
    }
  };

  ipcMain.handle("netcatty:voice:probe", async (_event, payload = {}) => probe(payload, { getDataDir }));

  ipcMain.handle("netcatty:voice:transcribe", async (event, payload = {}) => {
    try {
      return await transcribe({ ...payload, tempDir: tempDirFor() }, {
        getDataDir,
        onProgress: progressFor(event?.sender),
      });
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("netcatty:voice:synthesize", async (event, payload = {}) => {
    try {
      return await synthesize({ ...payload, tempDir: tempDirFor() }, {
        getDataDir,
        onProgress: progressFor(event?.sender),
      });
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("netcatty:voice:install", async (event, payload = {}) => {
    const requestId = resolveRequestId(payload);
    const onProgress = progressFor(event?.sender);
    try {
      const python = await ensureVoiceEngine({ getDataDir, onProgress, requestId });
      const report = await probe({ pythonPath: python }, { getDataDir });
      return {
        ok: Boolean(report.ok),
        python,
        stt: report.stt ?? null,
        tts: report.tts ?? null,
        error: report.error,
      };
    } catch (error) {
      return { ok: false, python: null, stt: null, tts: null, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("netcatty:voice:cancel", async (_event, payload = {}) => (
    cancel(payload?.requestId)
  ));
}

module.exports = {
  registerHandlers,
  probe,
  transcribe,
  synthesize,
  cancel,
  install: ensureVoiceEngine,
  // pure helpers (unit-tested)
  pickAudioExtension,
  buildSynthesizeArgs,
  parseWorkerOutput,
  resolvePythonCandidates,
  pickEnginePython,
  resolveVoicePython,
  isMissingCapabilityError,
  buildVenvCreateArgs,
  buildPipInstallArgs,
  summarizeInstallLine,
  managedEnvDir,
  managedEnvPython,
  voiceEngineCandidates,
};
