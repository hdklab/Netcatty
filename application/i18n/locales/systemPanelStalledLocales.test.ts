import test from "node:test";
import assert from "node:assert/strict";

import { enSystemManagerMessages } from "./en/systemManager";
import { enTerminalMessages } from "./en/terminal";
import { ruSystemManagerMessages } from "./ru/systemManager";
import { ruTerminalMessages } from "./ru/terminal";
import { esSystemManagerMessages } from "./es/systemManager";
import { esTerminalMessages } from "./es/terminal";
import { zhCnSystemManagerMessages } from "./zh-CN/systemManager";
import { zhCNVaultMessages } from "./zh-CN/vault";
import { zhTwSystemManagerMessages } from "./zh-TW/systemManager";
import { zhTWVaultMessages } from "./zh-TW/vault";

// terminal.serverStats.* lives in terminal.ts for en/ru/es and in vault.ts for
// zh-CN / zh-TW (historical placement, same as the latency keys).
const locales = [
  ["en", enSystemManagerMessages, enTerminalMessages],
  ["ru", ruSystemManagerMessages, ruTerminalMessages],
  ["es", esSystemManagerMessages, esTerminalMessages],
  ["zh-CN", zhCnSystemManagerMessages, zhCNVaultMessages],
  ["zh-TW", zhTwSystemManagerMessages, zhTWVaultMessages],
] as const;

test("a stalled exec channel gets its own translated message in every locale", () => {
  for (const [locale, systemManager, terminal] of locales) {
    const stalled = systemManager["systemManager.errors.channelStalled"] ?? "";
    assert.ok(
      stalled.length > 20,
      `${locale}: a stalled channel needs an actionable message`,
    );
    assert.notEqual(
      stalled,
      systemManager["systemManager.errors.sshChannelUnavailable"],
      `${locale}: "server refused" and "connection stalled" are different causes`,
    );

    assert.ok(
      (terminal["terminal.serverStats.stale"] ?? "").length > 3,
      `${locale}: a frozen stats strip must be labelled`,
    );
    assert.match(
      terminal["terminal.serverStats.staleHint"] ?? "",
      /\{time\}/,
      `${locale}: the stale hint must name the last successful sample time`,
    );
  }
});
