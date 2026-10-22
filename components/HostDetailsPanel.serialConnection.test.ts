import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the host editor offers a connection-type picker instead of a separate serial dialog", () => {
  const source = read("./HostDetailsPanel.tsx");

  assert.match(source, /HostConnectionTypeSelect/);
  assert.match(source, /HostSerialConnectionSection/);
  assert.match(source, /hostDetails\.connectionType/);
  // Serial drafts validate against the device path + baud rate, not a hostname.
  assert.match(source, /isSerialHostDraftValid/);
  assert.match(source, /buildSerialHostForSave/);
});

test("a serial draft never passes the SSH credential gate", () => {
  const source = read("./HostDetailsPanel.tsx");
  const marker = "!pluginProtocolActive && !isSerialProtocol && !usesFtpOnly && !hasRequiredHostAuthCredential";

  assert.ok(source.includes(marker), "serial drafts must skip the credential requirement");
});

test("the vault renders serial hosts in the standard editor", () => {
  const source = read("./vault/VaultViewLayout.tsx");

  assert.doesNotMatch(source, /SerialHostDetailsPanel/);
  assert.doesNotMatch(source, /SerialConnectModal/);
  assert.doesNotMatch(source, /editingHost\?\.protocol !== "serial"/);
  assert.match(source, /defaultConnectionType=/);
  // Serial creation hangs off the New Host split button.
  assert.match(source, /vault\.hosts\.newSerialHost/);
  assert.match(source, /onClick=\{handleNewSerialHost\}/);
});

test("the work-surface host editor no longer branches on serial", () => {
  const source = read("../application/app/AppHostEditorLayer.tsx");

  assert.doesNotMatch(source, /SerialHostDetailsPanel/);
});
