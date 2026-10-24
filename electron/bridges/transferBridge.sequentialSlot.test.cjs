"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const transferBridge = require("./transferBridge.cjs");

/**
 * Upstream wrapped every SFTP body transfer in a one-slot queue keyed on the
 * SFTP channel (TERM-SSHD compatibility). SCP and FTP sessions have no channel
 * at all — this fork routes them through `sftpBridge/remoteFileBackend.cjs` —
 * so an `isScpModeClient`-only guard makes `requireSftpChannel` throw
 * "SFTP session lost" before the backend ever runs the transfer. Keep the
 * bypass covered so a later upstream merge cannot quietly narrow it again.
 */
test("the sequential transfer slot lets SCP and FTP sessions through", async () => {
  const slot = transferBridge._withSequentialSftpTransferSlotForTests;
  assert.equal(typeof slot, "function", "the slot helper must stay testable");

  for (const fileProtocol of ["scp", "ftp"]) {
    const client = { __netcattyFileProtocol: fileProtocol };
    let runs = 0;
    const result = await slot(client, { transferId: `slot-${fileProtocol}` }, async () => {
      runs += 1;
      return fileProtocol;
    });
    assert.equal(result, fileProtocol);
    assert.equal(runs, 1, `${fileProtocol} body must run exactly once`);
  }
});

test("a session without a file channel still has to wait for the SFTP slot", async () => {
  await assert.rejects(
    transferBridge._withSequentialSftpTransferSlotForTests({}, {}, async () => "unreachable"),
    /SFTP session lost/,
  );
});
