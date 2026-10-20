'use strict';

/**
 * FTP file-protocol backend (in-process `basic-ftp` client).
 *
 * Netcatty browses SSH hosts with ssh2 and shell-only hosts through the SCP
 * backend; a device that speaks neither — a telnet/serial box with an FTP
 * server, which is the normal shape of embedded equipment — had no file browser
 * at all, and asking the SFTP pane for one dialled SSH on the *telnet* port and
 * hung there forever. This backend gives the file panel a third mode: every
 * operation runs over one FTP/FTPS control connection, shaped like the SCP
 * backend so fileOps and transferBridge keep working unchanged.
 *
 * Why a library instead of the old external `lftp` driver: lftp ships no
 * official Windows binary (only Cygwin/MSYS builds with a DLL bag), its macOS
 * builds drag a dylib chain, and it is GPLv3. `basic-ftp` is MIT, has no
 * dependencies, runs the same on every platform and gives byte-level transfer
 * progress, so nothing has to be installed by the user.
 *
 * Contract notes:
 *   - One Client (one control connection) per backend, and basic-ftp allows no
 *     parallel commands, so every operation is serialized on one promise chain.
 *   - Credentials live in `client.access(...)` only; no argv, no temp script.
 *   - FTP exposes no chmod, no symlink metadata, and no per-path stat. stat() is
 *     therefore one listing of the parent directory, which every server speaks.
 *   - An abort closes the socket (the only way to interrupt a transfer), and the
 *     next operation reconnects transparently.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Writable, Readable } = require('node:stream');
const { Client } = require('basic-ftp');

/**
 * Socket inactivity timeout, not a cap on total transfer time: a large upload
 * over a slow link may take as long as it takes, it just may not stall.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

class FtpBackendError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'FtpBackendError';
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

function isFtpModeClient(client) {
  return !!(client && client.__netcattyFileProtocol === 'ftp');
}

function getFtpBackendForClient(client) {
  if (!client) throw new FtpBackendError('FTP session not found', 'ENOTFOUND');
  if (client.__netcattyFtpBackend) return client.__netcattyFtpBackend;
  const config = client.__netcattyFtpConfig;
  if (!config) throw new FtpBackendError('FTP session is missing its endpoint configuration', 'EINVAL');
  client.__netcattyFtpBackend = createFtpBackend(config);
  return client.__netcattyFtpBackend;
}

/**
 * Strip a credential pair from anything that may reach the renderer or a log.
 * basic-ftp redacts `PASS` in its own verbose output, but an error string built
 * from user input could still echo `user:password@host`.
 */
function scrubCredentials(text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/(-u\s+)[^\s,]+,[^\s]+/g, '$1[REDACTED]')
    .replace(/(password[^:]*:\s*)\S+/gi, '$1[REDACTED]');
}

/**
 * Map a basic-ftp / socket failure onto the codes fileOps already understands.
 * FTP reply codes are the reliable signal; the text is only a fallback for the
 * servers that answer 550 for "access denied" as well as "no such file".
 */
function mapFtpError(error) {
  if (error instanceof FtpBackendError) return error;
  const message = scrubCredentials(error?.message || 'FTP operation failed').trim();
  const text = message.toLowerCase();
  const reply = Number(error?.code);
  const code = Number.isFinite(reply) ? reply : null;

  if (code === 530) return new FtpBackendError(message, 'EAUTH', error);
  if (/permission denied|access denied|not allowed|read-only/.test(text)) {
    return new FtpBackendError(message, 'EACCES', error);
  }
  if (code === 550) {
    if (/not empty/.test(text)) return new FtpBackendError(message, 'ENOTEMPTY', error);
    return /exist/.test(text)
      ? new FtpBackendError(message, 'EEXIST', error)
      : new FtpBackendError(message, 'ENOENT', error);
  }
  if (code === 552) return new FtpBackendError(message, 'ENOSPC', error);
  if (code === 553) return new FtpBackendError(message, 'EACCES', error);
  if (/timeout|timed out/.test(`${text} ${error?.code || ''}`.toLowerCase())) {
    return new FtpBackendError('The FTP server did not answer in time', 'ETIMEDOUT', error);
  }
  if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') {
    return new FtpBackendError(message, 'ENOTFOUND', error);
  }
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'EPIPE') {
    return new FtpBackendError(message, error.code, error);
  }
  if (error?.code === 'ABORT_ERR') return new FtpBackendError(message, 'ABORT_ERR', error);
  return new FtpBackendError(message, 'EFTP', error);
}

/** `rwxr-xr-x` for the file list, when the server's listing carried bits. */
function formatUnixPermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') return undefined;
  const bits = [permissions.user, permissions.group, permissions.world];
  if (bits.some((value) => !Number.isFinite(Number(value)))) return undefined;
  let text = '';
  for (const value of bits) {
    const mode = Number(value);
    text += `${mode & 4 ? 'r' : '-'}${mode & 2 ? 'w' : '-'}${mode & 1 ? 'x' : '-'}`;
  }
  return text;
}

/**
 * Browser entry shape shared with the SCP backend.
 * @param {import('basic-ftp').FileInfo} info
 */
function toListEntry(info) {
  const name = String(info?.name ?? '').replace(/\/+$/, '');
  const sizeNum = Number(info?.size) || 0;
  const isDirectory = Boolean(info?.isDirectory);
  const isSymlink = Boolean(info?.isSymbolicLink);
  const permissions = formatUnixPermissions(info?.permissions);
  const modifyTime = info?.modifiedAt instanceof Date ? info.modifiedAt.getTime() : undefined;
  return {
    name,
    type: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
    linkTarget: isSymlink ? info?.link || null : null,
    size: `${isDirectory ? 0 : sizeNum} bytes`,
    lastModified: new Date(modifyTime || Date.now()).toISOString(),
    ...(permissions ? { permissions } : {}),
    ...(info?.user ? { owner: String(info.user) } : {}),
    ...(info?.group ? { group: String(info.group) } : {}),
    _size: isDirectory ? 0 : sizeNum,
    _modifyTime: modifyTime,
  };
}

function toStatResult(info, { fallbackPath } = {}) {
  if (!info) {
    // Root and any path we cannot see in its parent listing (a server that
    // refuses to list "/"): assume a directory rather than failing navigation.
    return {
      type: 'directory',
      isDirectory: true,
      isSymbolicLink: false,
      size: undefined,
      modifyTime: undefined,
      permissions: undefined,
      mode: undefined,
      path: fallbackPath,
    };
  }
  const isDirectory = Boolean(info.isDirectory);
  return {
    type: isDirectory ? 'directory' : info.isSymbolicLink ? 'symlink' : 'file',
    isDirectory,
    isSymbolicLink: Boolean(info.isSymbolicLink),
    size: isDirectory ? undefined : Number(info.size) || 0,
    modifyTime: info.modifiedAt instanceof Date ? info.modifiedAt.getTime() : undefined,
    permissions: formatUnixPermissions(info.permissions),
    mode: undefined,
    path: fallbackPath,
  };
}

function normalizeRemotePath(remotePath) {
  const raw = String(remotePath ?? '').trim();
  if (!raw || raw === '.') return '.';
  return raw;
}

function parentOf(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '.' || normalized === '/') return null;
  const parent = path.posix.dirname(normalized);
  if (!parent || parent === '.') return '/';
  return parent;
}

function baseNameOf(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return normalized;
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

/**
 * A remote path goes into a raw FTP command line (`MKD <path>`), so a CR/LF in
 * it would inject a second command. Reject the whole class instead of trimming.
 */
function assertSafeRemotePath(remotePath) {
  const value = String(remotePath ?? '');
  if (/[\r\n\0]/.test(value)) {
    throw new FtpBackendError('Remote path contains a control character', 'EINVAL');
  }
  return value;
}

/** Join a remote directory and a file name without doubling or dropping slashes. */
function joinRemotePath(dir, name) {
  const base = String(dir ?? '').trim();
  if (!base || base === '.' || base === '/') return base === '/' ? `/${name}` : name;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

/**
 * Create the FTP backend for one endpoint.
 *
 * @param {{
 *   host: string, port?: number, user?: string, password?: string,
 *   secure?: boolean, insecure?: boolean,
 *   tempDir?: string, timeoutMs?: number,
 *   log?: (message: string, detail?: unknown) => void,
 * }} config
 */
function createFtpBackend(config = {}) {
  const endpoint = {
    host: String(config.host || '').trim(),
    port: Number(config.port) > 0 ? Number(config.port) : 21,
    user: config.user ? String(config.user) : undefined,
    password: typeof config.password === 'string' ? config.password : undefined,
    secure: Boolean(config.secure),
    insecure: Boolean(config.insecure),
  };
  if (!endpoint.host) throw new FtpBackendError('FTP host is required', 'EINVAL');

  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const tempDir = config.tempDir;
  const log = typeof config.log === 'function' ? config.log : () => {};
  /** Test seam: suites inject a scripted client instead of dialling a server. */
  const makeClient = typeof config.clientFactory === 'function'
    ? config.clientFactory
    : (timeout) => new Client(timeout);

  /** @type {import('basic-ftp').Client | null} */
  let client = null;
  /** Serializes operations: basic-ftp multiplexes nothing on one connection. */
  let chain = Promise.resolve();
  let disposed = false;

  function assertUsable() {
    if (disposed) throw new FtpBackendError('FTP session is closed', 'ECONNRESET');
  }

  function accessOptions() {
    return {
      host: endpoint.host,
      port: endpoint.port,
      user: endpoint.user,
      password: endpoint.password,
      // `true` is explicit FTPS (AUTH TLS), which is what the host's
      // "FTPS (explicit TLS)" toggle has always meant.
      secure: endpoint.secure ? true : false,
      ...(endpoint.secure && endpoint.insecure
        ? { secureOptions: { rejectUnauthorized: false } }
        : {}),
    };
  }

  async function connect() {
    if (client && !client.closed) return client;
    const next = makeClient(timeoutMs);
    next.ftp.log = (message) => log(`[FTP] ${message}`);
    try {
      await next.access(accessOptions());
    } catch (error) {
      next.close();
      throw mapFtpError(error);
    }
    client = next;
    return client;
  }

  /**
   * Run one operation against the shared connection.
   *
   * @template T
   * @param {(conn: import('basic-ftp').Client) => Promise<T>} fn
   * @param {{ signal?: AbortSignal | null }} [options]
   * @returns {Promise<T>}
   */
  function run(fn, options = {}) {
    assertUsable();
    const signal = options.signal || null;
    const task = chain.then(async () => {
      assertUsable();
      if (signal?.aborted) throw new FtpBackendError('FTP operation cancelled', 'ABORT_ERR');
      const conn = await connect();
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Closing the socket is the only way to interrupt an in-flight
        // transfer; connect() reopens on the next operation.
        try {
          conn.close();
        } catch {
          /* already closed */
        }
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        return await fn(conn);
      } catch (error) {
        if (aborted || signal?.aborted) {
          throw new FtpBackendError('FTP operation cancelled', 'ABORT_ERR', error);
        }
        throw mapFtpError(error);
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        if (aborted) client = null;
      }
    });
    // Keep the queue alive after a failure without swallowing it for the caller.
    chain = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Report transfer bytes as (transferred, total) for one operation. */
  function withProgress(conn, onProgress, total, { expect } = {}) {
    if (typeof onProgress !== 'function') return () => {};
    conn.trackProgress((info) => {
      if (expect && info.type !== expect) return;
      onProgress(Number(info.bytesOverall) || 0, total);
    });
    return () => conn.trackProgress();
  }

  /** One listing of `remotePath` (absolute or `.` for the login directory). */
  async function listInfos(conn, remotePath) {
    const dir = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const infos = await conn.list(dir === '.' ? undefined : dir);
    return infos.filter((info) => info.name !== '.' && info.name !== '..' && info.name !== '');
  }

  /** Find one entry by listing its parent, which every FTP server supports. */
  async function findInfo(conn, target) {
    const parent = parentOf(target);
    const base = baseNameOf(target);
    const siblings = await listInfos(conn, parent ?? '/').catch(() => []);
    const hit = siblings.find((info) => info.name === base);
    if (hit) return hit;
    // A server that refuses to list the parent may still list the path itself.
    const direct = await listInfos(conn, target).catch(() => []);
    return direct.find((info) => info.name === base) || null;
  }

  // ---------------------------------------------------------------- browsing

  async function list(remotePath, options = {}) {
    return run(async (conn) => {
      const infos = await listInfos(conn, remotePath);
      return infos.map(toListEntry);
    }, options);
  }

  async function stat(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '/' || target === '.') {
      return toStatResult(null, { fallbackPath: target });
    }
    return run(async (conn) => {
      const info = await findInfo(conn, target);
      if (!info) throw new FtpBackendError(`No such file or directory: ${target}`, 'ENOENT');
      return toStatResult(info, { fallbackPath: target });
    }, options);
  }

  /** The login directory. */
  async function homeDir() {
    return run((conn) => conn.pwd());
  }

  async function realpath(remotePath) {
    const target = assertSafeRemotePath(normalizeRemotePath(remotePath));
    return run(async (conn) => {
      const before = await conn.pwd();
      try {
        await conn.cd(target);
        const resolved = await conn.pwd();
        return resolved.startsWith('/') ? resolved : `/${resolved}`;
      } finally {
        // `.`/relative paths in later operations resolve against the login
        // directory, so a path lookup must not move the connection's cwd.
        await conn.cd(before).catch(() => {});
      }
    });
  }

  // ------------------------------------------------------------------- writes

  async function mkdir(remotePath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    if (target === '.' || target === '/') return true;
    await run(async (conn) => {
      if (options.recursive === false) {
        await conn.send(`MKD ${target}`);
        return;
      }
      // ensureDir also changes the working directory, which `.`-relative
      // operations would then see; restore it.
      const before = await conn.pwd().catch(() => null);
      try {
        await conn.ensureDir(target);
      } finally {
        if (before) await conn.cd(before).catch(() => {});
      }
    }, { signal: options.signal || null });
    return true;
  }

  /** Create the parent directories of `target` so an upload cannot fail on them. */
  async function ensureParent(conn, target) {
    const parent = parentOf(target);
    if (!parent || parent === '.' || parent === '/' || parent === target) return;
    const before = await conn.pwd().catch(() => null);
    try {
      await conn.ensureDir(parent);
    } finally {
      if (before) await conn.cd(before).catch(() => {});
    }
  }

  async function remove(remotePath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    await run(async (conn) => {
      const info = await findInfo(conn, target).catch(() => null);
      if (info?.isDirectory) {
        if (options.recursive === false) await conn.removeEmptyDir(target);
        else await conn.removeDir(target);
        return;
      }
      // A file (or an entry we could not see): REMOVE is also what an empty
      // directory needs, and a missing path is reported as ENOENT rather than
      // silently succeeding.
      await conn.remove(target);
    }, { signal: options.signal || null });
    return true;
  }

  async function unlink(remotePath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    await run((conn) => conn.remove(target), { signal: options.signal || null });
    return true;
  }

  async function rename(oldPath, newPath, options = {}) {
    const from = assertSafeRemotePath(normalizeRemotePath(oldPath));
    const to = assertSafeRemotePath(normalizeRemotePath(newPath));
    await run((conn) => conn.rename(from, to), { signal: options.signal || null });
    return true;
  }

  /**
   * FTP has no mode concept. This must NOT throw: the transfer pipeline calls it
   * after the bytes are already committed (restoring the previous mode), and a
   * rejection there turns a successful upload into a failed transfer. Callers
   * that need to tell the user (the permissions dialog) check the capability
   * first — see the FTP guard in fileOps' chmodSftp.
   */
  async function chmod() {
    return { supported: false };
  }

  // ------------------------------------------------------------------ content

  /** Collect a download into a Buffer without spilling to a temp file. */
  async function readFile(remotePath, options = {}) {
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : null;
    if (maxBytes) {
      const attrs = await stat(remotePath, options).catch(() => null);
      if (attrs && Number.isFinite(attrs.size) && attrs.size > maxBytes) {
        throw tooLarge(attrs.size, maxBytes);
      }
    }
    const chunks = [];
    let total = 0;
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          callback(tooLarge(total, maxBytes));
          return;
        }
        chunks.push(chunk);
        callback();
      },
    });
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    await run((conn) => conn.downloadTo(sink, target), { signal: options.signal || null });
    return Buffer.concat(chunks);
  }

  function tooLarge(actualBytes, maxBytes) {
    const error = new FtpBackendError(
      `Remote file is too large to read into memory (${actualBytes} bytes; maximum ${maxBytes} bytes).`,
      'SFTP_READ_TOO_LARGE',
    );
    error.maxBytes = maxBytes;
    error.actualBytes = actualBytes;
    return error;
  }

  async function writeFile(remotePath, content, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
    await run(async (conn) => {
      await ensureParent(conn, target);
      const source = new Readable({
        read() {
          this.push(buffer);
          this.push(null);
        },
      });
      await conn.uploadFrom(source, target);
    }, { signal: options.signal || null });
    return true;
  }

  async function uploadFile(localPath, remotePath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const expectedSize = Number(options.fileSize) > 0
      ? Number(options.fileSize)
      : (() => {
        try { return fs.statSync(localPath).size; } catch { return 0; }
      })();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    onProgress?.(0, expectedSize);

    await run(async (conn) => {
      await ensureParent(conn, target);
      const stopProgress = withProgress(conn, onProgress, expectedSize, { expect: 'upload' });
      try {
        await conn.uploadFrom(localPath, target);
      } finally {
        stopProgress();
      }
    }, { signal: options.signal || null });

    onProgress?.(expectedSize, expectedSize);
    return true;
  }

  /**
   * Stream a download straight into the caller's writable (no staging file).
   * basic-ftp ends the stream it is given, so it gets our own sink which
   * forwards chunks and leaves the caller's writable open for the next file.
   */
  async function downloadToWritable(remotePath, writable, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const expectedSize = Number(options.fileSize) > 0 ? Number(options.fileSize) : 0;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    let transferred = 0;

    const sink = new Writable({
      write(chunk, _encoding, callback) {
        transferred += chunk.length;
        onProgress?.(transferred, expectedSize || transferred);
        if (writable.write(chunk)) {
          callback();
          return;
        }
        // Honour backpressure from the caller instead of buffering the file.
        writable.once('drain', callback);
      },
    });
    const onWritableError = (error) => {
      try { sink.destroy(error); } catch { /* already gone */ }
    };
    writable.on?.('error', onWritableError);

    try {
      await run((conn) => conn.downloadTo(sink, target), { signal: options.signal || null });
      return { bytes: transferred };
    } finally {
      writable.removeListener?.('error', onWritableError);
    }
  }

  /**
   * Download into `localPath` atomically: the bytes land in a sibling `.part`
   * file and are renamed only once the size matches, so a partial transfer never
   * shows up as a finished file.
   */
  async function downloadFile(remotePath, localPath, options = {}) {
    const expectedSize = Number(options.fileSize) > 0 ? Number(options.fileSize) : 0;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const tempPath = `${localPath}.nc-ftp-part`;
    removeLocalFile(tempPath);
    onProgress?.(0, expectedSize);

    try {
      await downloadToLocalFile(remotePath, tempPath, { ...options, onProgress });
    } catch (error) {
      removeLocalFile(tempPath);
      throw error;
    }

    const downloadedSize = fileSize(tempPath);
    if (expectedSize > 0 && downloadedSize !== expectedSize) {
      removeLocalFile(tempPath);
      throw new FtpBackendError(
        `FTP download size mismatch: expected ${expectedSize} bytes, received ${downloadedSize}`,
        'EBADMSG',
      );
    }
    fs.renameSync(tempPath, localPath);
    onProgress?.(downloadedSize, expectedSize || downloadedSize);
    return { bytes: downloadedSize };
  }

  async function downloadToLocalFile(remotePath, localPath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const expectedSize = Number(options.fileSize) > 0 ? Number(options.fileSize) : 0;
    await run(async (conn) => {
      const stopProgress = withProgress(conn, options.onProgress, expectedSize, { expect: 'download' });
      try {
        await conn.downloadTo(localPath, target);
      } finally {
        stopProgress();
      }
    }, { signal: options.signal || null });
  }

  /**
   * Stage a download in the app temp dir first. The pane's in-memory reads and
   * the editor both go through this path when a partial write must not be
   * visible.
   */
  async function downloadToTempFile(remotePath, options = {}) {
    const target = normalizeRemotePath(assertSafeRemotePath(remotePath));
    const dir = tempDir || require('node:os').tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const stagedPath = path.join(
      dir,
      `nc-ftp-${process.pid}-${Date.now()}-${baseNameOf(target) || 'download'}`,
    );
    try {
      await downloadToLocalFile(target, stagedPath, options);
    } catch (error) {
      removeLocalFile(stagedPath);
      throw error;
    }
    return { path: stagedPath, size: fileSize(stagedPath) };
  }

  function fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  function removeLocalFile(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best effort */
    }
  }

  /** Close the control connection (used by closeSftp and on session teardown). */
  function abortAll() {
    try {
      client?.close();
    } catch {
      /* already closed */
    }
    client = null;
  }

  function dispose() {
    disposed = true;
    abortAll();
  }

  return {
    kind: 'ftp',
    endpoint,
    list,
    stat,
    lstat: stat,
    realpath,
    homeDir,
    mkdir,
    remove,
    unlink,
    rename,
    chmod,
    readFile,
    writeFile,
    uploadFile,
    downloadFile,
    downloadToWritable,
    downloadToTempFile,
    abortAll,
    dispose,
  };
}

/**
 * Upload a batch of local files with one connection (terminal drag-and-drop).
 *
 * `onProgress(transferredBytes, totalBytes, remoteName)` reports the whole batch,
 * not one file at a time, so the transfer center can draw a single determinate
 * row over everything the user dropped.
 */
async function uploadFilesToEndpoint(options = {}) {
  const files = Array.isArray(options.files) ? options.files : [];
  if (files.length === 0) return { ok: false, code: 'no-files', error: 'No files to upload' };
  if (!String(options.host || '').trim()) {
    return { ok: false, code: 'invalid-request', error: 'FTP host is required' };
  }
  const backend = createFtpBackend({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    secure: options.secure,
    insecure: options.insecure,
    tempDir: options.tempDir,
    timeoutMs: options.timeoutMs,
    log: options.log,
    clientFactory: options.clientFactory,
  });
  const remoteDir = String(options.remoteDir ?? '').trim();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const sizes = files.map((file) => {
    try {
      return fs.statSync(String(file?.localPath || '')).size;
    } catch {
      return 0;
    }
  });
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  let completedBytes = 0;
  /** The target whose bytes are in flight, so an abort can remove the stub. */
  let inFlightTarget = null;
  try {
    onProgress?.(0, totalBytes, '');
    for (const [index, file] of files.entries()) {
      const localPath = String(file?.localPath || '').trim();
      if (!localPath) return { ok: false, code: 'invalid-request', error: 'file entry is missing localPath' };
      const remoteName = String(file?.remoteName || path.basename(localPath));
      const target = joinRemotePath(remoteDir, remoteName);
      const fileSize = sizes[index];
      const base = completedBytes;
      inFlightTarget = target;
      // eslint-disable-next-line no-await-in-loop
      await backend.uploadFile(localPath, target, {
        fileSize,
        signal: options.signal || null,
        onProgress: onProgress
          ? (done) => onProgress(base + Math.min(Number(done) || 0, fileSize), totalBytes, remoteName)
          : null,
      });
      inFlightTarget = null;
      completedBytes += fileSize;
      onProgress?.(completedBytes, totalBytes, remoteName);
    }
    return { ok: true, totalBytes };
  } catch (error) {
    // A cancelled upload must not leave a truncated file on the device.
    if (error?.code === 'ABORT_ERR' && inFlightTarget) {
      await backend.unlink(inFlightTarget).catch(() => {});
    }
    return {
      ok: false,
      code: error?.code || 'EFTP',
      error: scrubCredentials(error?.message || String(error)),
      totalBytes,
      transferredBytes: completedBytes,
    };
  } finally {
    backend.dispose();
  }
}

module.exports = {
  FtpBackendError,
  createFtpBackend,
  getFtpBackendForClient,
  isFtpModeClient,
  uploadFilesToEndpoint,
  joinRemotePath,
  _internal: {
    mapFtpError,
    toStatResult,
    toListEntry,
    parentOf,
    baseNameOf,
    joinRemotePath,
    formatUnixPermissions,
    scrubCredentials,
  },
};
