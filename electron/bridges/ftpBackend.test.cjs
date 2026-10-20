const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const ftpBackend = require('./sftpBridge/ftpBackend.cjs');
const { FakeFtpClient, makeFakeClientFactory, ftpError } = require('./ftpTestClient.cjs');

const { mapFtpError, toListEntry, parentOf, baseNameOf, joinRemotePath, formatUnixPermissions, scrubCredentials } =
  ftpBackend._internal;

function makeBackend(tree, options = {}) {
  const { factory, clients } = makeFakeClientFactory(tree, options);
  const backend = ftpBackend.createFtpBackend({
    host: '10.0.0.9',
    user: 'root',
    password: 'topsecret',
    secure: options.secure,
    insecure: options.insecure,
    tempDir: options.tempDir,
    clientFactory: factory,
  });
  return { backend, clients };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ftp-backend-'));
}

// ----------------------------------------------------------------- helpers

test('FTP reply codes map onto the codes the file-ops layer understands', () => {
  assert.equal(mapFtpError(ftpError(530, '530 Login incorrect')).code, 'EAUTH');
  assert.equal(mapFtpError(ftpError(550, '550 No such file')).code, 'ENOENT');
  assert.equal(mapFtpError(ftpError(550, '550 Directory not empty')).code, 'ENOTEMPTY');
  assert.equal(mapFtpError(ftpError(553, '553 Permission denied')).code, 'EACCES');
  assert.equal(mapFtpError(ftpError(552, '552 Exceeded storage')).code, 'ENOSPC');
  assert.equal(mapFtpError(ftpError('ETIMEDOUT', 'Timeout')).code, 'ETIMEDOUT');
  assert.equal(mapFtpError(ftpError('ECONNREFUSED', 'connect ECONNREFUSED')).code, 'ECONNREFUSED');
  assert.equal(mapFtpError(new Error('weird failure')).code, 'EFTP');
  assert.equal(mapFtpError(new ftpBackend.FtpBackendError('kept', 'EACCES')).code, 'EACCES');
});

test('error messages never carry the FTP password back to the caller', () => {
  const error = mapFtpError(ftpError(530, '530 Login failed for ftp://root:topsecret@10.0.0.9:21'));
  assert.doesNotMatch(error.message, /topsecret/);
  assert.match(error.message, /ftp:\/\/10\.0\.0\.9/);
  assert.equal(scrubCredentials('password: hunter2'), 'password: [REDACTED]');
});

test('remote path helpers keep absolute and login-relative paths apart', () => {
  assert.equal(parentOf('/mnt/flash/a.bin'), '/mnt/flash');
  assert.equal(parentOf('/a.bin'), '/');
  assert.equal(parentOf('a.bin'), '/');
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf('.'), null);
  assert.equal(baseNameOf('/mnt/flash/a.bin'), 'a.bin');
  assert.equal(baseNameOf('/'), '/');
  assert.equal(joinRemotePath('/mnt/flash', 'fw.bin'), '/mnt/flash/fw.bin');
  assert.equal(joinRemotePath('/mnt/flash/', 'fw.bin'), '/mnt/flash/fw.bin');
  assert.equal(joinRemotePath('', 'fw.bin'), 'fw.bin');
  assert.equal(joinRemotePath('/', 'fw.bin'), '/fw.bin');
});

test('a listing entry carries size, type, owner and permissions the pane can paint', () => {
  const info = {
    name: 'fw.bin',
    isDirectory: false,
    isSymbolicLink: false,
    size: 114924,
    modifiedAt: new Date('2024-05-01T10:00:00Z'),
    permissions: { user: 6, group: 4, world: 4 },
    user: 'root',
    group: 'root',
  };
  assert.deepEqual(toListEntry(info), {
    name: 'fw.bin',
    type: 'file',
    linkTarget: null,
    size: '114924 bytes',
    lastModified: '2024-05-01T10:00:00.000Z',
    permissions: 'rw-r--r--',
    owner: 'root',
    group: 'root',
    _size: 114924,
    _modifyTime: Date.parse('2024-05-01T10:00:00Z'),
  });
  assert.equal(formatUnixPermissions({ user: 7, group: 5, world: 5 }), 'rwxr-xr-x');
  assert.equal(formatUnixPermissions(undefined), undefined);
});

// ------------------------------------------------------------------ reading

test('list() maps the server listing, and stat() finds one entry in its parent', async () => {
  const { backend, clients } = makeBackend({
    '/fw.bin': { type: 'file', data: Buffer.from('abc') },
    '/sub': { type: 'dir' },
    '/sub/note.txt': { type: 'file', data: Buffer.from('hello') },
  });

  const entries = await backend.list('/');
  assert.deepEqual(
    entries.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size })),
    [{ name: 'fw.bin', type: 'file', size: '3 bytes' }, { name: 'sub', type: 'directory', size: '0 bytes' }],
  );

  const attrs = await backend.stat('/fw.bin');
  assert.equal(attrs.isDirectory, false);
  assert.equal(attrs.size, 3);
  assert.equal(attrs.path, '/fw.bin');

  const dirAttrs = await backend.stat('/sub');
  assert.equal(dirAttrs.isDirectory, true);

  await assert.rejects(() => backend.stat('/nope.bin'), (error) => error.code === 'ENOENT');
  assert.equal(clients.length, 1, 'one connection serves every operation');
});

test('homeDir()/realpath() report the server path and leave the connection cwd alone', async () => {
  const { backend } = makeBackend({ '/mnt': { type: 'dir' }, '/mnt/flash': { type: 'dir' } });
  assert.equal(await backend.homeDir(), '/');
  assert.equal(await backend.realpath('/mnt/flash'), '/mnt/flash');
  assert.equal(await backend.homeDir(), '/', 'a path lookup must not move the login directory');
});

test('readFile() returns the bytes and refuses oversized files before buffering', async () => {
  const { backend } = makeBackend({ '/big.bin': { type: 'file', data: Buffer.alloc(4096, 7) } });
  const buffer = await backend.readFile('/big.bin');
  assert.equal(buffer.length, 4096);
  assert.equal(buffer[0], 7);

  await assert.rejects(
    () => backend.readFile('/big.bin', { maxBytes: 1024 }),
    (error) => error.code === 'SFTP_READ_TOO_LARGE' && error.actualBytes === 4096 && error.maxBytes === 1024,
  );
});

// ------------------------------------------------------------------- writes

test('mkdir() creates every segment and hands the connection back to its login directory', async () => {
  const { backend, clients } = makeBackend({});
  await backend.mkdir('/mnt/flash/new/deep');
  const made = clients[0].calls.filter((call) => call[0] === 'mkdir').map((call) => call[1]);
  assert.deepEqual(made, ['/mnt', '/mnt/flash', '/mnt/flash/new', '/mnt/flash/new/deep']);
  assert.equal(await backend.homeDir(), '/');
});

test('remove() picks REMOVE for files, RMD for directories, and stops at a non-empty one', async () => {
  const { backend } = makeBackend({
    '/fw.bin': { type: 'file', data: Buffer.from('x') },
    '/logs': { type: 'dir' },
    '/logs/a.txt': { type: 'file', data: Buffer.from('x') },
  });

  await backend.remove('/fw.bin');
  await assert.rejects(() => backend.stat('/fw.bin'), (error) => error.code === 'ENOENT');

  await assert.rejects(
    () => backend.remove('/logs', { recursive: false }),
    (error) => error.code === 'ENOTEMPTY',
  );
  await backend.remove('/logs');
  await assert.rejects(() => backend.stat('/logs'), (error) => error.code === 'ENOENT');
});

test('unlink() and rename() address absolute paths', async () => {
  const { backend, clients } = makeBackend({
    '/a.bin': { type: 'file', data: Buffer.from('x') },
    '/sub': { type: 'dir' },
  });
  await backend.rename('/a.bin', '/sub/b.bin');
  assert.deepEqual(
    clients[0].calls.filter((call) => call[0] === 'rename'),
    [['rename', '/a.bin', '/sub/b.bin']],
  );
  await backend.unlink('/sub/b.bin');
  await assert.rejects(() => backend.stat('/sub/b.bin'), (error) => error.code === 'ENOENT');
});

test('a remote path with a newline is refused instead of injecting a command', async () => {
  const { backend } = makeBackend({});
  await assert.rejects(
    () => backend.mkdir('/tmp\nDELE /etc/passwd'),
    (error) => error.code === 'EINVAL',
  );
});

test('writeFile() uploads the buffer and creates missing parent directories', async () => {
  const { backend, clients } = makeBackend({});
  await backend.writeFile('/mnt/flash/sub/note.txt', Buffer.from('hi'));
  const uploaded = clients[0].calls.filter((call) => call[0] === 'upload');
  assert.deepEqual(uploaded, [['upload', '/mnt/flash/sub/note.txt', 'hi']]);
});

// ---------------------------------------------------------------- transfers

test('uploadFile() reports byte progress from the client tracker', async () => {
  const dir = tempDir();
  const local = path.join(dir, 'fw.bin');
  fs.writeFileSync(local, 'firmware');
  const { backend } = makeBackend({ '/mnt': { type: 'dir' } });
  const seen = [];
  await backend.uploadFile(local, '/mnt/fw.bin', {
    fileSize: 8,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen[0], [0, 8], 'the row starts at zero before any bytes move');
  assert.deepEqual(seen[seen.length - 1], [8, 8]);
  assert.ok(seen.some(([done]) => done === 8), 'the tracker reported the real byte count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadFile() stages into .part, renames on success and rejects a truncated transfer', async () => {
  const dir = tempDir();
  const { backend } = makeBackend({ '/fw.bin': { type: 'file', data: Buffer.from('firmware') } });
  const target = path.join(dir, 'fw.bin');

  const result = await backend.downloadFile('/fw.bin', target, { fileSize: 8 });
  assert.deepEqual(result, { bytes: 8 });
  assert.equal(fs.readFileSync(target, 'utf8'), 'firmware');
  assert.deepEqual(fs.readdirSync(dir), ['fw.bin'], 'no .part file survives a good download');

  await assert.rejects(
    () => backend.downloadFile('/fw.bin', path.join(dir, 'short.bin'), { fileSize: 4096 }),
    (error) => error.code === 'EBADMSG',
  );
  assert.deepEqual(fs.readdirSync(dir), ['fw.bin'], 'the failed download leaves nothing behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('downloadToWritable() streams into the caller stream without ending it', async () => {
  const { backend } = makeBackend({ '/fw.bin': { type: 'file', data: Buffer.from('firmware') } });
  const chunks = [];
  let ended = false;
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  writable.on('finish', () => { ended = true; });

  const result = await backend.downloadToWritable('/fw.bin', writable, { fileSize: 8 });

  assert.equal(result.bytes, 8);
  assert.equal(Buffer.concat(chunks).toString(), 'firmware');
  assert.equal(ended, false, 'the caller may keep writing more files into the same stream');
});

test('an already-aborted signal rejects with ABORT_ERR and dials nothing', async () => {
  const { backend, clients } = makeBackend({ '/fw.bin': { type: 'file', data: Buffer.from('x') } });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => backend.list('/', { signal: controller.signal }),
    (error) => error.code === 'ABORT_ERR',
  );
  assert.equal(clients.length, 0);

  const entries = await backend.list('/');
  assert.equal(entries.length, 1);
});

test('a closed client is replaced on the next operation', async () => {
  const { backend, clients } = makeBackend({ '/fw.bin': { type: 'file', data: Buffer.from('x') } });
  await backend.list('/');
  clients[0].close();
  const entries = await backend.list('/');
  assert.equal(entries.length, 1);
  assert.equal(clients.length, 2, 'a new connection serves the retry');
});

test('secure/insecure map onto explicit FTPS and an unchecked certificate', async () => {
  const options = [];
  const factory = () => {
    const client = new FakeFtpClient({});
    options.push(client);
    return client;
  };

  await ftpBackend.createFtpBackend({ host: 'h', clientFactory: factory }).homeDir();
  assert.equal(options[0].options.secure, false);
  assert.equal(options[0].options.secureOptions, undefined);

  const backend = ftpBackend.createFtpBackend({ host: 'h', secure: true, insecure: true, clientFactory: factory });
  await backend.homeDir();
  assert.equal(options[1].options.secure, true);
  assert.deepEqual(options[1].options.secureOptions, { rejectUnauthorized: false });
});

test('an FTP 530 at login surfaces as EAUTH instead of an empty file list', async () => {
  const { backend } = makeBackend({}, { accessError: ftpError(530, '530 Login incorrect') });
  await assert.rejects(() => backend.homeDir(), (error) => error.code === 'EAUTH');
});

test('dispose() closes the connection and later operations refuse to run', async () => {
  const { backend, clients } = makeBackend({});
  await backend.homeDir();
  backend.dispose();
  assert.equal(clients[0].closed, true);
  await assert.rejects(() => backend.list('/'), (error) => error.code === 'ECONNRESET');
});

test('uploadFilesToEndpoint reports whole-batch byte progress with per-file offsets', async () => {
  const dir = tempDir();
  const first = path.join(dir, 'a.bin');
  const second = path.join(dir, 'b.bin');
  fs.writeFileSync(first, Buffer.alloc(10, 1));
  fs.writeFileSync(second, Buffer.alloc(30, 2));
  const { factory } = makeFakeClientFactory({ '/mnt': { type: 'dir' } });
  const seen = [];

  const result = await ftpBackend.uploadFilesToEndpoint({
    host: '10.0.0.9',
    user: 'u',
    password: 'p',
    remoteDir: '/mnt',
    files: [
      { localPath: first, remoteName: 'a.bin' },
      { localPath: second, remoteName: 'b.bin' },
    ],
    clientFactory: factory,
    onProgress: (done, total, name) => seen.push([done, total, name]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 40);
  assert.deepEqual(seen[0], [0, 40, ''], 'the total is known before the first byte moves');
  assert.deepEqual(seen[seen.length - 1], [40, 40, 'b.bin']);
  assert.ok(
    seen.some(([done, , name]) => name === 'b.bin' && done >= 10),
    `the second file continues from the first one's bytes: ${JSON.stringify(seen)}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chmod is a no-op, not a failure: the pipeline calls it after the bytes are committed', async () => {
  // A throwing chmod turned a completed FTP upload into a failed transfer
  // ("FTP servers do not support chmod" at 100%). The UI-facing chmod IPC path
  // reports the limitation itself (fileOps' chmodSftp).
  const backend = ftpBackend.createFtpBackend({ host: 'h', user: 'u', password: 'p' });
  assert.deepEqual(await backend.chmod('/x', 0o644), { supported: false });
});
