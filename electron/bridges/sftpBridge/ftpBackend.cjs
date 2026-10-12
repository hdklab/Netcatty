'use strict';

/**
 * FTP file-protocol backend (external `lftp` driver).
 *
 * Netcatty browses SSH hosts with ssh2 and shell-only hosts through the SCP
 * backend; a device that speaks neither — a telnet/serial box with an FTP
 * server, which is the normal shape of embedded equipment — had no file browser
 * at all, and asking the SFTP pane for one dialled SSH on the *telnet* port and
 * hung there forever. This backend gives the file panel a third mode: every
 * operation is one `lftp` script against the FTP/FTPS endpoint, shaped like the
 * SCP backend so fileOps and transferBridge keep working unchanged.
 *
 * Contract notes:
 *   - The password only ever lives inside the 0600 script (see ftpBridge.cjs);
 *     it is never passed in argv.
 *   - FTP exposes no chmod, no symlink metadata, and no per-path stat. stat() is
 *     therefore one listing of the parent directory, which every server speaks.
 *   - Every operation is its own lftp process; handles are tracked so closeSftp
 *     can kill an in-flight operation.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runLftpCommands } = require('../ftpBridge.cjs');
const { parseLsModeToPermissions, lsModeToNumber } = require('./scpShell.cjs');

const DEFAULT_OP_TIMEOUT_MS = 30_000;
/** 0 lets ftpBridge apply its own ceiling (120 s) for whole-file transfers. */
const DEFAULT_TRANSFER_TIMEOUT_MS = 0;
const PROGRESS_POLL_MS = 400;
/**
 * `ls -l`-style listings, which is what lftp's `cls -l` prints.
 * The link-count column is optional: lftp's own rendering omits it, while a raw
 * server LIST (embedded devices) usually carries it — e.g.
 * `-rwxr-xr-x    1 0        0          114924 Jan  1  1970 fw.bin`.
 */
const LISTING_LINE_RE = /^(?<type>[-dlbcpsD])(?<mode>[rwxsStT-]{9})\s+(?:(?<links>\d+)\s+)?(?<owner>\S+)\s+(?<group>\S+)\s+(?<size>\d+)\s+(?<month>[A-Za-z]{3,})\s+(?<day>\d{1,2})\s+(?<timeOrYear>\d{2}:\d{2}|\d{4})\s+(?<name>.+)$/;
/** MS-DOS style listings (rare on these devices, but cheap to accept). */
const MSDOS_LINE_RE = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(AM|PM)\s+(<DIR>|\d+)\s+(.+)$/i;
const SKIP_LINE_RE = /^\s*(total\s+\d+|total\s*)$/i;
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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

/** Map an lftp failure onto the codes fileOps already understands. */
function mapLftpFailure(result) {
  const message = scrubCredentials(result?.error || result?.stderr || 'FTP operation failed').trim();
  const text = message.toLowerCase();
  if (/no such file|not found|not exist|\b550\b/.test(text)) return new FtpBackendError(message, 'ENOENT');
  if (/login failed|not logged in|\b530\b/.test(text)) return new FtpBackendError(message, 'EAUTH');
  if (/permission denied|access failed|\b553\b/.test(text)) return new FtpBackendError(message, 'EACCES');
  if (result?.code === 'timeout') return new FtpBackendError('The FTP server did not answer in time', 'ETIMEDOUT');
  if (result?.code === 'lftp-not-found') {
    return new FtpBackendError(
      'lftp is not installed. Install it (apt install lftp / brew install lftp) and retry.',
      'LFTP_NOT_FOUND',
    );
  }
  return new FtpBackendError(message, result?.code || 'EFTP');
}

/** Resolve an `ls -l` date column (year or time-of-day) to epoch ms. */
function resolveListingDate(monthName, day, timeOrYear, now = new Date()) {
  const month = MONTHS[String(monthName || '').toLowerCase().slice(0, 3)];
  const dayNumber = Number(day);
  if (month === undefined || !Number.isFinite(dayNumber) || dayNumber < 1 || dayNumber > 31) return undefined;

  if (/^\d{4}$/.test(timeOrYear)) {
    return new Date(Number(timeOrYear), month, dayNumber).getTime();
  }
  const match = /^(\d{2}):(\d{2})$/.exec(timeOrYear);
  if (!match) return undefined;
  const year = now.getFullYear();
  const candidate = new Date(year, month, dayNumber, Number(match[1]), Number(match[2]));
  // A listing without a year means "this year"; a date more than a day ahead of
  // the local clock is a file from last year (ls does the same rounding).
  if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    candidate.setFullYear(year - 1);
  }
  return candidate.getTime();
}

/**
 * Parse one listing line into a browser record.
 * Handles lftp's normalized `cls -l` output and plain `ls -l` output; returns
 * null for `total`/blank lines and for anything unparseable.
 */
function parseListingLine(line, { now = new Date() } = {}) {
  const text = String(line || '').replace(/\r$/, '');
  if (!text.trim() || SKIP_LINE_RE.test(text)) return null;

  const msdos = MSDOS_LINE_RE.exec(text);
  if (msdos) {
    const [, monthText, dayText, yearText, hourText, minuteText, meridiem, sizeText, name] = msdos;
    let hours = Number(hourText) % 12;
    if (String(meridiem).toUpperCase() === 'PM') hours += 12;
    const isDirectory = sizeText === '<DIR>';
    return {
      name: stripTrailingSlash(name),
      type: isDirectory ? 'directory' : 'file',
      linkTarget: null,
      size: isDirectory ? 0 : Number(sizeText) || 0,
      modifyTime: new Date(
        2000 + Number(yearText),
        Number(monthText) - 1,
        Number(dayText),
        hours,
        Number(minuteText),
      ).getTime(),
      permissions: undefined,
      owner: undefined,
    };
  }

  const match = LISTING_LINE_RE.exec(text);
  if (!match?.groups) return null;
  // Named groups: the link-count column is optional, so positional groups
  // would silently shift when a server omits it.
  const {
    type: typeChar,
    mode: modeText,
    owner,
    group,
    size: sizeText,
    month: monthText,
    day: dayText,
    timeOrYear,
    name: rawName,
  } = match.groups;

  let name = rawName;
  let linkTarget = null;
  const arrow = name.indexOf(' -> ');
  if (arrow !== -1) {
    linkTarget = name.slice(arrow + 4).trim();
    name = name.slice(0, arrow);
  }
  name = stripTrailingSlash(name).replace(/^\.\//, '');
  if (!name || name === '.' || name === '..') return null;

  const isDirectory = typeChar === 'd';
  const isSymlink = typeChar === 'l' || linkTarget !== null;
  // lftp prints dashes when the server's LIST has no usable permission bits.
  const permissions = /[rwxs-]{9}/.test(modeText) && /[rwx]/.test(modeText)
    ? parseLsModeToPermissions(`-${modeText}`)
    : undefined;
  const mode = permissions ? lsModeToNumber(`-${modeText}`) : undefined;

  return {
    name,
    type: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
    linkTarget,
    size: isDirectory ? 0 : Number(sizeText) || 0,
    modifyTime: resolveListingDate(monthText, dayText, timeOrYear, now),
    permissions,
    mode,
    owner: owner && !/^\d+$/.test(owner) ? owner : undefined,
    group: group || undefined,
  };
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * lftp renders the current directory as `ftp://user:password@host:port/path`
 * (pwd output, and some error strings). The password must never leave the
 * backend, so credential-bearing URLs are stripped wherever lftp output is
 * turned into data, and `open -u user,pass` echoes are redacted as well.
 */
function scrubCredentials(text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/(-u\s+)[^\s,]+,[^\s]+/g, '$1[REDACTED]');
}

/** Pull the remote path out of an lftp URL line (`ftp://user:pass@h:21/tmp`). */
function pathFromLftpUrlLine(line) {
  const text = scrubCredentials(String(line || '').trim());
  const urlMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(text);
  if (urlMatch) return urlMatch[1] || '/';
  return text;
}

function parseListing(stdout, options = {}) {
  const records = [];
  for (const line of String(stdout || '').split('\n')) {
    const record = parseListingLine(line, options);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Fallback listing: `cls -1` prints bare names (directories suffixed with `/`),
 * used when a server's long listing is a format we cannot parse. Types are then
 * only as good as the trailing slash, which beats showing nothing at all.
 */
function parseNameListing(stdout) {
  const records = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    const isDirectory = /\/$/.test(line);
    const name = stripTrailingSlash(line.replace(/^\.\//, '')).split('/').pop();
    if (!name || name === '.' || name === '..') continue;
    records.push({
      name,
      type: isDirectory ? 'directory' : 'file',
      linkTarget: null,
      size: 0,
      modifyTime: undefined,
      permissions: undefined,
      unresolved: true,
    });
  }
  return records;
}

/** Browser entry shape shared with the SCP backend. */
function toListEntry(record) {
  const sizeNum = Number(record.size) || 0;
  return {
    name: record.name,
    type: record.type,
    linkTarget: record.type === 'symlink' ? record.linkTarget || null : null,
    size: `${sizeNum} bytes`,
    lastModified: new Date(record.modifyTime || Date.now()).toISOString(),
    ...(record.permissions ? { permissions: record.permissions } : {}),
    ...(record.owner ? { owner: record.owner } : {}),
    _size: sizeNum,
    _modifyTime: record.modifyTime,
  };
}

function toStatResult(record, { fallbackPath } = {}) {
  const isDirectory = record?.type === 'directory';
  const isSymbolicLink = record?.type === 'symlink';
  if (!record) {
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
  return {
    type: record.type,
    isDirectory,
    isSymbolicLink,
    size: isDirectory ? undefined : Number(record.size) || 0,
    modifyTime: record.modifyTime,
    permissions: record.permissions,
    mode: record.mode,
    path: fallbackPath,
  };
}

/** Quote a remote token for lftp (double-quote grammar). */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
  if (!parent || parent === '.' ) return '/';
  return parent;
}

function baseNameOf(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return normalized;
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

/** Read /proc/<pid>/io to estimate upload progress on Linux; 0 elsewhere. */
function readProcessReadBytes(pid) {
  if (!pid || process.platform !== 'linux') return 0;
  try {
    const text = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const match = /^rchar:\s*(\d+)$/m.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Create the FTP backend for one endpoint.
 *
 * @param {{
 *   host: string, port?: number, user?: string, password?: string,
 *   secure?: boolean, insecure?: boolean,
 *   tempDir?: string, settings?: string[], timeoutMs?: number,
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

  const settings = ['set ftp:list-options -a', ...(Array.isArray(config.settings) ? config.settings : [])];
  const tempDir = config.tempDir;
  const log = typeof config.log === 'function' ? config.log : () => {};
  const activeChildren = new Set();
  let disposed = false;

  function assertUsable() {
    if (disposed) throw new FtpBackendError('FTP session is closed', 'ECONNRESET');
  }

  async function run(commands, options = {}) {
    assertUsable();
    const signal = options.signal || null;
    if (signal?.aborted) throw new FtpBackendError('FTP operation cancelled', 'ABORT_ERR');

    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : (Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : undefined);

    let killed = false;
    let onAbort = null;
    const result = await runLftpCommands({
      ...endpoint,
      commands,
      settings: [...settings, ...(options.settings || [])],
      tempDir,
      timeoutMs,
      scriptTag: options.scriptTag || 'op',
      onProcess: (child) => {
        activeChildren.add(child);
        onAbort = () => {
          killed = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        child.on('close', () => activeChildren.delete(child));
      },
    });

    if (onAbort) signal?.removeEventListener?.('abort', onAbort);
    if (killed || signal?.aborted) throw new FtpBackendError('FTP operation cancelled', 'ABORT_ERR');
    if (!result.ok) throw mapLftpFailure(result);
    return result;
  }

  /** One long-format listing of `remotePath` (cd first, so names stay bare). */
  async function rawListing(remotePath, { signal, timeoutMs } = {}) {
    const dir = normalizeRemotePath(remotePath);
    const commands = [];
    if (dir !== '.') commands.push(`cd ${quote(dir)}`);
    commands.push('cls -l');
    const result = await run(commands, { signal, timeoutMs, scriptTag: 'list' });
    return scrubCredentials(result.stdout.toString('utf8'));
  }

  // ---------------------------------------------------------------- browsing

  async function list(remotePath, options = {}) {
    const signal = options.signal || null;
    const stdout = await rawListing(remotePath, { signal, timeoutMs: options.timeoutMs });
    let records = parseListing(stdout);
    if (records.length === 0 && stdout.trim()) {
      // A long listing we cannot read (unusual server format) still has a
      // name-only fallback, which at least keeps navigation possible.
      console.log(`[FTP] Long listing was unparseable; falling back to cls -1 (${JSON.stringify(stdout.split('\n').slice(0, 5))})`);
      const dir = normalizeRemotePath(remotePath);
      const commands = [];
      if (dir !== '.') commands.push(`cd ${quote(dir)}`);
      commands.push('cls -1');
      const names = await run(commands, { signal, scriptTag: 'list-names' });
      records = parseNameListing(names.stdout.toString('utf8'));
    }
    return records.map(toListEntry);
  }

  async function stat(remotePath, options = {}) {
    const signal = options.signal || null;
    const target = normalizeRemotePath(remotePath);
    if (target === '/' || target === '.') {
      return toStatResult(null, { fallbackPath: target });
    }
    const parent = parentOf(target);
    const base = baseNameOf(target);
    const stdout = await rawListing(parent ?? '/', { signal, timeoutMs: options.timeoutMs });
    const record = parseListing(stdout).find((entry) => entry.name === base);
    if (!record) {
      // The server may already have listed just this path.
      const direct = parseListing(await rawListing(target, { signal, timeoutMs: options.timeoutMs }))
        .find((entry) => entry.name === base);
      if (direct) return toStatResult(direct, { fallbackPath: target });
      throw new FtpBackendError(`No such file or directory: ${target}`, 'ENOENT');
    }
    return toStatResult(record, { fallbackPath: target });
  }

  async function homeDir() {
    const result = await run(['pwd'], { scriptTag: 'pwd' });
    const line = result.stdout.toString('utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop() || '';
    // lftp prints the endpoint URL before the path; only the path is returned.
    return pathFromLftpUrlLine(line) || '/';
  }

  async function realpath(remotePath) {
    const target = normalizeRemotePath(remotePath);
    const result = await run([`cd ${quote(target)}`, 'pwd'], { scriptTag: 'realpath' });
    const line = result.stdout.toString('utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop() || '';
    const resolved = pathFromLftpUrlLine(line);
    return resolved.startsWith('/') ? resolved : `/${resolved}`;
  }

  // ------------------------------------------------------------------- writes

  async function mkdir(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    if (target === '.' || target === '/') return true;
    if (options.recursive !== false) {
      await ensureDir(target, { signal: options.signal || null });
      return true;
    }
    await run([`mkdir -f ${quote(target)}`], { signal: options.signal || null, scriptTag: 'mkdir' });
    return true;
  }

  /**
   * lftp has no recursive mkdir and still fails on a missing parent, so the
   * segments are created top-down. `mkdir -f` ignores an existing directory, so
   * a failure here is real (an unwritable parent, a file in the way) and is
   * reported instead of being swallowed — "New folder" must not lie.
   */
  async function ensureDir(remotePath, { signal } = {}) {
    const target = normalizeRemotePath(remotePath);
    if (!target || target === '.' || target === '/') return;
    const absolute = target.startsWith('/');
    const segments = target.split('/').filter(Boolean);
    let current = absolute ? '' : '.';
    for (const segment of segments) {
      current = current === '.' ? segment : `${current}/${segment}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await run([`mkdir -f ${quote(current)}`], { signal, scriptTag: 'mkdir' });
      } catch (error) {
        // Some servers reject `mkdir -f` on an existing directory; only treat
        // the segment as present when it really lists as a directory.
        // eslint-disable-next-line no-await-in-loop
        const attrs = await stat(current, { signal }).catch(() => null);
        if (!attrs?.isDirectory) throw error;
      }
    }
  }

  /**
   * Remove a remote path. lftp parses options *before* operands, so the flags
   * must lead: `rm "/x" -f` makes lftp try to delete a file literally named
   * `-f` (server answers `550 Error (/-f)`).
   */
  async function remove(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const flags = options.recursive === false ? "-f" : "-rf";
    await run([`rm ${flags} ${quote(target)}`], { signal: options.signal || null, scriptTag: "remove" });
    return true;
  }

  async function unlink(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    await run([`rm -f ${quote(target)}`], { signal: options.signal || null, scriptTag: "unlink" });
    return true;
  }

  async function rename(oldPath, newPath, options = {}) {
    await run(
      [`mv ${quote(normalizeRemotePath(oldPath))} ${quote(normalizeRemotePath(newPath))}`],
      { signal: options.signal || null, scriptTag: 'rename' },
    );
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

  async function readFile(remotePath, options = {}) {
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : null;
    if (maxBytes) {
      const attrs = await stat(remotePath, options).catch(() => null);
      if (attrs && Number.isFinite(attrs.size) && attrs.size > maxBytes) {
        const error = new FtpBackendError(
          `Remote file is too large to read into memory (${attrs.size} bytes; maximum ${maxBytes} bytes).`,
          'SFTP_READ_TOO_LARGE',
        );
        error.maxBytes = maxBytes;
        error.actualBytes = attrs.size;
        throw error;
      }
    }
    const result = await run([`cat ${quote(normalizeRemotePath(remotePath))}`], {
      signal: options.signal || null,
      timeoutMs: options.timeoutMs,
      scriptTag: 'read',
    });
    if (maxBytes && result.stdout.length > maxBytes) {
      const error = new FtpBackendError(
        `Remote file is too large to read into memory (maximum ${maxBytes} bytes).`,
        'SFTP_READ_TOO_LARGE',
      );
      error.maxBytes = maxBytes;
      error.actualBytes = result.stdout.length;
      throw error;
    }
    return result.stdout;
  }

  async function writeFile(remotePath, content, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
    const staged = stageLocalFile(buffer, tempDir, 'write');
    const signal = options.signal || null;
    try {
      const parent = parentOf(target);
      const commands = [];
      if (parent && parent !== '.' && parent !== '/') {
        await ensureDir(parent, { signal });
        commands.push(`cd ${quote(parent)}`);
      }
      commands.push(`put ${quote(staged)} -o ${quote(baseNameOf(target))}`);
      await run(commands, { signal, scriptTag: 'write' });
      return true;
    } finally {
      removeLocalFile(staged);
    }
  }

  async function uploadFile(localPath, remotePath, options = {}) {
    const signal = options.signal || null;
    const target = normalizeRemotePath(remotePath);
    const parent = parentOf(target);
    const expectedSize = Number(options.fileSize) > 0
      ? Number(options.fileSize)
      : (() => {
        try { return fs.statSync(localPath).size; } catch { return 0; }
      })();

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    onProgress?.(0, expectedSize);

    if (parent && parent !== '/' && parent !== '.') await ensureDir(parent, { signal });

    const commands = [];
    if (parent && parent !== '.') commands.push(`cd ${quote(parent)}`);
    commands.push(`put ${quote(localPath)} -o ${quote(baseNameOf(target))}`);

    let childPid = null;
    const poll = onProgress && expectedSize > 0
      ? setInterval(() => {
        const read = readProcessReadBytes(childPid);
        if (read > 0) onProgress(Math.min(read, expectedSize), expectedSize);
      }, PROGRESS_POLL_MS)
      : null;
    poll?.unref?.();

    try {
      await run(commands, {
        signal,
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TRANSFER_TIMEOUT_MS,
        scriptTag: 'put',
        onProcess: (child) => { childPid = child.pid ?? null; },
      });
    } finally {
      if (poll) clearInterval(poll);
    }
    onProgress?.(expectedSize, expectedSize);
    return true;
  }

  /**
   * FTP has no streaming read; the file is staged in the app temp dir and then
   * piped into the caller's writable, reporting progress from the staged file.
   */
  async function downloadToWritable(remotePath, writable, options = {}) {
    const staged = await downloadToTempFile(remotePath, options);
    const stagedPath = staged.path;
    let transferred = 0;
    let onWritableError = null;
    try {
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(stagedPath, { highWaterMark: 256 * 1024 });
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { stream.destroy(); } catch { /* ignore */ }
          reject(error);
        };
        onWritableError = fail;
        writable.on('error', fail);
        stream.on('error', fail);
        stream.on('data', (chunk) => {
          transferred += chunk.length;
          if (typeof options.onProgress === 'function') {
            options.onProgress(transferred, Number(options.fileSize) || staged.size);
          }
        });
        stream.on('end', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        stream.pipe(writable, { end: false });
      });
      return { bytes: staged.size };
    } finally {
      if (onWritableError) writable.removeListener?.('error', onWritableError);
      removeLocalFile(stagedPath);
    }
  }

  async function downloadFile(remotePath, localPath, options = {}) {
    const signal = options.signal || null;
    const target = normalizeRemotePath(remotePath);
    const expectedSize = Number(options.fileSize) > 0 ? Number(options.fileSize) : 0;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const tempPath = `${localPath}.nc-ftp-part`;
    removeLocalFile(tempPath);
    onProgress?.(0, expectedSize);

    const commands = [`get ${quote(target)} -o ${quote(tempPath)}`];
    const poll = onProgress
      ? setInterval(() => {
        let current = 0;
        try { current = fs.statSync(tempPath).size; } catch { current = 0; }
        if (current > 0) onProgress(current, expectedSize || current);
      }, PROGRESS_POLL_MS)
      : null;
    poll?.unref?.();

    try {
      await run(commands, {
        signal,
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TRANSFER_TIMEOUT_MS,
        scriptTag: 'get',
      });
    } finally {
      if (poll) clearInterval(poll);
    }

    const downloadedSize = (() => {
      try { return fs.statSync(tempPath).size; } catch { return 0; }
    })();
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

  /**
   * Stage a download in the app temp dir first. The pane's in-memory reads and
   * the editor both go through this path when a partial write must not be
   * visible, and it gives the transfer row a pollable byte counter.
   */
  async function downloadToTempFile(remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath);
    const dir = tempDir || require('node:os').tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const stagedPath = path.join(dir, `nc-ftp-${process.pid}-${Date.now()}-${baseNameOf(target) || 'download'}`);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const poll = onProgress
      ? setInterval(() => {
        let current = 0;
        try { current = fs.statSync(stagedPath).size; } catch { current = 0; }
        if (current > 0) onProgress(current, Number(options.fileSize) || current);
      }, PROGRESS_POLL_MS)
      : null;
    poll?.unref?.();
    try {
      await run([`get ${quote(target)} -o ${quote(stagedPath)}`], {
        signal: options.signal || null,
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TRANSFER_TIMEOUT_MS,
        scriptTag: 'get',
      });
    } catch (error) {
      removeLocalFile(stagedPath);
      throw error;
    } finally {
      if (poll) clearInterval(poll);
    }
    let size = 0;
    try { size = fs.statSync(stagedPath).size; } catch { size = 0; }
    return { path: stagedPath, size };
  }

  function stageLocalFile(buffer, dir, tag) {
    const targetDir = dir || require('node:os').tmpdir();
    fs.mkdirSync(targetDir, { recursive: true });
    const stagedPath = path.join(targetDir, `nc-ftp-${process.pid}-${Date.now()}-${tag}.tmp`);
    fs.writeFileSync(stagedPath, buffer, { mode: 0o600 });
    return stagedPath;
  }

  function removeLocalFile(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best effort */
    }
  }

  function abortAll() {
    for (const child of [...activeChildren]) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    activeChildren.clear();
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

module.exports = {
  FtpBackendError,
  createFtpBackend,
  getFtpBackendForClient,
  isFtpModeClient,
  _internal: {
    parseListing,
    parseListingLine,
    parseNameListing,
    resolveListingDate,
    mapLftpFailure,
    toStatResult,
    parentOf,
    baseNameOf,
  },
};
