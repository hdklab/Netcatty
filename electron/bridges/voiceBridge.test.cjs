const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSynthesizeArgs,
  parseWorkerOutput,
  pickAudioExtension,
  resolvePythonCandidates,
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
