"use strict";

const { CAPABILITY_STATUS } = require("../constants.cjs");

/**
 * FTP/FTPS transfers through the external `lftp` client.
 *
 * This is the backend for hosts that only speak FTP — typically a device you
 * reach over telnet/serial, where no SFTP subsystem exists. The terminal
 * drag-and-drop path uses the same bridge; exposing it as a capability lets an
 * agent do it too.
 *
 * Credentials are never read from the vault here: the caller (agent or
 * external MCP client) passes them explicitly, because the main process has no
 * access to the renderer's vault secrets by design.
 */
/** @type {import("../types.cjs").CapabilityDefinition[]} */
const FTP_CAPABILITIES = [
  {
    id: "ftp.upload",
    domain: "sftp",
    status: CAPABILITY_STATUS.IMPLEMENTED,
    description:
      "Upload local files into a remote directory over FTP/FTPS using the external lftp client (for hosts without SFTP).",
    policy: {
      write: true,
      sensitiveRead: false,
      longRunning: true,
      requiresChatSession: true,
      bypassesObserverBlock: false,
      bypassesApproval: false,
      bypassesChatCancel: false,
    },
    surfaces: {
      builtin: { rpcMethod: "netcatty/ftp/upload" },
      public: { rpcMethod: "public/ftp/upload", mcpTool: "ftp_upload" },
      catty: { toolName: "ftp_upload" },
    },
  },
];

module.exports = { FTP_CAPABILITIES };
