import assert from "node:assert/strict";
import test from "node:test";

import type { Host } from "./models";
import {
  applyHostConnectionType,
  buildSerialHostForSave,
  DEFAULT_SERIAL_CONFIG,
  defaultSerialHostLabel,
  isSerialHostDraftValid,
  isSerialPortPath,
  normalizeSerialConfig,
  resolveHostConnectionType,
  resolveSerialPortPath,
  stripSshOnlyHostFields,
} from "./serialHost";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Console",
  hostname: "10.0.0.1",
  port: 22,
  username: "root",
  tags: [],
  os: "linux",
  protocol: "ssh",
  createdAt: 1,
  ...overrides,
});

test("serial port paths accept POSIX devices and both Windows COM forms", () => {
  assert.equal(isSerialPortPath("/dev/ttyUSB0"), true);
  assert.equal(isSerialPortPath("  /dev/tty.usbserial-1420 "), true);
  assert.equal(isSerialPortPath("COM7"), true);
  assert.equal(isSerialPortPath("com12"), true);
  const win32Com3 = [92, 92, 46, 92, 67, 79, 77, 51] // backslash backslash dot backslash COM3
                  .map((code) => String.fromCharCode(code)).join("");
  assert.equal(isSerialPortPath(win32Com3), true);

  assert.equal(isSerialPortPath(""), false);
  assert.equal(isSerialPortPath("ttyUSB0"), false);
  assert.equal(isSerialPortPath("10.0.0.1"), false);
  assert.equal(isSerialPortPath("COM"), false);
});

test("the serial draft path wins over the hostname so save order cannot lose it", () => {
  assert.equal(resolveSerialPortPath({ hostname: "/dev/ttyS0", serialConfig: undefined }), "/dev/ttyS0");
  assert.equal(
    resolveSerialPortPath({ hostname: "10.0.0.1", serialConfig: { path: " /dev/ttyUSB1 ", baudRate: 115200 } }),
    "/dev/ttyUSB1",
  );
});

test("draft validation needs a serial path plus a positive integer baud rate", () => {
  assert.equal(isSerialHostDraftValid({ hostname: "/dev/ttyUSB0", serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200 } }), true);
  assert.equal(isSerialHostDraftValid({ hostname: "", serialConfig: { path: "", baudRate: 115200 } }), false);
  assert.equal(isSerialHostDraftValid({ hostname: "/dev/ttyUSB0", serialConfig: { path: "/dev/ttyUSB0", baudRate: 0 } }), false);
  assert.equal(isSerialHostDraftValid({ hostname: "COM3", serialConfig: { path: "COM3", baudRate: 1.5 } }), false);
});

test("a Windows named-pipe console is a serial path without UART settings", () => {
  const pipe = "\\\\.\\pipe\\vm-console";

  assert.equal(isSerialPortPath(pipe), true);
  // Baud rate and framing do not apply to a pipe, so an empty/zero rate still saves.
  assert.equal(isSerialHostDraftValid({ hostname: pipe, serialConfig: { path: pipe, baudRate: 0 } }), true);
  assert.equal(isSerialHostDraftValid({ hostname: "", serialConfig: { path: pipe, baudRate: 115200 } }), true);
  assert.equal(defaultSerialHostLabel(pipe), "Serial: vm-console");
  // A pipe path is a device path, never an SSH hostname to keep.
  const switched = applyHostConnectionType(
    applyHostConnectionType(host({ hostname: pipe, port: 115200 }), "serial"),
    "ssh",
  );
  assert.equal(switched.hostname, "");
});

test("a saved serial host keeps the path as hostname and the baud rate as port", () => {
  const saved = buildSerialHostForSave(host({
    protocol: "serial",
    hostname: "/dev/ttyUSB0",
    port: 22,
    serialConfig: { path: "/dev/ttyUSB0", baudRate: 9600, dataBits: 7, parity: "even" },
    username: "  admin  ",
    password: "",
    proxyConfig: { type: "socks5", host: "127.0.0.1", port: 1080 },
    hostChain: { hostIds: ["jump-1"] },
    identityFilePaths: ["/home/user/.ssh/id_ed25519"],
    authMethod: "key",
  }));

  assert.equal(saved.protocol, "serial");
  assert.equal(saved.hostname, "/dev/ttyUSB0");
  assert.equal(saved.port, 9600);
  assert.equal(saved.username, "admin");
  // A blank password is a meaningful serial auto-login credential.
  assert.equal(saved.password, "");
  assert.deepEqual(saved.serialConfig, {
    path: "/dev/ttyUSB0",
    baudRate: 9600,
    dataBits: 7,
    stopBits: 1,
    parity: "even",
    flowControl: "none",
    localEcho: false,
    lineMode: false,
  });
  assert.equal(saved.proxyConfig, undefined);
  assert.equal(saved.hostChain, undefined);
  assert.equal(saved.identityFilePaths, undefined);
  assert.equal(saved.authMethod, undefined);
});

test("saved serial hosts drop a default Backspace override but keep Ctrl-H", () => {
  const withDefault = buildSerialHostForSave(host({
    protocol: "serial",
    hostname: "COM3",
    serialConfig: { path: "COM3", baudRate: 115200, backspaceBehavior: "default" },
  }));
  assert.equal(withDefault.serialConfig?.backspaceBehavior, undefined);

  const withCtrlH = buildSerialHostForSave(host({
    protocol: "serial",
    hostname: "COM3",
    serialConfig: { path: "COM3", baudRate: 115200, backspaceBehavior: "ctrl-h" },
  }));
  assert.equal(withCtrlH.serialConfig?.backspaceBehavior, "ctrl-h");
});

test("normalizing a partial serial config fills defaults and repairs a bad baud rate", () => {
  assert.deepEqual(
    normalizeSerialConfig({ path: " /dev/ttyS0 ", baudRate: Number.NaN }),
    { ...DEFAULT_SERIAL_CONFIG, path: "/dev/ttyS0" },
  );
});

test("default labels use the device name", () => {
  assert.equal(defaultSerialHostLabel("/dev/ttyUSB0"), "Serial: ttyUSB0");
  assert.equal(defaultSerialHostLabel("COM4"), "Serial: COM4");
  assert.equal(defaultSerialHostLabel(""), "Serial");
});

test("connection type reflects the transport flags", () => {
  assert.equal(resolveHostConnectionType(host({ protocol: "ssh" })), "ssh");
  assert.equal(resolveHostConnectionType(host({ protocol: "telnet" })), "telnet");
  assert.equal(resolveHostConnectionType(host({ protocol: "mosh" })), "mosh");
  assert.equal(resolveHostConnectionType(host({ protocol: "et" })), "et");
  assert.equal(resolveHostConnectionType(host({ protocol: "serial" })), "serial");
  assert.equal(resolveHostConnectionType(host({ protocol: "ssh", moshEnabled: true })), "mosh");
});

test("switching to serial seeds defaults and clears other transports", () => {
  const switched = applyHostConnectionType(
    host({ protocol: "ssh", moshEnabled: true, telnetEnabled: true, hostname: "10.0.0.1" }),
    "serial",
  );

  assert.equal(switched.protocol, "serial");
  assert.equal(switched.moshEnabled, false);
  assert.equal(switched.telnetEnabled, false);
  assert.deepEqual(switched.serialConfig, DEFAULT_SERIAL_CONFIG);
  // Address is not a serial path, so the socket fields stay untouched until
  // the user picks a device.
  assert.equal(switched.hostname, "10.0.0.1");
});

test("switching away from serial keeps the saved line settings for a switch back", () => {
  const switched = applyHostConnectionType(host({
    protocol: "serial",
    hostname: "/dev/ttyUSB0",
    port: 115200,
    serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200, parity: "even" },
  }), "ssh");

  assert.equal(switched.protocol, "ssh");
  assert.equal(switched.hostname, "");
  assert.equal(switched.port, 22);
  assert.equal(switched.serialConfig?.baudRate, 115200);
  assert.equal(switched.serialConfig?.parity, "even");

  const back = applyHostConnectionType(switched, "serial");
  assert.equal(back.protocol, "serial");
  assert.equal(back.port, 115200);
  assert.equal(back.serialConfig?.parity, "even");
  assert.equal(back.hostname, "/dev/ttyUSB0");
});

test("switching to telnet from serial targets the telnet port", () => {
  const switched = applyHostConnectionType(host({
    protocol: "serial",
    hostname: "COM3",
    port: 9600,
    telnetPort: 2323,
    serialConfig: { path: "COM3", baudRate: 9600 },
  }), "telnet");

  assert.equal(switched.protocol, "telnet");
  assert.equal(switched.telnetEnabled, true);
  assert.equal(switched.port, 2323);
});

test("stripping SSH-only fields keeps serial, FTP and appearance settings", () => {
  const stripped = stripSshOnlyHostFields(host({
    protocol: "serial",
    ftpEnabled: true,
    ftpPort: 2121,
    theme: "flexoki",
    fontSize: 13,
    notes: "console",
  }));

  assert.equal(stripped.ftpEnabled, true);
  assert.equal(stripped.ftpPort, 2121);
  assert.equal(stripped.theme, "flexoki");
  assert.equal(stripped.fontSize, 13);
  assert.equal(stripped.notes, "console");
});

test("switching between SSH and Telnet moves the socket port to the protocol default", () => {
  const toTelnet = applyHostConnectionType(host({ protocol: "ssh", port: 22 }), "telnet");
  assert.equal(toTelnet.port, 23);
  assert.equal(toTelnet.telnetEnabled, true);

  const toSsh = applyHostConnectionType(host({ protocol: "telnet", port: 23 }), "ssh");
  assert.equal(toSsh.port, 22);
  assert.equal(toSsh.telnetEnabled, false);

  // A non-default port is the user's choice and survives the switch.
  assert.equal(applyHostConnectionType(host({ protocol: "ssh", port: 2222 }), "telnet").port, 2222);
});

test("file-transfer-only hosts resolve to the file connection type", () => {
  assert.equal(resolveHostConnectionType(host({ protocol: "ssh", fileTransferOnly: true })), "file");
  assert.equal(resolveHostConnectionType(host({ protocol: "ssh" })), "ssh");
});

test("switching to file transfer keeps credentials and forces a transfer protocol", () => {
  const switched = applyHostConnectionType(
    host({ protocol: "telnet", telnetEnabled: true, username: "admin", sftpFileProtocol: undefined }),
    "file",
  );

  assert.equal(switched.fileTransferOnly, true);
  assert.equal(switched.protocol, "ssh");
  assert.equal(switched.telnetEnabled, false);
  assert.equal(switched.username, "admin");
  assert.equal(switched.sftpFileProtocol, "sftp");

  // An explicit transfer protocol survives the switch.
  assert.equal(
    applyHostConnectionType(host({ sftpFileProtocol: "ftp" }), "file").sftpFileProtocol,
    "ftp",
  );
});

test("leaving file-transfer mode clears the flag", () => {
  const switched = applyHostConnectionType(
    host({ protocol: "ssh", fileTransferOnly: true }),
    "ssh",
  );
  assert.equal(switched.fileTransferOnly, false);
});

test("a serial baud rate never survives as the socket port", () => {
  const fromSerial = applyHostConnectionType(
    host({
      protocol: "serial",
      hostname: "/dev/ttyUSB0",
      port: 115200,
      serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200 },
    }),
    "telnet",
  );
  assert.equal(fromSerial.port, 23);

  const viaFile = applyHostConnectionType(
    applyHostConnectionType(
      host({
        protocol: "serial",
        hostname: "/dev/ttyUSB0",
        port: 115200,
        serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200 },
      }),
      "file",
    ),
    "telnet",
  );
  assert.equal(viaFile.port, 23);
  assert.equal(viaFile.fileTransferOnly, false);
});

test("switching to a non-telnet transport clears a secondary telnet profile", () => {
  const switched = applyHostConnectionType(
    host({ protocol: "ssh", telnetEnabled: true, telnetPort: 2323 }),
    "mosh",
  );
  assert.equal(switched.moshEnabled, true);
  assert.equal(switched.telnetEnabled, false);
});

test("serial to file transfer resets the baud-rate port", () => {
  const switched = applyHostConnectionType(
    host({
      protocol: "serial",
      hostname: "/dev/ttyUSB0",
      port: 115200,
      serialConfig: { path: "/dev/ttyUSB0", baudRate: 115200 },
    }),
    "file",
  );
  assert.equal(switched.fileTransferOnly, true);
  assert.equal(switched.port, 22);
});

test("a telnet port does not survive the switch to file transfer", () => {
  const switched = applyHostConnectionType(
    host({ protocol: "telnet", telnetEnabled: true, port: 23, hostname: "10.0.0.9" }),
    "file",
  );
  assert.equal(switched.fileTransferOnly, true);
  assert.equal(switched.port, 22);
  assert.equal(switched.hostname, "10.0.0.9");
});
