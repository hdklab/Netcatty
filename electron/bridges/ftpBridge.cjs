/**
 * FTP Bridge (terminal drag-and-drop uploads)
 *
 * Netcatty browses and transfers over FTP/FTPS through the in-process
 * `basic-ftp` client (see sftpBridge/ftpBackend.cjs). This module is the IPC
 * edge for the one path that does not go through an SFTP session: a file dropped
 * on a telnet/serial terminal, where there is no file panel and no SFTP.
 *
 * There is nothing to install and nothing to configure: the client ships with
 * the app, so every platform behaves the same. Credentials only ever travel in
 * the FTPS/FTP LOGIN exchange — never in argv, a temp script, or an error
 * message handed to the renderer.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { uploadFilesToEndpoint } = require('./sftpBridge/ftpBackend.cjs');

let _deps = null;

/**
 * @param {{ tempDir?: string, log?: (message: string) => void }} deps
 */
function configure(deps) {
  _deps = deps || null;
}

/** App temp dir (AGENTS.md: temp files never go to os.tmpdir()). */
function resolveAppTempDir() {
  if (typeof _deps?.tempDir === 'string' && _deps.tempDir.trim()) return _deps.tempDir;
  try {
    const tempDirBridge = require('./tempDirBridge.cjs');
    const dir = tempDirBridge.getTempDir?.();
    if (typeof dir === 'string' && dir.trim()) return dir;
  } catch {
    /* bridge unavailable (unit tests): fall through */
  }
  return os.tmpdir();
}

/**
 * Strip anything that looks like a credential pair from a message before it
 * travels to the renderer or a log.
 */
function redact(message) {
  return String(message)
    .replace(/(-u\s+)[^\s,]+,[^\s]+/g, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/(password[^:]*:\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Resolve the local file a drop entry refers to. The renderer either hands over
 * a real path (OS drag) or the bytes it got from a portal/virtual drop; the
 * second case is materialised into the app temp directory so the upload has
 * something to read, and the caller is told to clean it up afterwards.
 */
function materializeDropFile(file, stagingDir) {
  const direct = typeof file?.path === 'string' ? file.path.trim() : '';
  if (direct && fs.existsSync(direct)) {
    return { localPath: direct, cleanup: false };
  }
  const data = file?.data;
  if (!data) return null;
  let buffer;
  if (Buffer.isBuffer(data)) buffer = data;
  else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof data === 'string') buffer = Buffer.from(data, 'base64');
  else return null;

  const safeName = path.basename(String(file?.name || 'drop.bin')).replace(/[^\w.-]/g, '_') || 'drop.bin';
  const stagedPath = path.join(stagingDir, `nc-ftp-${process.pid}-${Date.now()}-${safeName}`);
  // The staging directory is created lazily by whoever gets here first: the OS
  // clears the temp dir (and it does not exist at all on a fresh install), so
  // writing straight into it would fail with ENOENT and lose the drop.
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stagedPath, buffer, { mode: 0o600 });
  return { localPath: stagedPath, cleanup: true };
}

/**
 * Upload files into `remoteDir` on an FTP/FTPS host.
 *
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
async function uploadFiles(options = {}) {
  return uploadFilesToEndpoint({
    ...options,
    tempDir: options.tempDir || resolveAppTempDir(),
    log: options.log || _deps?.log,
    clientFactory: options.clientFactory || _deps?.clientFactory,
  });
}

/** The client is built in, so FTP/FTPS transfers are always available. */
function getCapabilities() {
  return { available: true };
}

const UPLOAD_PROGRESS_CHANNEL = 'netcatty:ftp:upload-progress';
/** One progress frame per ~120 ms: the tracker ticks far faster than a bar redraws. */
const PROGRESS_INTERVAL_MS = 120;
/** In-flight drag-drop uploads, so the transfer center's Cancel can stop one. */
const activeUploads = new Map();

/**
 * Build a batch progress callback that forwards throttled frames to the window
 * that asked for the upload. The renderer correlates them by `uploadId`, so a
 * second drop in another terminal cannot move the first row.
 */
function createUploadProgressSender(sender, uploadId) {
  if (!uploadId || !sender || typeof sender.send !== 'function' || sender.isDestroyed?.()) {
    return () => {};
  }
  let lastSentAt = 0;
  let lastSentBytes = -1;
  const startedAt = Date.now();
  return (transferred, total, fileName) => {
    const now = Date.now();
    const reachedEnd = Number(total) > 0 && Number(transferred) >= Number(total);
    if (!reachedEnd && (now - lastSentAt < PROGRESS_INTERVAL_MS || transferred === lastSentBytes)) return;
    lastSentAt = now;
    lastSentBytes = transferred;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    try {
      sender.send(UPLOAD_PROGRESS_CHANNEL, {
        uploadId,
        transferred: Number(transferred) || 0,
        total: Number(total) || 0,
        // Average speed so far: the bar shows a rate, not a bouncing instant value.
        speed: Math.round((Number(transferred) || 0) / elapsedSeconds),
        ...(fileName ? { fileName } : {}),
      });
    } catch {
      /* the window may have closed mid-upload */
    }
  };
}

/** IPC surface used by the renderer's terminal drag-and-drop path. */
function registerHandlers(ipcMain) {
  ipcMain.handle('netcatty:ftp:capabilities', () => getCapabilities());
  // The transfer center's Cancel button for a drag-drop upload. Aborting closes
  // the data connection; the upload handler removes the half-written file.
  ipcMain.handle('netcatty:ftp:cancel-upload', (_event, uploadId) => {
    const controller = typeof uploadId === 'string' ? activeUploads.get(uploadId) : null;
    if (!controller) return { ok: false, code: 'not-found' };
    controller.abort();
    return { ok: true };
  });
  ipcMain.handle('netcatty:ftp:upload', async (event, payload = {}) => {
    const incoming = Array.isArray(payload.files) ? payload.files : [];
    if (incoming.length === 0) {
      return { ok: false, code: 'no-files', error: 'No files to upload' };
    }
    const stagingDir = path.join(resolveAppTempDir(), 'netcatty-ftp-staging');
    const staged = [];
    const uploadId = typeof payload.uploadId === 'string' ? payload.uploadId.trim() : '';
    const abortController = uploadId ? new AbortController() : null;
    if (uploadId && abortController) activeUploads.set(uploadId, abortController);
    const onProgress = createUploadProgressSender(event?.sender, uploadId);
    try {
      const files = [];
      for (const file of incoming) {
        const resolved = materializeDropFile(file, stagingDir);
        if (!resolved) {
          return { ok: false, code: 'no-file-data', error: `could not read ${file?.name || 'dropped file'}` };
        }
        if (resolved.cleanup) staged.push(resolved.localPath);
        files.push({ localPath: resolved.localPath, remoteName: file?.remoteName || file?.name });
      }
      return await uploadFiles({
        host: payload.host,
        port: payload.port,
        user: payload.user,
        password: payload.password,
        secure: payload.secure,
        insecure: payload.insecure,
        remoteDir: payload.remoteDir,
        timeoutMs: payload.timeoutMs,
        files,
        onProgress,
        signal: abortController?.signal,
      });
    } catch (error) {
      return { ok: false, code: 'unexpected', error: redact(error?.message || String(error)) };
    } finally {
      if (uploadId) activeUploads.delete(uploadId);
      for (const stagedPath of staged) {
        try {
          fs.unlinkSync(stagedPath);
        } catch {
          /* best effort */
        }
      }
    }
  });
}

module.exports = {
  configure,
  registerHandlers,
  uploadFiles,
  getCapabilities,
  redact,
  _internal: { redact, materializeDropFile, resolveAppTempDir },
};
