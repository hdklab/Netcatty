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

/** App temp dir (AGENTS.md: temp files never go to os.tmpdir()). */
function resolveAppTempDir() {
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
 * Common install locations, per platform. Auto-detection has to cover more than
 * PATH: a packaged macOS app inherits launchd's minimal PATH, Windows installs
 * ship `lftp.exe` (and often never touch PATH), and Nix profiles put binaries in
 * per-user/profile dirs that a GUI launch never sees.
 *
 * Pure on purpose (platform/env/home injected) so Windows and macOS layouts are
 * unit-testable from a Linux dev box.
 */
function buildLftpCandidates({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const homeDir = typeof home === 'string' && home.trim() ? home.trim() : '';
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || '';
    const userProfile = env.USERPROFILE || homeDir;
    const programData = env.ProgramData || 'C:\\ProgramData';
    return [
      path.win32.join(programFiles, 'lftp', 'lftp.exe'),
      path.win32.join(programFilesX86, 'lftp', 'lftp.exe'),
      localAppData ? path.win32.join(localAppData, 'Programs', 'lftp', 'lftp.exe') : '',
      userProfile ? path.win32.join(userProfile, 'scoop', 'shims', 'lftp.exe') : '',
      path.win32.join(programData, 'chocolatey', 'bin', 'lftp.exe'),
      'C:\\msys64\\usr\\bin\\lftp.exe',
      'C:\\cygwin64\\bin\\lftp.exe',
      'C:\\cygwin\\bin\\lftp.exe',
    ].filter(Boolean);
  }

  const unix = [
    '/usr/bin/lftp',
    '/usr/local/bin/lftp',
    '/bin/lftp',
    '/opt/homebrew/bin/lftp',
    '/opt/homebrew/opt/lftp/bin/lftp',
    '/usr/local/opt/lftp/bin/lftp',
    '/opt/local/bin/lftp',
    '/snap/bin/lftp',
    '/run/current-system/sw/bin/lftp',
    '/nix/var/nix/profiles/default/bin/lftp',
  ];
  if (platform === 'darwin') {
    unix.push('/opt/homebrew/sbin/lftp', '/usr/local/sbin/lftp');
  }
  if (homeDir) {
    unix.push(
      path.posix.join(homeDir, '.nix-profile', 'bin', 'lftp'),
      path.posix.join(homeDir, '.local', 'bin', 'lftp'),
      path.posix.join(homeDir, 'bin', 'lftp'),
    );
  }
  return unix;
}

/** Windows ships the binary as `lftp.exe`, so a bare-name scan never matches. */
const LFTP_BINARY_NAMES = process.platform === 'win32' ? ['lftp.exe', 'lftp'] : ['lftp'];

const DEFAULT_TIMEOUT_MS = 120000;

let _deps = null;

/**
 * Path configured in Settings → 文件传输 (FTP client). Empty means "not set".
 * It wins over the env var and PATH so a user without lftp on PATH (typically
 * Windows) can point the app at their own binary.
 */
let configuredLftpPath = '';

/**
 * @param {string} value absolute path chosen in the settings UI, or '' to clear
 * @returns {{ ok: boolean, configuredPath: string, resolvedPath: string | null }}
 */
function setLftpPath(value) {
  configuredLftpPath = typeof value === 'string' ? value.trim() : '';
  return { ok: true, ...getLftpStatus() };
}

/** Effective resolution order, for the settings UI to show what will be used. */
function getLftpStatus() {
  const resolved = resolveLftp();
  return {
    configuredPath: configuredLftpPath,
    configuredUsable: configuredLftpPath ? isExecutable(configuredLftpPath) : false,
    envPath: process.env.NETCATTY_LFTP_PATH || '',
    resolvedPath: resolved.path,
    /** Where resolvedPath came from: settings / env / path / auto / none. */
    source: resolved.source,
    /** True when the binary was found without any user configuration. */
    autoDetected: resolved.source === 'path' || resolved.source === 'auto',
    platform: process.platform,
  };
}

/**
 * @param {{ tempDir?: string, spawnImpl?: typeof spawn, log?: (msg: string) => void }} deps
 */
function configure(deps) {
  _deps = deps || null;
}

/**
 * Directory for the lftp script and the staged drop files. A per-call override
 * wins (tests and the IPC handler pass one), then the configured app temp dir.
 */
function resolveTempDir(override) {
  if (typeof override === 'string' && override.trim()) return override;
  if (_deps?.tempDir) return _deps.tempDir;
  return resolveAppTempDir();
}

function spawnImpl() {
  return _deps?.spawnImpl || spawn;
}

/**
 * Resolve the `lftp` executable and where the answer came from.
 * Order: the path set in Settings, `NETCATTY_LFTP_PATH`, a PATH scan (trying
 * `lftp.exe` on Windows), then the platform's common install locations — the
 * last one is what makes a GUI launch on macOS/NixOS/Windows work without the
 * user configuring anything.
 *
 * @returns {{ path: string | null, source: 'settings' | 'env' | 'path' | 'auto' | 'none' | 'settings-invalid' | 'env-invalid' }}
 */
function resolveLftp() {
  if (configuredLftpPath) {
    return isExecutable(configuredLftpPath)
      ? { path: configuredLftpPath, source: 'settings' }
      : { path: null, source: 'settings-invalid' };
  }
  const override = process.env.NETCATTY_LFTP_PATH;
  if (override) {
    return isExecutable(override)
      ? { path: override, source: 'env' }
      : { path: null, source: 'env-invalid' };
  }
  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => LFTP_BINARY_NAMES.map((name) => path.join(dir, name)))
    .find((candidate) => isExecutable(candidate));
  if (fromPath) return { path: fromPath, source: 'path' };

  const detected = buildLftpCandidates().find((candidate) => isExecutable(candidate));
  return detected ? { path: detected, source: 'auto' } : { path: null, source: 'none' };
}

/** Locate the `lftp` executable, or null when the machine has none. */
function findLftp() {
  return resolveLftp().path;
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
 * Shared lftp prelude: fail fast, bound network waits, optional FTPS.
 * Self-signed certificates are the norm on embedded/edge devices; the caller
 * opts out of verification explicitly, it is never silent.
 */
function buildScriptPrelude({ secure = false, insecure = false, settings = [] } = {}) {
  const lines = [
    'set cmd:fail-exit yes',
    'set net:timeout 15',
    'set net:max-retries 2',
  ];
  if (secure) {
    lines.push('set ftp:ssl-force yes', 'set ftp:ssl-protect-data yes');
    if (insecure) lines.push('set ssl:verify-certificate no');
  }
  for (const setting of settings) {
    const text = String(setting ?? '').trim();
    if (text) lines.push(text);
  }
  return lines;
}

/** `open` line for one endpoint. Credentials stay inside the 0600 script. */
function buildScriptOpenLine({ host, port = 21, user, password, secure = false }) {
  if (!host) throw new Error('ftp host is required');
  const credentials = user ? `-u ${quote(user)},${quote(password ?? '')}` : '';
  const scheme = secure ? 'ftps' : 'ftp';
  return `open ${credentials} -p ${Number(port) || 21} ${scheme}://${quote(host)}`.replace(/\s+/g, ' ').trim();
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
  const { remoteDir, files } = options;
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files to upload');

  const lines = buildScriptPrelude(options);
  lines.push(buildScriptOpenLine(options));
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
 * Build a complete lftp script: prelude, `open`, then caller-supplied commands.
 * Used by the FTP file-protocol backend, whose every operation is one script.
 */
function buildCommandScript(options) {
  const commands = (options.commands || []).map((command) => String(command)).filter((c) => c.trim());
  const lines = buildScriptPrelude(options);
  lines.push(buildScriptOpenLine(options));
  lines.push(...commands);
  lines.push('bye');
  return `${lines.join('\n')}\n`;
}

/** Result shape shared by every lftp invocation. */
function createLftpResult(overrides = {}) {
  return {
    ok: true,
    code: undefined,
    error: undefined,
    stdout: Buffer.alloc(0),
    stderr: '',
    exitCode: 0,
    ...overrides,
  };
}

function lftpUnavailable() {
  return createLftpResult({
    ok: false,
    code: 'lftp-not-found',
    error: process.platform === 'win32'
      ? 'lftp was not found. Install lftp and set its path in Settings → File Transfer → FTP client path.'
      : 'lftp is not installed. Install it (apt install lftp / brew install lftp) or set its path in Settings → File Transfer → FTP client path.',
    exitCode: null,
  });
}

/**
 * Run one lftp script and capture its output. `stdout` is collected as a
 * Buffer because the FTP backend reads remote files with `cat`.
 */
async function runScript(lftpPath, script, { timeoutMs, tempDir, scriptTag = 'cmd', onProcess = null } = {}) {
  const dir = resolveTempDir(tempDir);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `nc-lftp-${process.pid}-${Date.now()}-${scriptTag}.script`);
  fs.writeFileSync(scriptPath, script, { mode: 0o600 });

  try {
    return await runLftp(lftpPath, scriptPath, timeoutMs, onProcess ? { onProcess } : {});
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* best effort: never mask the transfer result */
    }
  }
}

/**
 * Run FTP commands against one endpoint in a single lftp session.
 * Every remote operation (list, stat, get, put, …) goes through here.
 */
async function runLftpCommands(options = {}) {
  const lftpPath = findLftp();
  if (!lftpPath) return lftpUnavailable();

  let script;
  try {
    script = buildCommandScript(options);
  } catch (error) {
    return createLftpResult({ ok: false, code: 'invalid-request', error: error.message, exitCode: null });
  }

  return runScript(lftpPath, script, {
    timeoutMs: options.timeoutMs,
    tempDir: options.tempDir,
    scriptTag: options.scriptTag || 'cmd',
    onProcess: options.onProcess || null,
  });
}

/**
 * Upload files into `remoteDir` on an FTP/FTPS host.
 *
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
async function uploadFiles(options) {
  const lftpPath = findLftp();
  if (!lftpPath) {
    const unavailable = lftpUnavailable();
    return { ok: false, code: unavailable.code, error: unavailable.error };
  }

  let script;
  try {
    script = buildLftpScript(options);
  } catch (error) {
    return { ok: false, code: 'invalid-request', error: error.message };
  }

  const result = await runScript(lftpPath, script, {
    timeoutMs: options.timeoutMs,
    tempDir: options.tempDir,
    scriptTag: 'upload',
  });
  return result.ok ? { ok: true } : { ok: false, code: result.code, error: result.error };
}

function runLftp(lftpPath, scriptPath, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];
    let stderr = '';
    let proc;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(createLftpResult({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        ...value,
      }));
    };

    const timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: 'timeout', error: 'lftp timed out', exitCode: null });
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);

    try {
      proc = spawnImpl()(lftpPath, ['-f', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, code: 'spawn-failed', error: `could not start lftp: ${error.message}`, exitCode: null });
      return;
    }

    if (options.onProcess) {
      try {
        options.onProcess(proc);
      } catch {
        /* observers must never break the transfer */
      }
    }

    proc.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proc.stderr?.on('data', (chunk) => {
      // lftp prints progress prompts on stderr; only the tail is useful.
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    proc.on('error', (error) => {
      finish({ ok: false, code: 'spawn-failed', error: `could not start lftp: ${error.message}`, exitCode: null });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, exitCode: 0 });
        return;
      }
      finish({
        ok: false,
        code: 'lftp-failed',
        error: redact(stderr.trim()) || `lftp exited with code ${code}`,
        exitCode: code,
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

/**
 * Resolve the local file a drop entry refers to. The renderer either hands over
 * a real path (OS drag) or the bytes it got from a portal/virtual drop; the
 * second case is materialised into the app temp directory so lftp has something
 * to `put`, and the caller is told to clean it up afterwards.
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

/** IPC surface used by the renderer's terminal drag-and-drop path. */
function registerHandlers(ipcMain) {
  ipcMain.handle('netcatty:ftp:capabilities', () => getCapabilities());
  // Settings → 文件传输: an explicit lftp path beats PATH/env so Windows and
  // minimal-PATH macOS installs can point at their own binary.
  ipcMain.handle('netcatty:ftp:set-lftp-path', (_event, value) =>
    setLftpPath(typeof value === 'string' ? value : value?.path),
  );
  ipcMain.handle('netcatty:ftp:lftp-status', () => getLftpStatus());
  ipcMain.handle('netcatty:ftp:upload', async (_event, payload = {}) => {
    const incoming = Array.isArray(payload.files) ? payload.files : [];
    if (incoming.length === 0) {
      return { ok: false, code: 'no-files', error: 'No files to upload' };
    }
    const stagingDir = path.join(resolveTempDir(), 'netcatty-ftp-staging');
    const staged = [];
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
      });
    } catch (error) {
      return { ok: false, code: 'unexpected', error: redact(error?.message || String(error)) };
    } finally {
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
  findLftp,
  setLftpPath,
  getLftpStatus,
  buildLftpScript,
  buildCommandScript,
  buildScriptPrelude,
  buildScriptOpenLine,
  runLftpCommands,
  uploadFiles,
  getCapabilities,
  redact,
  _internal: { quote, redact, isExecutable, materializeDropFile, resolveAppTempDir, buildLftpCandidates, resolveLftp },
};
