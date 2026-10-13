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
  assert.ok(
    argv[1].startsWith(dir + path.sep),
    'the script is written into the caller-supplied temp dir',
  );
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

test('materializeDropFile creates the staging directory it writes into', () => {
  const dir = tempDir();
  const staging = path.join(dir, 'netcatty-ftp-staging');
  assert.equal(fs.existsSync(staging), false, 'the staging dir starts out absent');

  const resolved = ftpBridge._internal.materializeDropFile(
    { name: 'fw.bin', remoteName: 'fw.bin', data: new TextEncoder().encode('firmware').buffer },
    staging,
  );

  assert.equal(resolved.cleanup, true);
  assert.ok(resolved.localPath.startsWith(staging + path.sep));
  assert.equal(fs.readFileSync(resolved.localPath, 'utf8'), 'firmware');
});

test('netcatty:ftp:upload stages a data-only dropped file before handing it to lftp', async () => {
  const dir = tempDir();
  const lftp = writeFakeLftp(dir, { exitCode: 0 });
  const handlers = {};
  ftpBridge.configure({ tempDir: dir });
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });

  try {
    await withLftp(lftp, async () => {
      const result = await handlers['netcatty:ftp:upload']({}, {
        host: '10.0.0.9',
        port: 21,
        user: 'root',
        password: 'topsecret',
        remoteDir: '/srv',
        files: [
          { name: 'fw.bin', remoteName: 'fw.bin', data: new TextEncoder().encode('firmware').buffer },
        ],
      });
      assert.deepEqual(result, { ok: true });
    });
  } finally {
    ftpBridge.configure(null);
  }

  const script = fs.readFileSync(path.join(dir, 'received-script.txt'), 'utf8');
  assert.match(
    script,
    /^put -o "fw\.bin" ".*netcatty-ftp-staging[\\/]nc-ftp-\d+-\d+-fw\.bin"$/m,
    'the staged copy is uploaded under the dropped name',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'netcatty-ftp-staging')),
    [],
    'the staged copy is removed after the transfer, the directory stays',
  );
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

test('lftp auto-detection covers the common per-platform install locations', () => {
  const win = ftpBridge._internal.buildLftpCandidates({
    platform: 'win32',
    env: {
      ProgramFiles: 'D:\\PF',
      'ProgramFiles(x86)': 'D:\\PF86',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
      ProgramData: 'D:\\ProgramData',
    },
    home: 'C:\\Users\\me',
  });
  assert.ok(win.every((candidate) => candidate.toLowerCase().endsWith('.exe')), win.join(' | '));
  assert.ok(win.includes(path.win32.join('D:\\PF', 'lftp', 'lftp.exe')));
  assert.ok(win.includes('C:\\Users\\me\\scoop\\shims\\lftp.exe'));
  assert.ok(win.some((candidate) => /msys64|cygwin/i.test(candidate)));

  const mac = ftpBridge._internal.buildLftpCandidates({ platform: 'darwin', env: {}, home: '/Users/me' });
  assert.ok(mac.includes('/opt/homebrew/bin/lftp'));      // Apple Silicon brew
  assert.ok(mac.includes('/usr/local/bin/lftp'));         // Intel brew
  assert.ok(mac.includes('/opt/local/bin/lftp'));         // MacPorts
  assert.ok(mac.includes('/Users/me/.nix-profile/bin/lftp'));

  const linux = ftpBridge._internal.buildLftpCandidates({ platform: 'linux', env: {}, home: '/home/me' });
  assert.ok(linux.includes('/usr/bin/lftp'));
  assert.ok(linux.includes('/run/current-system/sw/bin/lftp'));   // NixOS system profile
  assert.ok(linux.includes('/home/me/.local/bin/lftp'));
});

test('a path set in Settings wins over the env var and reports its source', async () => {
  const settingsDir = tempDir();
  const envDir = tempDir();
  const settingsPath = writeFakeLftp(settingsDir);
  const envPath = writeFakeLftp(envDir);
  try {
    await withLftp(envPath, async () => {
      const configured = ftpBridge.setLftpPath(settingsPath);
      assert.equal(configured.resolvedPath, settingsPath);
      assert.equal(configured.source, 'settings');
      assert.equal(configured.autoDetected, false);

      const cleared = ftpBridge.setLftpPath('');
      assert.equal(cleared.resolvedPath, envPath);
      assert.equal(cleared.source, 'env');
      assert.equal(cleared.autoDetected, false);
    });
  } finally {
    ftpBridge.setLftpPath('');
    fs.rmSync(settingsDir, { recursive: true, force: true });
    fs.rmSync(envDir, { recursive: true, force: true });
  }
});

test('a configured path that is not executable is reported, not silently replaced', () => {
  try {
    const status = ftpBridge.setLftpPath('/definitely/not/here/lftp');
    assert.equal(status.resolvedPath, null);
    assert.equal(status.source, 'settings-invalid');
    assert.equal(status.configuredUsable, false);
    // An explicit-but-broken setting must not fall back to PATH: the settings UI
    // shows the problem instead of the transfer failing later with no clue.
    assert.equal(ftpBridge.findLftp(), null);
  } finally {
    ftpBridge.setLftpPath('');
  }
});
