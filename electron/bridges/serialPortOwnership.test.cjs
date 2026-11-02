const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSerialDevicePath,
  resolveSerialDeviceIdentity,
  findSerialSessionOwner,
  describeSerialPortBusy,
  isSerialPortBusyError,
} = require("./serialPortOwnership.cjs");

test("normalizes trailing separators and surrounding whitespace", () => {
  assert.equal(normalizeSerialDevicePath("  /dev/ttyUSB0/ "), "/dev/ttyUSB0");
  assert.equal(normalizeSerialDevicePath("/dev/ttyUSB0"), "/dev/ttyUSB0");
  assert.equal(normalizeSerialDevicePath(""), "");
  assert.equal(normalizeSerialDevicePath(undefined), "");
});

test("windows device names and pipe paths compare case-insensitively", () => {
  assert.equal(normalizeSerialDevicePath("\\\\.\\COM7"), "com7");
  assert.equal(normalizeSerialDevicePath("COM7"), "com7");
  assert.equal(normalizeSerialDevicePath("\\\\.\\pipe\\LyraConsole"), "\\\\.\\pipe\\lyraconsole");
  // POSIX device paths stay case-sensitive.
  assert.equal(normalizeSerialDevicePath("/dev/ttyUSB0"), "/dev/ttyUSB0");
  assert.notEqual(normalizeSerialDevicePath("/dev/TTYUSB0"), "/dev/ttyUSB0");
});

test("resolves a device identity through symlinks", () => {
  const realpathSync = (value) => {
    if (value === "/dev/serial/by-id/probe") return "/dev/ttyUSB3";
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(
    resolveSerialDeviceIdentity("/dev/serial/by-id/probe", { realpathSync }),
    "/dev/ttyUSB3",
  );
  // A missing device still yields a stable identity.
  assert.equal(
    resolveSerialDeviceIdentity("/dev/ttyUSB9", { realpathSync }),
    "/dev/ttyUSB9",
  );
});

test("finds the serial session that already owns the device", () => {
  const sessions = new Map([
    ["ssh-1", { type: "ssh", hostname: "10.0.0.1" }],
    ["serial-1", { type: "serial", label: "zu2cg", serialPort: { path: "/dev/ttyUSB0" } }],
  ]);
  const identity = resolveSerialDeviceIdentity("/dev/ttyUSB0/", {
    realpathSync: () => { throw new Error("ENOENT"); },
  });

  assert.deepEqual(findSerialSessionOwner(sessions, identity), {
    sessionId: "serial-1",
    label: "zu2cg",
    path: "/dev/ttyUSB0",
  });
  // A same-identity restart excludes its own sessionId.
  assert.equal(findSerialSessionOwner(sessions, identity, { excludeSessionId: "serial-1" }), null);
  // Unrelated devices do not collide.
  assert.equal(
    findSerialSessionOwner(sessions, resolveSerialDeviceIdentity("/dev/ttyUSB1", {
      realpathSync: () => { throw new Error("ENOENT"); },
    })),
    null,
  );
});

test("matches a session opened through a symlink to the same device", () => {
  const sessions = new Map([
    ["serial-link", { type: "serial", label: "by-id", serialPort: { path: "/dev/serial/by-id/probe" } }],
  ]);
  const realpathSync = (value) => (value === "/dev/serial/by-id/probe" ? "/dev/ttyUSB3" : value);
  const identity = resolveSerialDeviceIdentity("/dev/ttyUSB3", { realpathSync });
  const owner = findSerialSessionOwner(sessions, identity, { realpathSync });
  assert.equal(owner?.sessionId, "serial-link");
});

test("busy message names the owner and never leaks the binding error", () => {
  const owned = describeSerialPortBusy("/dev/ttyUSB0", { label: "zu2cg" });
  assert.match(owned, /already open in the "zu2cg" session/);
  assert.doesNotMatch(owned, /Cannot lock port/);

  assert.match(
    describeSerialPortBusy("/dev/ttyUSB0", null),
    /already open by another session or process/,
  );
});

test("recognizes the binding's busy/lock failures", () => {
  assert.equal(isSerialPortBusyError(new Error("Error Resource temporarily unavailable Cannot lock port")), true);
  assert.equal(isSerialPortBusyError(new Error("EBUSY: resource busy or locked")), true);
  assert.equal(isSerialPortBusyError(new Error("No such file or directory")), false);
  assert.equal(isSerialPortBusyError(undefined), false);
});
