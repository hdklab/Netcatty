import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TELNET_SERIAL_CONFIG,
  TELNET_SERIAL_BAUD_RATES,
  formatTelnetSerialConfig,
  mergeTelnetSerialConfig,
  normalizeTelnetSerialConfig,
  resolveTelnetSerialConfig,
} from "./telnetSerial";

test("normalizeTelnetSerialConfig fills defaults for junk input", () => {
  assert.deepEqual(normalizeTelnetSerialConfig(undefined), DEFAULT_TELNET_SERIAL_CONFIG);
  assert.deepEqual(normalizeTelnetSerialConfig("nope"), DEFAULT_TELNET_SERIAL_CONFIG);
  assert.deepEqual(normalizeTelnetSerialConfig({ baudRate: "fast", dataBits: 9 }), {
    ...DEFAULT_TELNET_SERIAL_CONFIG,
  });
});

test("normalizeTelnetSerialConfig keeps a valid config and custom baud rates", () => {
  const config = normalizeTelnetSerialConfig({
    enabled: true,
    baudRate: 250000,
    dataBits: 7,
    stopBits: 2,
    parity: "even",
    flowControl: "rts/cts",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.baudRate, 250000);
  assert.equal(config.dataBits, 7);
  assert.equal(config.stopBits, 2);
  assert.equal(config.parity, "even");
  assert.equal(config.flowControl, "rts/cts");
});

test("resolveTelnetSerialConfig only applies to enabled telnet hosts", () => {
  assert.equal(resolveTelnetSerialConfig({ protocol: "telnet" }), null);
  assert.equal(
    resolveTelnetSerialConfig({ protocol: "telnet", telnetSerialConfig: { ...DEFAULT_TELNET_SERIAL_CONFIG } }),
    null,
    "option off means a plain telnet session",
  );
  assert.equal(
    resolveTelnetSerialConfig({
      protocol: "ssh",
      telnetSerialConfig: { ...DEFAULT_TELNET_SERIAL_CONFIG, enabled: true },
    }),
    null,
    "an ssh host must never negotiate COM-PORT",
  );
  const enabled = resolveTelnetSerialConfig({
    protocol: "telnet",
    telnetSerialConfig: { ...DEFAULT_TELNET_SERIAL_CONFIG, enabled: true, baudRate: 19200 },
  });
  assert.equal(enabled?.baudRate, 19200);
});

test("formatTelnetSerialConfig prints the familiar 8N1 shorthand", () => {
  assert.equal(
    formatTelnetSerialConfig({ ...DEFAULT_TELNET_SERIAL_CONFIG, baudRate: 9600 }),
    "9600 8N1",
  );
  assert.equal(
    formatTelnetSerialConfig({
      ...DEFAULT_TELNET_SERIAL_CONFIG,
      baudRate: 115200,
      dataBits: 7,
      parity: "even",
      stopBits: 2,
    }),
    "115200 7E2",
  );
});

test("mergeTelnetSerialConfig keeps the block when the option is switched off", () => {
  const configured = mergeTelnetSerialConfig(undefined, { baudRate: 57600, parity: "odd" });
  const disabled = mergeTelnetSerialConfig(configured, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.baudRate, 57600, "a stray click must not lose the line settings");
  assert.equal(disabled.parity, "odd");
  assert.ok(TELNET_SERIAL_BAUD_RATES.includes(57600));
});
