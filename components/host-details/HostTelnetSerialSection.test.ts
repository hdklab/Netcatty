import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Renderer suites in this repo are source-text assertions (no jsdom mount), so
 * these pin the contract the host editor relies on: the RFC 2217 block exists,
 * exposes the toggle and the four line-setting pickers, and is mounted from the
 * telnet section instead of only being reachable from a serial host.
 */
const section = readFileSync(new URL("./HostTelnetSerialSection.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../HostDetailsPanel.tsx", import.meta.url), "utf8");
const starters = readFileSync(
  new URL("../terminal/runtime/createTerminalSessionStarters.ts", import.meta.url),
  "utf8",
);

test("telnet serial section exposes the RFC 2217 toggle and line settings", () => {
  assert.match(section, /data-telnet-serial-toggle=/);
  assert.match(section, /hostDetails\.telnet\.serial\.title/);
  assert.match(section, /serial\.field\.baudRate/);
  assert.match(section, /serial\.field\.dataBits/);
  assert.match(section, /serial\.field\.stopBits/);
  assert.match(section, /serial\.field\.parity/);
  assert.match(section, /serial\.field\.flowControl/);
  // The controls only exist once the option is on.
  assert.match(section, /\{value\.enabled && \(/);
});

test("host editor mounts the serial block inside the telnet section", () => {
  assert.match(panel, /<HostTelnetSerialSection/);
  assert.match(panel, /value=\{telnetSerialConfig\}/);
  assert.match(panel, /onChange=\{updateTelnetSerialConfig\}/);
  // Switching the option off must keep the stored block.
  assert.match(panel, /mergeTelnetSerialConfig\(prev\.telnetSerialConfig, patch\)/);
});

test("telnet session starter negotiates the serial settings and reports them", () => {
  assert.match(starters, /resolveTelnetSerialConfig\(ctx\.host\)/);
  assert.match(starters, /telnetSerial: telnetSerial \?\? undefined/);
  assert.match(starters, /onTelnetSerialStatus/);
  assert.match(starters, /RFC2217 serial: \$\{serialLabel\} applied by the server/);
  assert.match(starters, /disposeTelnetSerialStatus/);
});
