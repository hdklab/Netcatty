'use strict';

/**
 * Resolve the file-operation backend for a session that is not plain SFTP.
 *
 * Netcatty has three file-browsing modes behind one IPC surface:
 *   - SFTP   — ssh2 SFTP channel (`client.sftp`), the default;
 *   - SCP    — a shell on the host, for servers with no SFTP subsystem;
 *   - FTP    — an external `lftp` driver, for devices with no SSH at all
 *              (telnet/serial boxes whose only file service is FTP).
 *
 * The SCP and FTP backends expose the same method set (list/stat/mkdir/remove/
 * unlink/rename/chmod/homeDir/realpath/readFile/writeFile/uploadFile/
 * downloadFile/downloadToWritable), so callers ask this module for "the
 * backend, if this session is not SFTP" and stay mode-agnostic.
 */

const { isScpModeClient, getScpBackendForClient } = require('./scpBackend.cjs');
const { isFtpModeClient, getFtpBackendForClient } = require('./ftpBackend.cjs');

/** @returns {object|null} the SCP/FTP backend, or null for an SFTP session. */
function resolveRemoteFileBackend(client) {
  if (isScpModeClient(client)) return getScpBackendForClient(client);
  if (isFtpModeClient(client)) return getFtpBackendForClient(client);
  return null;
}

/** True when this session's file operations do not use an SFTP channel. */
function isNonSftpFileModeClient(client) {
  return isScpModeClient(client) || isFtpModeClient(client);
}

module.exports = {
  resolveRemoteFileBackend,
  isNonSftpFileModeClient,
};
