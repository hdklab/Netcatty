'use strict';

/**
 * FTP-mode session objects.
 *
 * The renderer treats the file panel uniformly, so an FTP target is registered
 * in the same `sftpClients` map keyed by an `sftpId`; the only difference is that
 * its operations are served by the lftp-backed backend instead of an ssh2 SFTP
 * channel. Nothing here touches SSH: dialling SSH on a telnet device's terminal
 * port is what used to leave the file panel spinning on "Connecting…" forever.
 */

const tempDirBridge = require('../tempDirBridge.cjs');
const { createFtpBackend, FtpBackendError } = require('./ftpBackend.cjs');

function resolveSessionTempDir() {
  try {
    const dir = tempDirBridge.getTempDir?.();
    if (typeof dir === 'string' && dir.trim()) return dir;
  } catch {
    /* fall through to the backend default */
  }
  return undefined;
}

function buildFtpEndpointConfig(options = {}) {
  const host = String(options.hostname || options.host || '').trim();
  if (!host) throw new FtpBackendError('FTP host is required', 'EINVAL');
  const port = Number(options.port) > 0 ? Number(options.port) : 21;
  return {
    host,
    port,
    user: options.username ? String(options.username) : undefined,
    password: typeof options.password === 'string' ? options.password : undefined,
    secure: Boolean(options.secure || options.ftpSecure),
    insecure: Boolean(options.insecure || options.ftpInsecure),
    tempDir: options.tempDir || resolveSessionTempDir(),
    settings: Array.isArray(options.settings) ? options.settings : undefined,
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : undefined,
  };
}

/**
 * Create the FTP client object that lives in `sftpClients`.
 * Shape-compatible with the SCP/FTP-aware code paths in fileOps/closeSftp.
 */
function createFtpSftpClient(connId, options = {}, { webContentsId = null } = {}) {
  const config = buildFtpEndpointConfig(options);
  const backend = createFtpBackend(config);
  const client = {
    id: connId,
    kind: 'ftp',
    webContentsId,
    // No SSH client and no SFTP channel: every operation goes through the backend.
    client: null,
    sftp: null,
    __netcattyFileProtocol: 'ftp',
    __netcattySudoMode: false,
    __netcattyFtpConfig: config,
    __netcattyFtpBackend: backend,
    __netcattyFtpHomeDir: null,
    __netcattyDisposed: false,
    async end() {
      client.__netcattyDisposed = true;
      try {
        backend.dispose();
      } catch {
        /* best effort */
      }
    },
  };
  return client;
}

/**
 * Verify the endpoint and learn its initial directory in one round trip, so a
 * wrong host, port or password fails at connect time with a readable message
 * instead of surfacing later as an empty file list.
 */
async function probeFtpSession(client) {
  try {
    const home = await client.__netcattyFtpBackend.homeDir();
    client.__netcattyFtpHomeDir = home || '/';
    return client.__netcattyFtpHomeDir;
  } catch (error) {
    try {
      client.__netcattyFtpBackend.dispose();
    } catch {
      /* ignore */
    }
    const wrapped = new Error(`FTP connection failed: ${error.message}`);
    wrapped.code = error.code || 'EFTP';
    throw wrapped;
  }
}

module.exports = {
  buildFtpEndpointConfig,
  createFtpSftpClient,
  probeFtpSession,
};
