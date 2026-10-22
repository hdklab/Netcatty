import assert from "node:assert/strict";
import test from "node:test";

import en from "./en";
import es from "./es";
import ru from "./ru";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";

// Keys added for the connection-type / file-transfer rework. Every bundled
// locale must carry each one, otherwise the panel renders the raw key.
const KEYS = [
  "hostDetails.connectionType",
  "hostDetails.connectionType.ssh",
  "hostDetails.connectionType.telnet",
  "hostDetails.connectionType.mosh",
  "hostDetails.connectionType.et",
  "hostDetails.connectionType.serial",
  "hostDetails.connectionType.file",
  "hostDetails.fileTransfer.title",
  "hostDetails.fileTransfer.desc",
  "hostDetails.fileTransfer.protocol",
  "hostDetails.fileTransfer.none",
  "hostDetails.ftp.port",
  "vault.hosts.newSerialHost",
];

const LOCALES: Array<[string, Record<string, string>]> = [
  ["en", en as unknown as Record<string, string>],
  ["zh-CN", zhCN as unknown as Record<string, string>],
  ["zh-TW", zhTW as unknown as Record<string, string>],
  ["ru", ru as unknown as Record<string, string>],
  ["es", es as unknown as Record<string, string>],
];

test("connection type and file transfer strings exist in every locale", () => {
  for (const [name, dict] of LOCALES) {
    for (const key of KEYS) {
      const value = dict[key];
      assert.equal(typeof value, "string", `${name} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${name} has an empty ${key}`);
    }
  }
});
