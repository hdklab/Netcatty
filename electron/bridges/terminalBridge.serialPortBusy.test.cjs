const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");

// A device path that cannot exist, so the identity stays the normalized string
// on every platform and the suite never touches real hardware.
const DEVICE = "/dev/netcatty-test-ttyUSB0";
const OTHER_DEVICE = "/dev/netcatty-test-ttyUSB1";

function serialSession(overrides = {}) {
  return {
    type: "serial",
    protocol: "serial",
    label: "zu2cg",
    serialPort: { path: DEVICE, write: () => true },
    ...overrides,
  };
}

test("serial sessions on one device cannot both start", async (t) => {
  const sessions = new Map([["owner-1", serialSession()]]);
  terminalBridge.init({ sessions, electronModule: {} });
  try {
    await t.test("the second start names the owning session", async () => {
      await assert.rejects(
        terminalBridge.startSerialSession({}, { sessionId: "second", path: DEVICE }),
        (error) => {
          assert.match(error.message, /already open in the "zu2cg" session/);
          assert.doesNotMatch(error.message, /Cannot lock port/);
          return true;
        },
      );
      // The owner is untouched: the failed start never reaches the binding.
      assert.equal(sessions.size, 1);
      assert.equal(sessions.get("owner-1").label, "zu2cg");
    });

    await t.test("a trailing separator or whitespace is the same device", async () => {
      await assert.rejects(
        terminalBridge.startSerialSession({}, { sessionId: "second", path: `  ${DEVICE}/  ` }),
        /already open in the "zu2cg" session/,
      );
    });

    await t.test("reconnecting the same sessionId is not a conflict", async () => {
      // The worker closes the superseded boot first, so the pre-flight must not
      // treat the session's own registry entry as another owner. The start gets
      // past the check and fails later, on the binding/PTY itself.
      await assert.rejects(
        terminalBridge.startSerialSession({}, { sessionId: "owner-1", path: DEVICE }),
        (error) => !/already open in the/.test(error.message),
      );
    });

    await t.test("other devices are unaffected", async () => {
      await assert.rejects(
        terminalBridge.startSerialSession({}, { sessionId: "second", path: OTHER_DEVICE }),
        (error) => !/already open in the/.test(error.message),
      );
    });
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("findSerialPortOwner reports the session holding a device", () => {
  const sessions = new Map([
    ["ssh-1", { type: "ssh", hostname: "10.0.0.1" }],
    ["owner-1", serialSession()],
  ]);
  terminalBridge.init({ sessions, electronModule: {} });
  try {
    assert.deepEqual(terminalBridge.findSerialPortOwner({}, { path: DEVICE }), {
      sessionId: "owner-1",
      label: "zu2cg",
      path: DEVICE,
    });
    assert.equal(terminalBridge.findSerialPortOwner({}, { path: OTHER_DEVICE }), null);
    assert.equal(terminalBridge.findSerialPortOwner({}, { path: "" }), null);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});

test("a session without a stored label still names its device", () => {
  const sessions = new Map([["owner-2", serialSession({ label: "" })]]);
  terminalBridge.init({ sessions, electronModule: {} });
  try {
    assert.equal(terminalBridge.findSerialPortOwner({}, { path: DEVICE })?.label, DEVICE);
  } finally {
    terminalBridge.cleanupAllSessions();
  }
});
