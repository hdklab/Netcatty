import type { Host } from "../types";

/**
 * FTP drag-drop planning.
 *
 * FTP is the third transfer backend for a file dropped on a terminal, after
 * SFTP (ssh/mosh/et) and ZMODEM (`rz`). It exists for the sessions that have no
 * SFTP at all — telnet, serial, local — on hosts whose operator enabled FTP:
 * the drop is uploaded with the built-in FTP/FTPS client straight into the
 * terminal's tracked current directory, so the file lands where the shell is.
 *
 * Everything here is pure so the decision can be tested without a terminal,
 * a network, or a running FTP server.
 */

export type FtpDropPlan = {
  host: string;
  port: number;
  user?: string;
  password?: string;
  secure: boolean;
  insecure: boolean;
  /**
   * Upload directory: the terminal's tracked cwd, or null to upload into the
   * FTP account's login directory. Telnet/serial devices never report a cwd
   * (no OSC 7), so refusing the drop there would make the feature unusable for
   * exactly the hosts it exists for.
   */
  remoteDir: string | null;
};

export type FtpDropPlanResult =
  | { ok: true; plan: FtpDropPlan }
  | { ok: false; reason: "unsupported-protocol" | "disabled" | "no-host" };

/** Protocols that never have an SFTP subsystem to fall back on. */
const FTP_ELIGIBLE_PROTOCOLS = new Set(["telnet", "serial", "local"]);

export function supportsFtpDragDrop(host: Pick<Host, "protocol" | "moshEnabled" | "etEnabled">): boolean {
  if (host.moshEnabled || host.etEnabled) return false;
  return FTP_ELIGIBLE_PROTOCOLS.has(String(host.protocol));
}

export function resolveFtpDropPlan(options: {
  host: Pick<
    Host,
    | "protocol"
    | "moshEnabled"
    | "etEnabled"
    | "hostname"
    | "ftpEnabled"
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
  /** The terminal's tracked current directory; the upload target. */
  remoteDir?: string | null;
  /** Credentials already resolved through host auth (host or Keychain identity). */
  credentials?: { username?: string; password?: string };
}): FtpDropPlanResult {
  const { host, remoteDir, credentials } = options;
  if (!supportsFtpDragDrop(host)) return { ok: false, reason: "unsupported-protocol" };
  if (!host.ftpEnabled) return { ok: false, reason: "disabled" };
  const hostname = String(host.hostname ?? "").trim();
  if (!hostname) return { ok: false, reason: "no-host" };
  const target = String(remoteDir ?? "").trim();

  const user = firstNonEmpty(host.ftpUsername, host.telnetUsername, credentials?.username, host.username);
  const password = firstNonEmpty(host.ftpPassword, host.telnetPassword, credentials?.password, host.password);
  const port = Number(host.ftpPort) > 0 ? Number(host.ftpPort) : 21;

  return {
    ok: true,
    plan: {
      host: hostname,
      port,
      user,
      password,
      secure: Boolean(host.ftpSecure),
      insecure: Boolean(host.ftpInsecure),
      remoteDir: target || null,
    },
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return undefined;
}

export type FtpUploadFile = { path: string; name: string; remoteName: string };

/**
 * Accept the shapes an agent sends for a file list: a JSON array, a comma or
 * newline separated string, or an array of `{path|localPath, remoteName}`
 * objects. Returns entries in the shape the IPC bridge expects.
 */
export function normalizeFtpUploadFiles(input: unknown): FtpUploadFile[] {
  let raw: unknown = input;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed;
      } catch {
        raw = trimmed;
      }
    } else {
      raw = trimmed.split(/[\n,]/);
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: FtpUploadFile[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const path = entry.trim();
      if (path) out.push({ path, name: baseName(path), remoteName: baseName(path) });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const path = String(record.path ?? record.localPath ?? "").trim();
      if (!path) continue;
      const remoteName = String(record.remoteName ?? record.name ?? baseName(path));
      out.push({ path, name: baseName(path), remoteName });
    }
  }
  return out;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}
