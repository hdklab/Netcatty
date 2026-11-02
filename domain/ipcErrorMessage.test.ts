import test from "node:test";
import assert from "node:assert/strict";

import { stripIpcErrorMessage } from "./ipcErrorMessage";

test("strips the ipcRenderer.invoke wrapper and its inner Error label", () => {
  assert.equal(
    stripIpcErrorMessage(new Error(
      "Error invoking remote method 'netcatty:serial:start': Error: Serial port /dev/ttyUSB0 is already open",
    )),
    "Serial port /dev/ttyUSB0 is already open",
  );
});

test("keeps a plain backend message intact", () => {
  assert.equal(
    stripIpcErrorMessage(new Error("Failed to open serial port: No such file or directory")),
    "Failed to open serial port: No such file or directory",
  );
});

test("accepts strings, null and undefined", () => {
  assert.equal(
    stripIpcErrorMessage("Error invoking remote method 'netcatty:start': Error: boom"),
    "boom",
  );
  assert.equal(stripIpcErrorMessage(null), "");
  assert.equal(stripIpcErrorMessage(undefined), "");
});

test("a wrapper with no inner message falls back to the raw text", () => {
  const raw = "Error invoking remote method 'netcatty:serial:start': ";
  assert.equal(stripIpcErrorMessage(new Error(raw)), raw);
});
