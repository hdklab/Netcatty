import type { Host } from "./models";

/**
 * Which file-browsing transport a host should use.
 *
 * A host whose terminal protocol has no SSH (telnet/serial device) cannot be
 * browsed over SFTP at all, and asking for one used to dial SSH on the terminal
 * port — a non-SSH banner, so the pane spun on "Connecting" forever. Such hosts
 * now browse over FTP when it is configured, which is the only file service they
 * expose.
 */

/** Terminal protocols with no SSH transport behind them. */
const NO_SSH_PROTOCOLS = new Set(["telnet", "serial"]);

export type SftpFileProtocolMode = "auto" | "sftp" | "scp" | "ftp";

export function hostHasSshTransport(
  host: Pick<Host, "protocol" | "moshEnabled" | "etEnabled">,
): boolean {
  // Mosh/et ride an SSH handshake, so they keep an SSH transport.
  if (host.moshEnabled || host.etEnabled) return true;
  return !NO_SSH_PROTOCOLS.has(String(host.protocol || "ssh"));
}

/**
 * Resolve the file protocol to open with.
 * An explicit host choice wins; otherwise FTP is picked for the hosts that can
 * only be browsed that way, and `auto` (SFTP with an SCP fallback) stays the
 * default everywhere else.
 */
export function resolveSftpFileProtocolMode(
  host: Pick<Host, "protocol" | "moshEnabled" | "etEnabled" | "ftpEnabled" | "sftpFileProtocol">,
): SftpFileProtocolMode {
  const explicit = host.sftpFileProtocol ?? "auto";
  if (explicit === "ftp" || explicit === "scp" || explicit === "sftp") return explicit;
  if (!hostHasSshTransport(host) && host.ftpEnabled) return "ftp";
  return "auto";
}

/** True when the host offers no file service at all for this app. */
export function hostHasNoFileService(
  host: Pick<Host, "protocol" | "moshEnabled" | "etEnabled" | "ftpEnabled" | "sftpFileProtocol">,
): boolean {
  return resolveSftpFileProtocolMode(host) === "auto" && !hostHasSshTransport(host);
}

export type FtpSftpEndpoint = {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  secure: boolean;
  insecure: boolean;
};

export type FtpSftpEndpointResult =
  | { ok: true; endpoint: FtpSftpEndpoint }
  | { ok: false; reason: "no-host" };

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Resolve the FTP endpoint for a host, mirroring the drag-drop credential chain
 * (`ftp*` -> `telnet*` -> resolved identity -> host login) so browsing and
 * uploads always reach the same account.
 */
export function resolveFtpSftpEndpoint({
  host,
  credentials,
}: {
  host: Pick<
    Host,
    | "hostname"
    | "ftpPort"
    | "ftpSecure"
    | "ftpInsecure"
    | "ftpUsername"
    | "ftpPassword"
    | "telnetUsername"
    | "telnetPassword"
    | "username"
    | "password"
  >;
  /** Credentials already resolved through host auth (host or Keychain identity). */
  credentials?: { username?: string; password?: string };
}): FtpSftpEndpointResult {
  const hostname = String(host.hostname ?? "").trim();
  if (!hostname) return { ok: false, reason: "no-host" };
  const port = Number(host.ftpPort) > 0 ? Number(host.ftpPort) : 21;
  return {
    ok: true,
    endpoint: {
      hostname,
      port,
      username: firstNonEmpty(host.ftpUsername, host.telnetUsername, credentials?.username, host.username),
      password: firstNonEmpty(host.ftpPassword, host.telnetPassword, credentials?.password, host.password),
      secure: Boolean(host.ftpSecure),
      insecure: Boolean(host.ftpInsecure),
    },
  };
}
