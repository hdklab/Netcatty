import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "./models";
import {
  hostHasNoFileService,
  hostHasSshTransport,
  resolveFtpSftpEndpoint,
  resolveSftpFileProtocolMode,
} from "./sftpFtpHost";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "h1",
  label: "device",
  hostname: "192.168.1.3",
  port: 23,
  username: "root",
  protocol: "telnet",
  tags: [],
  ...overrides,
} as Host);

test("telnet and serial sessions have no SSH transport, ssh/mosh/et do", () => {
  assert.equal(hostHasSshTransport(host()), false);
  assert.equal(hostHasSshTransport(host({ protocol: "serial" })), false);
  assert.equal(hostHasSshTransport(host({ protocol: "ssh" })), true);
  assert.equal(hostHasSshTransport(host({ protocol: "telnet", moshEnabled: true })), true);
  assert.equal(hostHasSshTransport(host({ protocol: "serial", etEnabled: true })), true);
});

test("a telnet device with FTP enabled browses over FTP instead of dialling SSH", () => {
  assert.equal(resolveSftpFileProtocolMode(host({ ftpEnabled: true })), "ftp");
  // No FTP configured: nothing to browse, which the pane reports instead of hanging.
  assert.equal(resolveSftpFileProtocolMode(host({ ftpEnabled: false })), "auto");
  assert.equal(hostHasNoFileService(host({ ftpEnabled: false })), true);
  assert.equal(hostHasNoFileService(host({ ftpEnabled: true })), false);
});

test("an explicit file protocol always wins", () => {
  assert.equal(resolveSftpFileProtocolMode(host({ protocol: "ssh", sftpFileProtocol: "ftp" })), "ftp");
  assert.equal(resolveSftpFileProtocolMode(host({ ftpEnabled: true, sftpFileProtocol: "sftp" })), "sftp");
  assert.equal(resolveSftpFileProtocolMode(host({ ftpEnabled: true, sftpFileProtocol: "scp" })), "scp");
  // SSH hosts keep the SFTP/SCP auto behaviour.
  assert.equal(resolveSftpFileProtocolMode(host({ protocol: "ssh", ftpEnabled: true })), "auto");
});

test("the FTP endpoint falls back through the same credential chain as drag-drop uploads", () => {
  const result = resolveFtpSftpEndpoint({
    host: host({
      ftpEnabled: true,
      ftpUsername: "ftpuser",
      ftpPassword: "ftppass",
      telnetUsername: "telnetuser",
      telnetPassword: "telnetpass",
      password: "hostpass",
    }),
  });
  assert.deepEqual(result, {
    ok: true,
    endpoint: {
      hostname: "192.168.1.3",
      port: 21,
      username: "ftpuser",
      password: "ftppass",
      secure: false,
      insecure: false,
    },
  });
});

test("the FTP endpoint inherits telnet credentials, then the resolved identity, then the host login", () => {
  const telnetOnly = resolveFtpSftpEndpoint({
    host: host({ telnetUsername: "telnetuser", telnetPassword: "telnetpass", password: "hostpass" }),
  });
  assert.equal(telnetOnly.ok && telnetOnly.endpoint.username, "telnetuser");
  assert.equal(telnetOnly.ok && telnetOnly.endpoint.password, "telnetpass");

  const identityOnly = resolveFtpSftpEndpoint({
    host: host(),
    credentials: { username: "iduser", password: "idpass" },
  });
  assert.equal(identityOnly.ok && identityOnly.endpoint.username, "iduser");
  assert.equal(identityOnly.ok && identityOnly.endpoint.password, "idpass");

  const hostLogin = resolveFtpSftpEndpoint({ host: host({ password: "hostpass" }) });
  assert.equal(hostLogin.ok && hostLogin.endpoint.username, "root");
  assert.equal(hostLogin.ok && hostLogin.endpoint.password, "hostpass");
});

test("the FTP endpoint honours the configured port, FTPS and skip-verify flags", () => {
  const result = resolveFtpSftpEndpoint({
    host: host({ ftpPort: 2121, ftpSecure: true, ftpInsecure: true }),
  });
  assert.equal(result.ok && result.endpoint.port, 2121);
  assert.equal(result.ok && result.endpoint.secure, true);
  assert.equal(result.ok && result.endpoint.insecure, true);
});

test("an FTP host without a hostname reports no address instead of an empty endpoint", () => {
  assert.deepEqual(resolveFtpSftpEndpoint({ host: host({ hostname: "" }) }), {
    ok: false,
    reason: "no-host",
  });
});
