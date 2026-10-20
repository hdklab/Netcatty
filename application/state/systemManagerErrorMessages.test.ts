import assert from "node:assert/strict";
import test from "node:test";

import { describeSystemManagerError } from "./systemManagerErrorMessages.ts";

// The stub echoes the key so assertions are about which message was chosen.
const t = (key: string) => key;

test("a fenced exec channel is explained instead of echoed as a raw SSH error", () => {
  assert.equal(
    describeSystemManagerError(
      new Error("SSH exec channel open still pending on this connection"),
      t,
    ),
    "systemManager.errors.channelStalled",
  );
  assert.equal(
    describeSystemManagerError(
      "SSH connection stopped answering exec channel requests",
      t,
    ),
    "systemManager.errors.channelStalled",
  );
});

test("existing exec failures keep their own messages", () => {
  assert.equal(
    describeSystemManagerError(new Error("channel open failure: open failed"), t),
    "systemManager.errors.sshChannelUnavailable",
  );
  assert.equal(
    describeSystemManagerError(
      new Error("Remote SSH server does not support extra exec channels"),
      t,
    ),
    "systemManager.unsupportedRemote",
  );
});

test("unknown messages pass through untouched", () => {
  assert.equal(describeSystemManagerError(new Error("permission denied"), t), "permission denied");
  // No message means the caller's own fallback copy applies.
  assert.equal(describeSystemManagerError(undefined, t), "");
  assert.equal(describeSystemManagerError(null, t), "");
  assert.equal(describeSystemManagerError("", t), "");
});
