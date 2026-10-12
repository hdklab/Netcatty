const test = require('node:test');
const assert = require('node:assert/strict');

const ftpBackend = require('./sftpBridge/ftpBackend.cjs');

const { parseListingLine, parseListing, parseNameListing, resolveListingDate, mapLftpFailure } =
  ftpBackend._internal;

test('parses a raw device LIST line that carries a link-count column', () => {
  // Captured verbatim from a telnet/FTP device's own `ls -l` output; the extra
  // link-count column is what the first version of this parser missed.
  const record = parseListingLine(
    '-rwxr-xr-x    1 0        0          114924 Jan  1  1970 ECT8676_DPD_V2.2.9.4.bin',
  );
  assert.ok(record, 'the line parses');
  assert.deepEqual(
    { name: record.name, type: record.type, size: record.size },
    { name: 'ECT8676_DPD_V2.2.9.4.bin', type: 'file', size: 114924 },
  );
  assert.equal(record.owner, undefined, 'a numeric owner is not a user name');
  assert.equal(new Date(record.modifyTime).getFullYear(), 1970);
});

test('parses lftp-normalized listings (no link count) and directory entries', () => {
  const file = parseListingLine('---------- 1000     1000           12 Mar  4  2020 a.txt');
  assert.equal(file.name, 'a.txt');
  assert.equal(file.size, 12);
  assert.equal(file.type, 'file');

  const dir = parseListingLine('d--------- 1000     1000           40 Oct 12 11:38 empty/');
  assert.equal(dir.name, 'empty', 'the trailing slash is not part of the name');
  assert.equal(dir.type, 'directory');
});

test('parses a busybox-style listing with named owner/group and a symlink target', () => {
  const file = parseListingLine('-rw-r--r--    1 root     root          1234 Oct 12 11:38 note.txt');
  assert.deepEqual(
    { name: file.name, owner: file.owner, size: file.size, type: file.type },
    { name: 'note.txt', owner: 'root', size: 1234, type: 'file' },
  );

  const link = parseListingLine('lrwxrwxrwx    1 root     root             7 Oct 12 11:38 link -> /etc/passwd');
  assert.equal(link.type, 'symlink');
  assert.equal(link.name, 'link');
  assert.equal(link.linkTarget, '/etc/passwd');
});

test('permission bits survive when the server sends them, and stay unknown when it sends dashes', () => {
  const withMode = parseListingLine('drwxr-xr-x    2 root     root          4096 Oct 12 11:38 sub');
  assert.equal(withMode.permissions, 'rwxr-xr-x');

  const dashes = parseListingLine('---------- 1000     1000           12 Mar  4  2020 a.txt');
  assert.equal(dashes.permissions, undefined, 'lftp prints dashes when LIST has no usable mode');
});

test('skips total lines, blank lines and the dot entries', () => {
  assert.deepEqual(parseListing('total 12\n\n./\n../\n'), []);
  assert.equal(parseListingLine('total 4'), null);
});

test('falls back to a name listing for an unknown server format', () => {
  const names = parseNameListing('sub/\nfile.txt\n./\n');
  assert.deepEqual(
    names.map((entry) => ({ name: entry.name, type: entry.type })),
    [{ name: 'sub', type: 'directory' }, { name: 'file.txt', type: 'file' }],
  );
});

test('a listing date without a year resolves to this year, and a future date to the previous one', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0);
  assert.equal(resolveListingDate('Jun', 14, '09:30', now), new Date(2026, 5, 14, 9, 30).getTime());
  assert.equal(resolveListingDate('Dec', 31, '09:30', now), new Date(2025, 11, 31, 9, 30).getTime());
  assert.equal(resolveListingDate('Jan', '1', '1970', now), new Date(1970, 0, 1).getTime());
  assert.equal(resolveListingDate('nope', 1, '1970', now), undefined);
});

test('lftp failures map onto the codes the file-ops layer understands', () => {
  assert.equal(mapLftpFailure({ error: 'cd: Access failed: 550 No such file or directory. (/nope)' }).code, 'ENOENT');
  assert.equal(mapLftpFailure({ error: 'Login failed: 530 Login failed' }).code, 'EAUTH');
  assert.equal(mapLftpFailure({ error: 'Access failed: 553 Permission denied' }).code, 'EACCES');
  assert.equal(mapLftpFailure({ code: 'timeout', error: 'lftp timed out' }).code, 'ETIMEDOUT');
  assert.equal(mapLftpFailure({ code: 'lftp-not-found' }).code, 'LFTP_NOT_FOUND');
});

test('error messages never carry the FTP password back to the caller', () => {
  // lftp echoes the credential-bearing URL on some failures.
  const error = mapLftpFailure({
    error: 'open ftp://root,s3cret@192.168.1.3:21 failed; -u root,s3cret rejected',
  });
  assert.doesNotMatch(error.message, /s3cret/);
  assert.match(error.message, /ftp:\/\/192\.168\.1\.3/);
});

/**
 * lftp parses options before operands. Getting that order wrong does not fail in
 * the parser — it reaches the server as a delete of a file literally named `-f`
 * (`550 Error (/-f)`), which is how the first drag-and-drop upload died. These
 * assertions pin the exact command strings each operation sends.
 */
test('every backend operation sends lftp-accepted command order', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ftp-cmd-'));
  const scriptPath = path.join(dir, 'fake-lftp.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\ncp "$2" "${dir}/script.txt"\nexit 0\n`, { mode: 0o755 });
  const previousLftp = process.env.NETCATTY_LFTP_PATH;
  process.env.NETCATTY_LFTP_PATH = scriptPath;

  const localFile = path.join(dir, 'local.txt');
  fs.writeFileSync(localFile, 'payload');

  try {
    const backend = ftpBackend.createFtpBackend({
      host: '192.168.1.3',
      user: 'root',
      password: 'pw',
      tempDir: dir,
    });
    const scriptAfter = async (operation) => {
      fs.rmSync(path.join(dir, 'script.txt'), { force: true });
      await operation();
      return fs.readFileSync(path.join(dir, 'script.txt'), 'utf8');
    };

    assert.match(
      await scriptAfter(() => backend.remove('/mnt/flash/old.bin')),
      /^rm -rf "\/mnt\/flash\/old\.bin"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.remove('/mnt/flash/old.bin', { recursive: false })),
      /^rm -f "\/mnt\/flash\/old\.bin"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.unlink('/mnt/flash/old.bin')),
      /^rm -f "\/mnt\/flash\/old\.bin"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.mkdir('/mnt/flash/new/deep')),
      /^mkdir -f "\/mnt\/flash\/new\/deep"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.rename('/mnt/flash/a', '/mnt/flash/b')),
      /^mv "\/mnt\/flash\/a" "\/mnt\/flash\/b"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.writeFile('/mnt/flash/note.txt', Buffer.from('hi'))),
      /^put ".*\.tmp" -o "note\.txt"$/m,
    );
    assert.match(
      await scriptAfter(() => backend.uploadFile(localFile, '/mnt/flash/local.txt', { fileSize: 7 })),
      /^put ".*local\.txt" -o "local\.txt"$/m,
    );
    // Listing and reads stay one command each, after the `cd`.
    assert.match(
      await scriptAfter(() => backend.list('/mnt/flash')),
      /^cd "\/mnt\/flash"$/m,
    );
  } finally {
    if (previousLftp === undefined) delete process.env.NETCATTY_LFTP_PATH;
    else process.env.NETCATTY_LFTP_PATH = previousLftp;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chmod is a no-op, not a failure: the pipeline calls it after the bytes are committed', async () => {
  // A throwing chmod turned a completed FTP upload into a failed transfer
  // ("FTP servers do not support chmod" at 100%). The UI-facing chmod IPC path
  // reports the limitation itself (fileOps' chmodSftp).
  const backend = ftpBackend.createFtpBackend({ host: 'h', user: 'u', password: 'p' });
  assert.deepEqual(await backend.chmod('/x', 0o644), { supported: false });
});
