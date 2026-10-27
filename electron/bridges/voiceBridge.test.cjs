const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSynthesizeArgs,
  parseWorkerOutput,
  pickAudioExtension,
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
  install,
} = require("./voiceBridge.cjs");

test("pickAudioExtension maps recorder mime types, ignoring parameters", () => {
  assert.equal(pickAudioExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(pickAudioExtension("audio/ogg;codecs=opus"), "ogg");
  assert.equal(pickAudioExtension("audio/wav"), "wav");
  assert.equal(pickAudioExtension("AUDIO/MPEG"), "mp3");
  // Unknown or missing types fall back to the recorder default.
  assert.equal(pickAudioExtension("application/octet-stream"), "webm");
  assert.equal(pickAudioExtension(undefined), "webm");
});

test("buildSynthesizeArgs never puts the spoken text on the command line", () => {
  const args = buildSynthesizeArgs({
    text: "你好，世界",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+10%",
    textFile: "/tmp/voice-tts-abc.txt",
    mediaFile: "/tmp/voice-tts-abc.mp3",
  });
  assert.deepEqual(args, [
    "-m",
    "edge_tts",
    "--file",
    "/tmp/voice-tts-abc.txt",
    "--voice",
    "zh-CN-XiaoxiaoNeural",
    "--rate",
    "+10%",
    "--write-media",
    "/tmp/voice-tts-abc.mp3",
    "--no-progress",
  ]);
  assert.equal(args.some((arg) => arg.includes("你好")), false);
});

test("buildSynthesizeArgs defaults the rate when the setting is empty", () => {
  const args = buildSynthesizeArgs({
    text: "x",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "",
    textFile: "t.txt",
    mediaFile: "t.mp3",
  });
  assert.equal(args[args.indexOf("--rate") + 1], "+0%");
});

test("parseWorkerOutput takes the last JSON line and ignores chatter", () => {
  const stdout = [
    "warning: something chatty",
    '{"ok": true, "transcript": "older"}',
    "another warning",
    '{"ok": true, "transcript": "你好", "language": "zh"}',
    "",
  ].join("\n");
  assert.deepEqual(parseWorkerOutput(stdout), {
    ok: true,
    transcript: "你好",
    language: "zh",
  });
});

test("parseWorkerOutput returns null when the worker crashed before printing", () => {
  assert.equal(parseWorkerOutput("Traceback (most recent call last):\n  ..."), null);
  assert.equal(parseWorkerOutput(""), null);
  assert.equal(parseWorkerOutput('{"broken": '), null);
});

test("resolvePythonCandidates prefers the explicit setting, then the env var, then Hermes", () => {
  const candidates = resolvePythonCandidates({
    pythonPath: "/custom/python",
    homeDir: "/home/tester",
    env: { NETCATTY_VOICE_PYTHON: "/env/python" },
  });
  assert.equal(candidates[0], "/custom/python");
  assert.equal(candidates[1], "/env/python");
  // PATH fallbacks are always present so auto-detect can still succeed.
  assert.ok(candidates.includes("python3"));
  assert.ok(candidates.includes("python"));
  assert.equal(new Set(candidates).size, candidates.length);
});

test("resolvePythonCandidates de-duplicates identical interpreter paths", () => {
  const candidates = resolvePythonCandidates({
    pythonPath: "python3",
    homeDir: "/home/tester",
    env: {},
  });
  assert.equal(candidates.filter((entry) => entry === "python3").length, 1);
});

test("pickEnginePython prefers the explicit setting over any verdict", () => {
  const candidates = ["/venv/a/python", "/venv/b/python"];
  const verdicts = new Map([["/venv/b/python", { python: "/venv/b/python", ok: true, stt: "1.2.1", tts: "7.3.1" }]]);
  assert.equal(pickEnginePython({ pythonPath: "/custom/python", capability: "stt", candidates, verdicts }), "/custom/python");
});

test("pickEnginePython selects per capability instead of first-in-PATH", () => {
  // The first Hermes generation carries only edge-tts; transcription must skip it.
  const candidates = ["/venv/tts-only/python", "/venv/voice/python"];
  const verdicts = new Map([
    ["/venv/tts-only/python", { python: "/venv/tts-only/python", ok: true, stt: null, tts: "7.3.1" }],
    ["/venv/voice/python", { python: "/venv/voice/python", ok: true, stt: "1.2.1", tts: "7.3.1" }],
  ]);
  assert.equal(pickEnginePython({ capability: "stt", candidates, verdicts }), "/venv/voice/python");
  assert.equal(pickEnginePython({ capability: "tts", candidates, verdicts }), "/venv/tts-only/python");
});

test("pickEnginePython skips excluded and unproven candidates", () => {
  const candidates = ["/venv/voice/python", "python3"];
  const verdicts = new Map([["/venv/voice/python", { python: "/venv/voice/python", ok: true, stt: "1.2.1", tts: null }]]);
  assert.equal(pickEnginePython({ capability: "stt", candidates, verdicts, exclude: new Set(["/venv/voice/python"]) }), null);
  assert.equal(pickEnginePython({ capability: "stt", candidates: [], verdicts }), null);
});

test("resolveVoicePython probes in order until one carries the capability", async () => {
  const candidates = ["/probe/tts-only/python", "/probe/voice/python", "/probe/never/python"];
  const probed = [];
  const probeCandidate = async (python) => {
    probed.push(python);
    if (python === "/probe/never/python") throw new Error("must not be probed once a match is found");
    const stt = python === "/probe/voice/python" ? "1.2.1" : null;
    return { python, ok: true, stt, tts: "7.3.1" };
  };
  const resolved = await resolveVoicePython({ capability: "stt", candidates, probeCandidate });
  assert.equal(resolved, "/probe/voice/python");
  assert.deepEqual(probed, ["/probe/tts-only/python", "/probe/voice/python"]);
});

test("resolveVoicePython returns null when nothing carries the capability", async () => {
  const resolved = await resolveVoicePython({
    capability: "stt",
    candidates: ["/probe/only-tts/python"],
    probeCandidate: async (python) => ({ python, ok: true, stt: null, tts: "7.3.1" }),
  });
  assert.equal(resolved, null);
});

test("resolveVoicePython honours an explicit interpreter without probing", async () => {
  let probed = false;
  const resolved = await resolveVoicePython({
    pythonPath: "/explicit/python",
    capability: "stt",
    candidates: ["/probe/voice/python"],
    probeCandidate: async () => {
      probed = true;
      return { python: "x", ok: true, stt: "1", tts: "1" };
    },
  });
  assert.equal(resolved, "/explicit/python");
  assert.equal(probed, false);
});

test("isMissingCapabilityError only flags a missing module, not bad audio", () => {
  assert.equal(isMissingCapabilityError("faster_whisper unavailable: No module named 'faster_whisper'"), true);
  assert.equal(isMissingCapabilityError("/usr/bin/python3: No module named edge_tts"), true);
  assert.equal(
    isMissingCapabilityError("[Errno 1094995529] Invalid data found when processing input: '/tmp/a.wav'"),
    false,
  );
  assert.equal(isMissingCapabilityError("CUDA out of memory"), false);
  assert.equal(isMissingCapabilityError(""), false);
});

test("the managed engine lives under the app data directory, never a temp dir", () => {
  assert.equal(managedEnvDir(() => "/data/netcatty"), "/data/netcatty/voice-engine");
  assert.equal(managedEnvDir(() => ""), "");
  assert.equal(managedEnvPython(""), "");
  const python = managedEnvPython("/data/netcatty/voice-engine");
  if (process.platform === "win32") assert.match(python, /Scripts[\\/]python\.exe$/);
  else assert.match(python, /bin\/python$/);
});

test("voiceEngineCandidates puts the managed engine first without dropping the rest", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-voice-cand-"));
  try {
    const candidatesBefore = voiceEngineCandidates(() => dataDir);
    assert.equal(candidatesBefore.some((entry) => entry.startsWith(dataDir)), false);
    // Once the managed venv exists it leads the list.
    const managedPython = managedEnvPython(managedEnvDir(() => dataDir));
    fs.mkdirSync(path.dirname(managedPython), { recursive: true });
    fs.writeFileSync(managedPython, "");
    const candidates = voiceEngineCandidates(() => dataDir);
    assert.equal(candidates[0], managedPython);
    assert.ok(candidates.includes("python3"));
    assert.equal(new Set(candidates).size, candidates.length);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  // No data directory: plain discovery order, no empty entry.
  assert.deepEqual(voiceEngineCandidates(() => ""), resolvePythonCandidates({}));
});

test("venv creation and pip install run without a shell and never take a prompt", () => {
  assert.deepEqual(buildVenvCreateArgs("/data/voice-engine"), ["-m", "venv", "--clear", "/data/voice-engine"]);
  const pip = buildPipInstallArgs();
  assert.deepEqual(pip.slice(0, 3), ["-m", "pip", "install"]);
  assert.ok(pip.includes("--no-input"));
  assert.ok(pip.includes("--disable-pip-version-check"));
  assert.ok(pip.includes("faster-whisper"));
  assert.ok(pip.includes("edge-tts"));
  // av 19 breaks faster-whisper's decoder, so the install pins it down.
  assert.ok(pip.includes("av<19"));
  assert.deepEqual(buildPipInstallArgs(["edge-tts"]).slice(-1), ["edge-tts"]);
});

test("summarizeInstallLine keeps one meaningful line and drops progress noise", () => {
  assert.equal(summarizeInstallLine("Collecting faster-whisper"), "Collecting faster-whisper");
  assert.equal(
    summarizeInstallLine("Installing collected packages: av\rSuccessfully installed av-12.0.0\r"),
    "Successfully installed av-12.0.0",
  );
  assert.equal(summarizeInstallLine("   \n\t\n"), null);
  assert.equal(summarizeInstallLine("━━━━━━━━━━ 100%"), null);
  assert.equal(summarizeInstallLine("x".repeat(400)).length, 160);
});

test("install refuses to run without a data directory", async () => {
  await assert.rejects(
    () => install({ getDataDir: () => "" }),
    /no data directory to install the voice engine into/,
  );
});
