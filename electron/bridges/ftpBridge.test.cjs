const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ftpBridge = require('./ftpBridge.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ftp-test-'));
}

/**
 * Write a stand-in for the lftp executable. It records the script it was given
 * (`-f <path>`) and the argv it saw, then exits with the requested code, so the
 * bridge can be exercised end to end without a network.
 */
function writeFakeLftp(dir, { exitCode = 0, stderr = '' } = {}) {
  const scriptPath = path.join(dir, 'fake-lftp.sh');
  fs.writeFileSync(
    scriptPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${dir}/argv.txt"`,
      'for arg in "$@"; do case "$arg" in -f) ;; *) continue;; esac; done',
      `cp "$2" "${dir}/received-script.txt" 2>/dev/null || true`,
      `chmod --reference="$2" "${dir}/received-script.txt" 2>/dev/null || true`,
      `if [ -n "${stderr}" ]; then printf '%s\\n' "${stderr}" >&2; fi`,
      `exit ${exitCode}`,
    ].join('\n'),
    { mode: 0o755 },
  );
  return scriptPath;
}

function withLftp(lftpPath, fn) {
  const previous = process.env.NETCATTY_LFTP_PATH;
  process.env.NETCATTY_LFTP_PATH = lftpPath;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.NETCATTY_LFTP_PATH;
    else process.env.NETCATTY_LFTP_PATH = previous;
  });
}

test('buildLftpScript puts the remote dir, the file, and no argv-visible secret', () => {
  const script = ftpBridge.buildLftpScript({
    host: '10.0.0.9',
    port: 2121,
    user: 'root',
    password: 'hunter2',
    remoteDir: '/var/tmp/oem',
    files: [{ localPath: '/tmp/build/fw.bin' }],
  });
  assert.match(script, /^set cmd:fail-exit yes$/m);
  assert.match(script, /^open -u "root","hunter2" -p 2121 ftp:\/\/"10\.0\.0\.9"$/m);
  assert.match(script, /^cd "\/var\/tmp\/oem"$/m);
  assert.match(script, /^put "\/tmp\/build\/fw\.bin"$/m);
  assert.match(script, /^bye$/m);
});

test('buildLftpScript switches to ftps when secure, and only then relaxes verification', () => {
  const plain = ftpBridge.buildLftpScript({ host: 'h', files: [{ localPath: '/a' }] });
  assert.doesNotMatch(plain, /ftp:ssl-force/);
  const secure = ftpBridge.buildLftpScript({ host: 'h', secure: true, files: [{ localPath: '/a' }] });
  assert.match(secure, /set ftp:ssl-force yes/);
  assert.match(secure, /ftps:\/\/"h"/);
  assert.doesNotMatch(secure, /ssl:verify-certificate no/);
  const insecure = ftpBridge.buildLftpScript({
    host: 'h',
    secure: true,
    insecure: true,
    files: [{ localPath: '/a' }],
  });
  assert.match(insecure, /set ssl:verify-certificate no/);
});

test('buildLftpScript renames with put -o only when a remote name is given', () => {
  const script = ftpBridge.buildLftpScript({
    host: 'h',
    files: [{ localPath: '/tmp/x/fw.bin', remoteName: 'firmware.bin' }],
  });
  assert.match(script, /^put -o "firmware\.bin" "\/tmp\/x\/fw\.bin"$/m);
});

test('buildLftpScript quotes hosts and paths containing quotes and backslashes', () => {
  const script = ftpBridge.buildLftpScript({
    host: 'weird"host',
    remoteDir: '/a\\"b',
    files: [{ localPath: '/tmp/f' }],
  });
  assert.match(script, /weird\\"host/);
  assert.match(script, /\/a\\\\\\"b/);
});

test('buildLftpScript rejects empty batches and missing hosts', () => {
  assert.throws(() => ftpBridge.buildLftpScript({ host: 'h', files: [] }), /no files/);
  assert.throws(() => ftpBridge.buildLftpScript({ files: [{ localPath: '/a' }] }), /host is required/);
});

test('uploadFiles runs lftp with only the script path in argv, and cleans up', async () => {
  const dir = tempDir();
  const lftp = writeFakeLftp(dir, { exitCode: 0 });
  await withLftp(lftp, async () => {
    const result = await ftpBridge.uploadFiles({
      host: '10.0.0.9',
      user: 'root',
      password: 'topsecret',
      remoteDir: '/srv',
      files: [{ localPath: '/tmp/fw.bin' }],
      tempDir: dir,
      timeoutMs: 15000,
    });
    assert.deepEqual(result, { ok: true });
  });

  const argv = fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(argv, ['-f', argv[1]]);
  assert.ok(argv[1].endsWith('.script'), 'lftp receives a script file');
  assert.ok(!argv.join(' ').includes('topsecret'), 'the password never reaches argv');

  const seen = fs.readFileSync(path.join(dir, 'received-script.txt'), 'utf8');
  assert.match(seen, /put "\/tmp\/fw\.bin"/);
  assert.ok(seen.includes('topsecret'), 'the password only lives inside the script');

  const mode = fs.statSync(path.join(dir, 'received-script.txt')).mode & 0o777;
  assert.equal(mode, 0o600, 'the script is not world readable');

  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.script'));
  assert.deepEqual(leftovers, [], 'the script is removed after the transfer');
});

test('uploadFiles reports a redacted error when lftp fails', async () => {
  const dir = tempDir();
  const lftp = writeFakeLftp(dir, { exitCode: 1, stderr: 'open -u root,topsecret ftp://10.0.0.9: Login failed' });
  await withLftp(lftp, async () => {
    const result = await ftpBridge.uploadFiles({
      host: '10.0.0.9',
      user: 'root',
      password: 'topsecret',
      files: [{ localPath: '/tmp/fw.bin' }],
      tempDir: dir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'lftp-failed');
    assert.doesNotMatch(result.error, /topsecret/, 'credentials are stripped from the error');
    assert.match(result.error, /\[REDACTED\]/);
  });
});

test('uploadFiles reports lftp-not-found instead of throwing', async () => {
  await withLftp('/nonexistent/lftp', async () => {
    const result = await ftpBridge.uploadFiles({
      host: 'h',
      files: [{ localPath: '/tmp/fw.bin' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'lftp-not-found');
  });
});

test('uploadFiles times out a hung lftp and still removes the script', async () => {
  const dir = tempDir();
  const hung = path.join(dir, 'hung-lftp.sh');
  fs.writeFileSync(hung, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  await withLftp(hung, async () => {
    const result = await ftpBridge.uploadFiles({
      host: 'h',
      files: [{ localPath: '/tmp/fw.bin' }],
      tempDir: dir,
      timeoutMs: 300,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
  });
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.script'));
  assert.deepEqual(leftovers, []);
});

test('getCapabilities reports whether an lftp is usable, and redact strips credential pairs', async () => {
  await withLftp('/nonexistent/lftp', async () => {
    assert.deepEqual(ftpBridge.getCapabilities(), { lftp: false, lftpPath: null });
  });
  assert.equal(
    ftpBridge.redact('open -u root,topsecret ftp://h failed; password: abc123'),
    'open -u [REDACTED] ftp://h failed; password: [REDACTED]',
  );
});
