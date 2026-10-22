import type { Host, SerialConfig } from "./models";
import { prepareSerialConfigForSavedHost } from "./serialBackspace";

/**
 * Serial ports are a first-class connection type on the host model
 * (`protocol: "serial"` + `serialConfig`). This module owns the pure helpers
 * the host editor uses to create, switch and persist such hosts, so the panel
 * stays presentational and the rules are testable without React.
 */

export const SERIAL_BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const;

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  path: "",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  localEcho: false,
  lineMode: false,
};

/** Connection methods offered by the host editor's "connection type" picker. */
export type HostConnectionType = "ssh" | "telnet" | "mosh" | "et" | "serial" | "file";

export const HOST_CONNECTION_TYPES: readonly HostConnectionType[] = [
  "ssh",
  "telnet",
  "mosh",
  "et",
  "serial",
  "file",
];

/** Transports that ride on SSH: they keep the SSH address/credential fields. */
export const SSH_FAMILY_CONNECTION_TYPES: readonly HostConnectionType[] = ["ssh", "mosh", "et"];

const BACKSLASH = String.fromCharCode(92);
/** Win32 device-namespace prefix: backslash backslash dot backslash. */
const WIN32_DEVICE_PREFIX = `${BACKSLASH}${BACKSLASH}.${BACKSLASH}`;

const isComPortName = (value: string): boolean => {
  if (!value.toUpperCase().startsWith("COM")) return false;
  const digits = value.slice(3);
  return digits.length > 0
    && Array.from(digits).every((char) => char >= "0" && char <= "9");
};

const isWin32SerialPath = (value: string): boolean =>
  value.startsWith(WIN32_DEVICE_PREFIX)
  && isComPortName(value.slice(WIN32_DEVICE_PREFIX.length));

export const isSerialPortPath = (path: string): boolean => {
  const trimmed = path.trim();
  if (trimmed.startsWith("/dev/")) return true;
  return isComPortName(trimmed) || isWin32SerialPath(trimmed);
};

export const resolveSerialPortPath = (
  host: Pick<Host, "hostname" | "serialConfig">,
): string => (host.serialConfig?.path ?? "").trim() || (host.hostname ?? "").trim();

export const isValidSerialBaudRate = (baudRate: number | undefined): boolean =>
  Number.isInteger(baudRate) && (baudRate ?? 0) > 0;

export const isSerialHostDraftValid = (
  host: Pick<Host, "hostname" | "serialConfig">,
): boolean => isSerialPortPath(resolveSerialPortPath(host)) && isValidSerialBaudRate(host.serialConfig?.baudRate);

export const defaultSerialHostLabel = (path: string): string => {
  const portName = path.trim().split("/").pop()?.split(BACKSLASH).pop() || path.trim();
  return portName ? `Serial: ${portName}` : "Serial";
};

/** Merge saved/blank serial config with the defaults and the host's own path. */
export const normalizeSerialConfig = (
  config: SerialConfig | undefined,
  fallbackPath = "",
): SerialConfig => ({
  ...DEFAULT_SERIAL_CONFIG,
  ...(config ?? {}),
  path: config?.path?.trim() || fallbackPath.trim(),
  baudRate: isValidSerialBaudRate(config?.baudRate)
    ? (config?.baudRate as number)
    : DEFAULT_SERIAL_CONFIG.baudRate,
});

export const resolveHostConnectionType = (
  host: Pick<Host, "protocol" | "moshEnabled" | "etEnabled" | "fileTransferOnly">,
): HostConnectionType => {
  if (host.fileTransferOnly) return "file";
  if (host.protocol === "serial") return "serial";
  if (host.protocol === "telnet") return "telnet";
  if (host.protocol === "et" || host.etEnabled) return "et";
  if (host.protocol === "mosh" || host.moshEnabled) return "mosh";
  return "ssh";
};

/** What a host needs before it can be saved in the given mode. */
export const resolveFileTransferProtocol = (
  host: Pick<Host, "sftpFileProtocol">,
): NonNullable<Host["sftpFileProtocol"]> => host.sftpFileProtocol ?? "auto";

/**
 * Host fields that only make sense for SSH-family transports. A serial host
 * keeps credentials (auto-login), FTP settings (file drops) and appearance,
 * but must not carry leftover SSH auth / proxy / jump-host configuration.
 */
const SSH_ONLY_HOST_KEYS = [
  "authMethod",
  "authPolicyVersion",
  "identityFileId",
  "identityFilePaths",
  "identityAgent",
  "identitiesOnly",
  "useKeychain",
  "addKeysToAgent",
  "useSshAgent",
  "agentForwarding",
  "x11Forwarding",
  "totp",
  "requiresMfa",
  "proxy",
  "proxyConfig",
  "proxyProfileId",
  "directProxy",
  "hostChain",
  "hostChaining",
  "environmentVariables",
  "envVars",
  "protocols",
  "telnetPort",
  "telnetUsername",
  "telnetPassword",
  "telnetIdentityId",
  "moshEnabled",
  "moshServerPath",
  "etEnabled",
  "etPort",
  "legacyAlgorithms",
  "skipEcdsaHostKey",
  "algorithms",
  "keepaliveInterval",
  "keepaliveCountMax",
  "keepaliveOverride",
  "sshTcpConnectTimeoutSeconds",
  "sshAuthReadyTimeoutSeconds",
] as const;

export const stripSshOnlyHostFields = (host: Host): Host => {
  const next: Host = { ...host };
  const writable = next as unknown as Record<string, unknown>;
  for (const key of SSH_ONLY_HOST_KEYS) delete writable[key];
  return next;
};

/**
 * Final shape of a saved serial host: the device path is the hostname, the
 * baud rate takes the numeric `port` slot, and the serial-only settings live in
 * `serialConfig`.
 */
export const buildSerialHostForSave = (host: Host): Host => {
  const path = resolveSerialPortPath(host);
  const config = normalizeSerialConfig(host.serialConfig, path);
  const cleaned = stripSshOnlyHostFields({
    ...host,
    protocol: "serial",
    hostname: path,
    port: config.baudRate,
    username: host.username?.trim() || undefined,
    charset: host.charset?.trim() || undefined,
    serialConfig: prepareSerialConfigForSavedHost({ ...config, path }),
  });
  return cleaned;
};

/**
 * Switch the host's connection method. SSH-family transports share the
 * address/credential fields, so switching between them only touches the
 * protocol flags; serial gets its own defaults and drops SSH-only state.
 */
export const applyHostConnectionType = (
  host: Host,
  type: HostConnectionType,
): Host => {
  if (type === "file") {
    // A file server keeps whichever SSH-family transport its credentials belong
    // to, but never opens a shell; a transfer protocol must be chosen.
    const protocol = host.protocol === "telnet" || host.protocol === "serial"
      ? "ssh"
      : host.protocol ?? "ssh";
    return {
      ...host,
      protocol,
      fileTransferOnly: true,
      hostname: isSerialPortPath(host.hostname) ? "" : host.hostname,
      username: host.username?.trim() || undefined,
      // A socket port carried over from the terminal transport is wrong for a
      // file-server host: serial holds a baud rate there and telnet holds 23.
      port: host.protocol === "serial" || host.port === 23 ? 22 : host.port,
      moshEnabled: false,
      etEnabled: false,
      telnetEnabled: false,
      sftpFileProtocol: host.sftpFileProtocol && host.sftpFileProtocol !== "none"
        ? host.sftpFileProtocol
        : "sftp",
    };
  }
  if (type === "serial") {
    const serialConfig = normalizeSerialConfig(
      host.serialConfig,
      isSerialPortPath(host.hostname) ? host.hostname : "",
    );
    return {
      ...host,
      protocol: "serial",
      fileTransferOnly: false,
      serialConfig,
      // `hostname` mirrors the device path and `port` carries the baud rate.
      hostname: serialConfig.path || host.hostname,
      port: serialConfig.baudRate,
      telnetEnabled: false,
      moshEnabled: false,
      etEnabled: false,
    };
  }

  const leavingSerial = host.protocol === "serial";
  const leavingTelnet = host.protocol === "telnet";
  const next: Host = {
    ...host,
    fileTransferOnly: false,
    protocol: type,
    moshEnabled: type === "mosh",
    etEnabled: type === "et",
    // A host has exactly one primary transport now: switching away from Telnet
    // must not leave a secondary Telnet profile the panel can no longer edit.
    telnetEnabled: type === "telnet",
  };
  // A serial draft stores the baud rate in `port`; that number must never
  // survive a switch to a socket transport.
  const portLooksLikeBaud = host.port !== undefined
    && host.serialConfig?.baudRate !== undefined
    && host.port === host.serialConfig.baudRate;
  const portIsDefault = host.port === undefined || host.port === 22 || host.port === 23 || portLooksLikeBaud;

  if (type === "telnet" && !leavingTelnet && portIsDefault) {
    next.port = host.telnetPort ?? 23;
  } else if (type !== "telnet" && leavingTelnet && (host.port === 23 || portLooksLikeBaud)) {
    next.port = 22;
  }
  if (leavingSerial) {
    // Keep `serialConfig` on the host: it is the user's saved line settings and
    // switching back to Serial must restore them (the old code deleted them, so
    // a stray click on SSH destroyed a tuned port). `port`/`hostname` still move
    // to the socket transport's defaults.
    next.port = type === "telnet" ? (host.telnetPort ?? 23) : 22;
    next.hostname = isSerialPortPath(host.hostname) ? "" : host.hostname;
    next.username = host.username?.trim() || undefined;
  }
  return next;
};
