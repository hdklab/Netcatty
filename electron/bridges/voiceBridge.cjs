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

function runProcess(command, args, { timeoutMs, cwd, requestId } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
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
 * Find the first interpreter that carries the voice stack. The renderer keeps the
 * result, so this stays a cheap one-shot discovery instead of a per-turn cost.
 */
async function probe({ pythonPath } = {}) {
  const candidates = resolvePythonCandidates({ pythonPath });
  const results = [];
  for (const candidate of candidates) {
    const report = await probePython(candidate);
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

async function transcribe(payload = {}) {
  const requestId = resolveRequestId(payload);
  const pythonPath = String(payload.pythonPath || "").trim()
    || resolvePythonCandidates({})[0];
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

  try {
    const args = [
      STT_WORKER,
      audioFile,
      String(payload.model || "small"),
      String(payload.language || "zh"),
      String(payload.device || "cpu"),
      String(payload.computeType || "int8"),
    ];
    const result = await runProcess(pythonPath, args, {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      requestId,
      cwd: tempDir,
    });
    const parsed = parseWorkerOutput(result.stdout);
    if (!parsed) {
      return {
        ok: false,
        error: (result.stderr || "The transcription worker produced no output.").trim().slice(0, 600),
      };
    }
    if (!parsed.ok) return { ok: false, error: String(parsed.error || "Transcription failed.") };
    return {
      ok: true,
      transcript: String(parsed.transcript || "").trim(),
      language: parsed.language ?? null,
      duration: parsed.duration ?? null,
    };
  } finally {
    safeUnlink(audioFile);
  }
}

async function synthesize(payload = {}) {
  const requestId = resolveRequestId(payload);
  const pythonPath = String(payload.pythonPath || "").trim()
    || resolvePythonCandidates({})[0];
  const text = String(payload.text || "").trim();
  if (!text) return { ok: false, error: "Nothing to speak." };
  if (text.length > MAX_TTS_CHARS) return { ok: false, error: "Text is too long to speak in one clip." };

  const tempDir = payload.tempDir || os.tmpdir();
  const textFile = writeTempFile(tempDir, "tts", "txt");
  const mediaFile = writeTempFile(tempDir, "tts", "mp3");
  try {
    fs.writeFileSync(textFile, text, "utf8");
    const args = buildSynthesizeArgs({
      text,
      voice: String(payload.voice || "zh-CN-XiaoxiaoNeural"),
      rate: String(payload.rate || "+0%"),
      textFile,
      mediaFile,
    });
    const result = await runProcess(pythonPath, args, {
      timeoutMs: SYNTHESIZE_TIMEOUT_MS,
      requestId,
      cwd: tempDir,
    });
    if (!result.ok) {
      return { ok: false, error: (result.stderr || `edge-tts exited with code ${result.code}`).trim().slice(0, 600) };
    }
    const audio = fs.readFileSync(mediaFile);
    if (!audio.length) return { ok: false, error: "edge-tts produced no audio." };
    return { ok: true, audio: audio.toString("base64"), mimeType: "audio/mpeg" };
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

function registerHandlers(ipcMain, { getTempDir } = {}) {
  const tempDirFor = () => {
    try {
      const dir = getTempDir?.();
      if (dir) return dir;
    } catch {
      // fall through to the OS default
    }
    return os.tmpdir();
  };

  ipcMain.handle("netcatty:voice:probe", async (_event, payload = {}) => probe(payload));

  ipcMain.handle("netcatty:voice:transcribe", async (_event, payload = {}) => {
    try {
      return await transcribe({ ...payload, tempDir: tempDirFor() });
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("netcatty:voice:synthesize", async (_event, payload = {}) => {
    try {
      return await synthesize({ ...payload, tempDir: tempDirFor() });
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
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
  // pure helpers (unit-tested)
  pickAudioExtension,
  buildSynthesizeArgs,
  parseWorkerOutput,
  resolvePythonCandidates,
};
