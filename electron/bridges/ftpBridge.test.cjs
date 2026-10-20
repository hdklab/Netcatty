const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ftpBridge = require('./ftpBridge.cjs');
const { makeFakeClientFactory, ftpError } = require('./ftpTestClient.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ftp-test-'));
}

test('the built-in client means FTP transfers are always available', () => {
  assert.deepEqual(ftpBridge.getCapabilities(), { available: true });
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
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadFiles joins the remote directory with each file name', async () => {
  const dir = tempDir();
  const local = path.join(dir, 'fw.bin');
  fs.writeFileSync(local, 'firmware');
  const { factory, clients } = makeFakeClientFactory({ '/mnt/flash': { type: 'dir' } });

  const result = await ftpBridge.uploadFiles({
    host: '10.0.0.9',
    user: 'root',
    password: 'topsecret',
    remoteDir: '/mnt/flash',
    files: [{ localPath: local, remoteName: 'firmware.bin' }],
    clientFactory: factory,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    clients[0].calls.filter((call) => call[0] === 'upload'),
    [['upload', '/mnt/flash/firmware.bin', 'firmware']],
  );
  // The password only ever went to the LOGIN exchange, never to a child process.
  assert.equal(clients[0].options.password, 'topsecret');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadFiles uploads into the login directory when no remote dir is known', async () => {
  const dir = tempDir();
  const local = path.join(dir, 'fw.bin');
  fs.writeFileSync(local, 'x');
  const { factory, clients } = makeFakeClientFactory({});

  const result = await ftpBridge.uploadFiles({
    host: '10.0.0.9',
    files: [{ localPath: local }],
    clientFactory: factory,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    clients[0].calls.filter((call) => call[0] === 'upload').map((call) => call[1]),
    ['/fw.bin'],
    'a bare name lands in the login directory',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadFiles reports a redacted error instead of throwing', async () => {
  const dir = tempDir();
  const local = path.join(dir, 'fw.bin');
  fs.writeFileSync(local, 'x');
  const { factory } = makeFakeClientFactory({}, {
    accessError: ftpError(530, '530 Login failed for ftp://root:topsecret@10.0.0.9'),
  });

  const result = await ftpBridge.uploadFiles({
    host: '10.0.0.9',
    user: 'root',
    password: 'topsecret',
    files: [{ localPath: local }],
    clientFactory: factory,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'EAUTH');
  assert.doesNotMatch(result.error, /topsecret/, 'credentials are stripped from the error');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadFiles refuses an empty batch and a missing host', async () => {
  assert.deepEqual(
    await ftpBridge.uploadFiles({ host: 'h', files: [] }),
    { ok: false, code: 'no-files', error: 'No files to upload' },
  );
  assert.equal((await ftpBridge.uploadFiles({ files: [{ localPath: '/x' }] })).code, 'invalid-request');
});

test('netcatty:ftp:upload stages a data-only dropped file and removes the copy afterwards', async () => {
  const dir = tempDir();
  const { factory, clients } = makeFakeClientFactory({ '/mnt/flash': { type: 'dir' } });
  const handlers = {};
  ftpBridge.configure({ tempDir: dir, clientFactory: factory });
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });

  try {
    const result = await handlers['netcatty:ftp:upload']({}, {
      host: '10.0.0.9',
      port: 21,
      user: 'root',
      password: 'topsecret',
      remoteDir: '/mnt/flash',
      files: [
        { name: 'fw.bin', remoteName: 'fw.bin', data: new TextEncoder().encode('firmware').buffer },
      ],
    });
    assert.equal(result.ok, true);
  } finally {
    ftpBridge.configure(null);
  }

  const upload = clients[0].calls.find((call) => call[0] === 'upload');
  assert.equal(upload[1], '/mnt/flash/fw.bin', 'the staged copy is uploaded under the dropped name');
  assert.match(upload[2], /^firmware$/, 'the bytes written are the dropped ones');
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'netcatty-ftp-staging')),
    [],
    'the staged copy is removed after the transfer, the directory stays',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('netcatty:ftp:upload streams byte progress to the window that asked for it', async () => {
  const dir = tempDir();
  const { factory } = makeFakeClientFactory({ '/srv': { type: 'dir' } });
  const frames = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, payload) => frames.push([channel, payload]),
  };
  const handlers = {};
  ftpBridge.configure({ tempDir: dir, clientFactory: factory });
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });

  try {
    const result = await handlers['netcatty:ftp:upload']({ sender }, {
      host: '10.0.0.9',
      remoteDir: '/srv',
      uploadId: 'upload-1',
      files: [
        { name: 'fw.bin', remoteName: 'fw.bin', data: new Uint8Array(64).buffer },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.totalBytes, 64);
  } finally {
    ftpBridge.configure(null);
  }

  assert.ok(frames.length > 0, 'at least one progress frame is emitted');
  assert.equal(frames[0][0], 'netcatty:ftp:upload-progress');
  const first = frames[0][1];
  const last = frames[frames.length - 1][1];
  assert.equal(first.uploadId, 'upload-1');
  assert.equal(first.total, 64, 'the row learns its total from the first frame');
  assert.equal(first.transferred, 0);
  assert.equal(last.uploadId, 'upload-1');
  assert.equal(last.transferred, 64);
  assert.ok(Number.isFinite(last.speed) && last.speed >= 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an upload without an uploadId emits no progress frames', async () => {
  const dir = tempDir();
  const { factory } = makeFakeClientFactory({ '/srv': { type: 'dir' } });
  const frames = [];
  const sender = { isDestroyed: () => false, send: (channel) => frames.push(channel) };
  const handlers = {};
  ftpBridge.configure({ tempDir: dir, clientFactory: factory });
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });

  try {
    await handlers['netcatty:ftp:upload']({ sender }, {
      host: '10.0.0.9',
      remoteDir: '/srv',
      files: [{ name: 'fw.bin', data: new Uint8Array(8).buffer }],
    });
  } finally {
    ftpBridge.configure(null);
  }

  assert.deepEqual(frames, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a destroyed window does not break the upload', async () => {
  const dir = tempDir();
  const { factory } = makeFakeClientFactory({ '/srv': { type: 'dir' } });
  const handlers = {};
  ftpBridge.configure({ tempDir: dir, clientFactory: factory });
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });

  try {
    const result = await handlers['netcatty:ftp:upload'](
      { sender: { isDestroyed: () => true, send: () => { throw new Error('no window'); } } },
      {
        host: '10.0.0.9',
        remoteDir: '/srv',
        uploadId: 'upload-2',
        files: [{ name: 'fw.bin', data: new Uint8Array(8).buffer }],
      },
    );
    assert.equal(result.ok, true);
  } finally {
    ftpBridge.configure(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('netcatty:ftp:capabilities reports the built-in client', async () => {
  const handlers = {};
  ftpBridge.registerHandlers({ handle: (channel, fn) => { handlers[channel] = fn; } });
  assert.deepEqual(await handlers['netcatty:ftp:capabilities']({}), { available: true });
});

test('redact strips credential pairs from any message', () => {
  assert.equal(
    ftpBridge.redact('open -u root,topsecret ftp://root:topsecret@h failed; password: abc123'),
    'open -u [REDACTED] ftp://h failed; password: [REDACTED]',
  );
});
