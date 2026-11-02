"use strict";

const fs = require("node:fs");

/**
 * Serial device identity helpers.
 *
 * Two Netcatty sessions can point at the same physical port through different
 * spellings (`/dev/ttyUSB0` vs a symlink to it, `COM3` vs `\\.\COM3`), and the
 * OS binding only reports a bare "Cannot lock port" when the second open
 * collides. Comparing a resolved identity lets the bridge name the session that
 * already owns the device instead of surfacing that binding error.
 *
 * Keep in sync with the renderer-side `isSerialEndpointPath` in
 * domain/serialEndpoint.ts (endpoint shapes, not identity rules).
 */

const WINDOWS_DRIVE_COM = /^com\d+$/i;
const WINDOWS_DEVICE_PREFIX = /^\\\\[.?]\\/;
const WINDOWS_BARE_COM = /^\\\\\.\\(com\d+)$/i;

/**
 * Canonical form of a serial device path for equality checks.
 *
 * Windows device names and named pipes are case-insensitive on every host (a
 * Windows session can be opened from any platform only via a pipe path, which
 * is still compared here), so those are lowercased. Trailing separators never
 * identify a different device.
 */
function normalizeSerialDevicePath(value, platform = process.platform) {
  if (typeof value !== "string") return "";
  let path = value.trim();
  if (!path) return "";
  path = path.replace(/[\\/]+$/, "");
  if (!path) return "";
  const caseInsensitive = platform === "win32"
    || WINDOWS_DRIVE_COM.test(path)
    || WINDOWS_DEVICE_PREFIX.test(path);
  if (!caseInsensitive) return path;
  const bareCom = WINDOWS_BARE_COM.exec(path);
  if (bareCom) path = bareCom[1];
  return path.toLowerCase();
}

/**
 * Identity of the device behind `portPath`: the real path when the device
 * exists (follows symlinks such as `/dev/serial/by-id/...`), otherwise the
 * normalized spelling so a missing device still compares consistently.
 */
function resolveSerialDeviceIdentity(portPath, options = {}) {
  const platform = options.platform || process.platform;
  const normalized = normalizeSerialDevicePath(portPath, platform);
  if (!normalized) return "";
  const realpathSync = typeof options.realpathSync === "function"
    ? options.realpathSync
    : fs.realpathSync;
  try {
    const resolved = realpathSync(normalized);
    return normalizeSerialDevicePath(resolved, platform) || normalized;
  } catch {
    return normalized;
  }
}

/**
 * Find the live serial session that already holds `deviceIdentity`.
 *
 * @returns {{ sessionId: string, label: string, path: string } | null}
 */
function findSerialSessionOwner(sessions, deviceIdentity, options = {}) {
  if (!sessions || !deviceIdentity) return null;
  if (typeof sessions.forEach !== "function") return null;
  const excludeSessionId = options.excludeSessionId;
  let owner = null;
  sessions.forEach((session, sessionId) => {
    if (owner || !session) return;
    if (session.type !== "serial" && session.protocol !== "serial") return;
    if (excludeSessionId && String(sessionId) === String(excludeSessionId)) return;
    const serialPath = session.serialPort?.path || session.serialPath || "";
    const identity = session.serialDeviceIdentity
      || resolveSerialDeviceIdentity(serialPath, options);
    if (!identity || identity !== deviceIdentity) return;
    owner = {
      sessionId: String(sessionId),
      label: session.label || serialPath || deviceIdentity,
      path: serialPath || deviceIdentity,
    };
  });
  return owner;
}

/**
 * Readable alternative to the binding's "Cannot lock port" so the terminal
 * line names the owner instead of the low-level lock error.
 */
function describeSerialPortBusy(portPath, owner) {
  if (owner) {
    return `Serial port ${portPath} is already open in the "${owner.label}" session. Close that session first.`;
  }
  return `Serial port ${portPath} is already open by another session or process.`;
}

/** The serialport binding reports a held device as EBUSY plus this text. */
function isSerialPortBusyError(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error || "");
  return /Cannot lock port|Resource temporarily unavailable|\bEBUSY\b/i.test(message);
}

module.exports = {
  normalizeSerialDevicePath,
  resolveSerialDeviceIdentity,
  findSerialSessionOwner,
  describeSerialPortBusy,
  isSerialPortBusyError,
};
