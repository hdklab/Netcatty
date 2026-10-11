/**
 * FTP Bridge (external `lftp` driver)
 *
 * Netcatty has no built-in FTP stack, and it does not need one: `lftp` is the
 * de-facto command line FTP client and is already present on most Unix images.
 * This bridge shells out to it for hosts that only speak FTP/FTPS — typically a
 * device you reach over telnet where SFTP is not available.
 *
 * Contract:
 *   - The caller supplies host/port/credentials and an explicit remote
 *     directory (the terminal's tracked current directory, so a dropped file
 *     lands where the shell is).
 *   - The password is NEVER passed in argv. It goes into a 0600 script in the
 *     app temp directory, consumed with `lftp -f <script>`, and the file is
 *     removed even when the transfer fails. argv would be readable through
 *     `ps` by every local user.
 *   - Errors are returned as codes (`lftp-not-found`, `spawn-failed`, `lftp-failed`),
 *     never as a message that could embed credentials.
 *
 * Renderer-facing bits (drag-drop wiring, host fields, settings UI) live in the
 * renderer; this module is deliberately transport-only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Absolute paths worth trying when PATH is minimal (packaged apps on macOS). */
const FALLBACK_LFTP_PATHS = [
  '/usr/bin/lftp',
  '/usr/local/bin/lftp',
  '/opt/homebrew/bin/lftp',
  '/opt/local/bin/lftp',
];

const DEFAULT_TIMEOUT_MS = 120000;

let _deps = null;

/**
 * @param {{ tempDir?: string, spawnImpl?: typeof spawn, log?: (msg: string) => void }} deps
 */
function configure(deps) {
  _deps = deps || null;
}

function resolveTempDir() {
  if (_deps?.tempDir) return _deps.tempDir;
  return os.tmpdir();
}

function spawnImpl() {
  return _deps?.spawnImpl || spawn;
}

/** Locate the `lftp` executable, or null when the machine has none. */
function findLftp() {
  const override = process.env.NETCATTY_LFTP_PATH;
  if (override) {
    return isExecutable(override) ? override : null;
  }
  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'lftp'))
    .find((candidate) => isExecutable(candidate));
  if (fromPath) return fromPath;
  return FALLBACK_LFTP_PATHS.find((candidate) => isExecutable(candidate)) || null;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** lftp quotes with double quotes; a literal " or \ inside a token must survive. */
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the lftp script for one upload batch. Pure, so it can be asserted on
 * without spawning anything: no credentials may leak into argv is the invariant
 * that matters, and it is checked by looking at the produced script.
 *
 * @param {{
 *   host: string, port?: number, user?: string, password?: string,
 *   secure?: boolean, insecure?: boolean,
 *   remoteDir?: string, files: Array<{ localPath: string, remoteName?: string }>,
 * }} options
 */
function buildLftpScript(options) {
  const {
    host,
    port = 21,
    user,
    password,
    secure = false,
    insecure = false,
    remoteDir,
    files,
  } = options;
  if (!host) throw new Error('ftp host is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files to upload');

  const lines = [
    'set cmd:fail-exit yes',
    'set net:timeout 15',
    'set net:max-retries 2',
  ];
  if (secure) {
    lines.push('set ftp:ssl-force yes', 'set ftp:ssl-protect-data yes');
    // Self-signed certificates are the norm on embedded/edge devices; the
    // caller opts out of verification explicitly, it is never silent.
    if (insecure) lines.push('set ssl:verify-certificate no');
  }
  const credentials = user ? `-u ${quote(user)},${quote(password ?? '')}` : '';
  const scheme = secure ? 'ftps' : 'ftp';
  lines.push(`open ${credentials} -p ${Number(port) || 21} ${scheme}://${quote(host)}`.replace(/\s+/g, ' ').trim());
  if (remoteDir && String(remoteDir).trim()) {
    lines.push(`cd ${quote(String(remoteDir).trim())}`);
  }
  for (const file of files) {
    const localPath = file?.localPath;
    if (!localPath) throw new Error('file entry is missing localPath');
    const target = file.remoteName && file.remoteName !== path.basename(localPath)
      ? `-o ${quote(file.remoteName)} `
      : '';
    lines.push(`put ${target}${quote(localPath)}`);
  }
  lines.push('bye');
  return `${lines.join('\n')}\n`;
}

/**
 * Upload files into `remoteDir` on an FTP/FTPS host.
 *
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
async function uploadFiles(options) {
  const lftpPath = findLftp();
  if (!lftpPath) {
    return {
      ok: false,
      code: 'lftp-not-found',
      error: 'lftp is not installed. Install it (apt install lftp / brew install lftp) and retry.',
    };
  }

  let script;
  try {
    script = buildLftpScript(options);
  } catch (error) {
    return { ok: false, code: 'invalid-request', error: error.message };
  }

  const dir = resolveTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `nc-lftp-${process.pid}-${Date.now()}.script`);
  fs.writeFileSync(scriptPath, script, { mode: 0o600 });

  try {
    return await runLftp(lftpPath, scriptPath, options.timeoutMs);
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* best effort: never mask the transfer result */
    }
  }
}

function runLftp(lftpPath, scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let proc;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: 'timeout', error: 'lftp timed out' });
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);

    try {
      proc = spawnImpl()(lftpPath, ['-f', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, code: 'spawn-failed', error: `could not start lftp: ${error.message}` });
      return;
    }

    proc.stderr?.on('data', (chunk) => {
      // lftp prints progress prompts on stderr; only the tail is useful.
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    proc.on('error', (error) => {
      finish({ ok: false, code: 'spawn-failed', error: `could not start lftp: ${error.message}` });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        code: 'lftp-failed',
        error: redact(stderr.trim()) || `lftp exited with code ${code}`,
      });
    });
  });
}

/**
 * Strip anything that looks like a credential pair from a message before it
 * travels to the renderer or a log. lftp echoes `open -u user,pass` on failure,
 * so a failed transfer must not become a password disclosure.
 */
function redact(message) {
  return String(message)
    .replace(/(-u\s+)[^\s,]+,[^\s]+/g, '$1[REDACTED]')
    .replace(/(password[^:]*:\s*)\S+/gi, '$1[REDACTED]');
}

/** Probe used by the renderer to decide whether FTP uploads are even possible. */
function getCapabilities() {
  const lftpPath = findLftp();
  return { lftp: Boolean(lftpPath), lftpPath: lftpPath || null };
}

module.exports = {
  configure,
  findLftp,
  buildLftpScript,
  uploadFiles,
  getCapabilities,
  redact,
  _internal: { quote, redact, isExecutable },
};
