import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFtpUploadFiles, resolveFtpDropPlan, supportsFtpDragDrop } from "./ftpDragDrop";

/** Minimal host shape; only the FTP-relevant fields matter here. */
function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "telnet",
    hostname: "10.0.0.9",
    ftpEnabled: true,
    ...overrides,
  } as never;
}

test("a telnet host with FTP enabled and a known cwd yields an upload plan", () => {
  const result = resolveFtpDropPlan({
    host: makeHost({ ftpUsername: "fw", ftpPassword: "s3cret", ftpPort: 2121, ftpSecure: true, ftpInsecure: true }),
    remoteDir: "/var/tmp/oem",
    lftpAvailable: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan, {
    host: "10.0.0.9",
    port: 2121,
    user: "fw",
    password: "s3cret",
    secure: true,
    insecure: true,
    remoteDir: "/var/tmp/oem",
  });
});

test("FTP credentials fall back: ftp* -> telnet* -> resolved identity -> host", () => {
  const telnetOnly = resolveFtpDropPlan({
    host: makeHost({ telnetUsername: "telnet-user", telnetPassword: "telnet-pass" }),
    remoteDir: "/tmp",
    lftpAvailable: true,
  });
  assert.equal(telnetOnly.ok && telnetOnly.plan.user, "telnet-user");
  assert.equal(telnetOnly.ok && telnetOnly.plan.password, "telnet-pass");

  const identityOnly = resolveFtpDropPlan({
    host: makeHost(),
    remoteDir: "/tmp",
    lftpAvailable: true,
    credentials: { username: "identity-user", password: "identity-pass" },
  });
  assert.equal(identityOnly.ok && identityOnly.plan.user, "identity-user");
  assert.equal(identityOnly.ok && identityOnly.plan.password, "identity-pass");

  const hostOnly = resolveFtpDropPlan({
    host: makeHost({ username: "host-user", password: "host-pass" }),
    remoteDir: "/tmp",
    lftpAvailable: true,
  });
  assert.equal(hostOnly.ok && hostOnly.plan.user, "host-user");
  assert.equal(hostOnly.ok && hostOnly.plan.password, "host-pass");
});

test("an FTP username wins over the telnet one, and blank values are ignored", () => {
  const result = resolveFtpDropPlan({
    host: makeHost({ ftpUsername: "  ftp-user  ", telnetUsername: "telnet-user", telnetPassword: "telnet-pass" }),
    remoteDir: "/tmp",
    lftpAvailable: true,
  });
  assert.equal(result.ok && result.plan.user, "ftp-user");
  assert.equal(result.ok && result.plan.password, "telnet-pass");
});

test("the default port is 21 whenever no usable port is configured", () => {
  for (const ftpPort of [undefined, 0, -1, Number.NaN]) {
    const result = resolveFtpDropPlan({ host: makeHost({ ftpPort }), remoteDir: "/tmp", lftpAvailable: true });
    assert.equal(result.ok && result.plan.port, 21, `port for ${String(ftpPort)}`);
  }
});

test("protocols that already have SFTP never use the FTP path", () => {
  assert.equal(supportsFtpDragDrop({ protocol: "ssh" } as never), false);
  assert.equal(supportsFtpDragDrop({ protocol: "telnet", moshEnabled: true } as never), false);
  assert.equal(supportsFtpDragDrop({ protocol: "telnet", etEnabled: true } as never), false);
  const result = resolveFtpDropPlan({ host: makeHost({ protocol: "ssh" }), remoteDir: "/tmp", lftpAvailable: true });
  assert.deepEqual(result, { ok: false, reason: "unsupported-protocol" });
});

test("each refusal reports a reason the UI can explain", () => {
  const cases: Array<[Record<string, unknown>, Partial<Parameters<typeof resolveFtpDropPlan>[0]>, string]> = [
    [{ ftpEnabled: false }, {}, "disabled"],
    [{ hostname: "" }, {}, "no-host"],
    [{}, { lftpAvailable: false }, "no-lftp"],
  ];
  for (const [override, extra, reason] of cases) {
    const result = resolveFtpDropPlan({
      host: makeHost(override),
      remoteDir: "/tmp",
      lftpAvailable: true,
      ...extra,
    });
    assert.deepEqual(result, { ok: false, reason }, `reason for ${reason}`);
  }
});

test("normalizeFtpUploadFiles accepts the shapes an agent sends", () => {
  assert.deepEqual(normalizeFtpUploadFiles("/tmp/fw.bin"), [
    { path: "/tmp/fw.bin", name: "fw.bin", remoteName: "fw.bin" },
  ]);
  assert.deepEqual(normalizeFtpUploadFiles("/tmp/a.bin,/tmp/b.bin").map((f) => f.name), ["a.bin", "b.bin"]);
  assert.deepEqual(normalizeFtpUploadFiles("/tmp/a.bin\n/tmp/b.bin").map((f) => f.name), ["a.bin", "b.bin"]);
  assert.deepEqual(normalizeFtpUploadFiles('["/tmp/a.bin"]').map((f) => f.name), ["a.bin"]);
  assert.deepEqual(normalizeFtpUploadFiles([{ path: "/tmp/a.bin", remoteName: "custom.bin" }]), [
    { path: "/tmp/a.bin", name: "a.bin", remoteName: "custom.bin" },
  ]);
  assert.deepEqual(normalizeFtpUploadFiles("   "), []);
  assert.deepEqual(normalizeFtpUploadFiles(null), []);
  assert.deepEqual(normalizeFtpUploadFiles([{ remoteName: "x" }, 42]), []);
});

test("normalizeFtpUploadFiles keeps windows-style paths intact for the bridge", () => {
  const [first] = normalizeFtpUploadFiles("C:\\build\\fw.bin");
  assert.equal(first.name, "fw.bin");
  assert.equal(first.path, "C:\\build\\fw.bin");
});

test("a device that never reports a cwd still uploads, into the FTP login directory", () => {
  // Telnet/serial shells emit no OSC 7, so the pane's cwd is unknown on exactly
  // the hosts this backend exists for. Refusing the drop there made drag-and-drop
  // look broken (no upload, no message); the file now lands in the FTP account's
  // login directory and the toast names it.
  for (const remoteDir of [undefined, null, "", "   "]) {
    const result = resolveFtpDropPlan({
      host: makeHost(),
      remoteDir,
      lftpAvailable: true,
    });
    assert.equal(result.ok, true, `remoteDir=${JSON.stringify(remoteDir)} plans`);
    assert.equal(result.ok && result.plan.remoteDir, null, "no directory means the login dir");
  }

  const withCwd = resolveFtpDropPlan({ host: makeHost(), remoteDir: "/mnt/flash", lftpAvailable: true });
  assert.equal(withCwd.ok && withCwd.plan.remoteDir, "/mnt/flash");
});
