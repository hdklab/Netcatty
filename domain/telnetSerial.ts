import type { Host, SerialFlowControl, SerialParity, TelnetSerialConfig } from "./models";

/**
 * RFC 2217 ("Telnet Com Port Control Option") helpers for telnet hosts that
 * front a serial device — ser2net, a router's console server, an industrial
 * gateway. The remote end owns the UART, so the line settings have to be
 * negotiated on every connect; there is no local device to configure.
 *
 * Pure helpers only: the wire encoding lives in `electron/bridges/telnetProtocol.cjs`
 * (main process), the editor reads `serialLineSettingsFields` for the pickers.
 */

/** Baud rates RFC 2217 (and ser2net's rate table) can carry. */
export const TELNET_SERIAL_BAUD_RATES = [
  300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const;

export const TELNET_SERIAL_DATA_BITS: readonly (5 | 6 | 7 | 8)[] = [5, 6, 7, 8];
export const TELNET_SERIAL_STOP_BITS: readonly (1 | 2)[] = [1, 2];
export const TELNET_SERIAL_PARITIES: readonly SerialParity[] = ["none", "even", "odd", "mark", "space"];
export const TELNET_SERIAL_FLOW_CONTROLS: readonly SerialFlowControl[] = ["none", "xon/xoff", "rts/cts"];

export const DEFAULT_TELNET_SERIAL_CONFIG: TelnetSerialConfig = {
  enabled: false,
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const pick = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/**
 * Coerce whatever was loaded from storage / cloud sync / an import into a
 * usable config. Unknown baud rates are kept (RFC 2217 can negotiate rates
 * outside our picker list); junk falls back to the default.
 */
export function normalizeTelnetSerialConfig(value: unknown): TelnetSerialConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_TELNET_SERIAL_CONFIG };
  const raw = value as Partial<TelnetSerialConfig>;
  return {
    enabled: Boolean(raw.enabled),
    baudRate: isPositiveInt(raw.baudRate) ? raw.baudRate : DEFAULT_TELNET_SERIAL_CONFIG.baudRate,
    dataBits: pick(raw.dataBits, TELNET_SERIAL_DATA_BITS, DEFAULT_TELNET_SERIAL_CONFIG.dataBits),
    stopBits: pick(raw.stopBits, TELNET_SERIAL_STOP_BITS, DEFAULT_TELNET_SERIAL_CONFIG.stopBits),
    parity: pick(raw.parity, TELNET_SERIAL_PARITIES, DEFAULT_TELNET_SERIAL_CONFIG.parity),
    flowControl: pick(
      raw.flowControl,
      TELNET_SERIAL_FLOW_CONTROLS,
      DEFAULT_TELNET_SERIAL_CONFIG.flowControl,
    ),
  };
}

/**
 * The config a session should negotiate, or `null` when this host is a plain
 * telnet host (option off) — the caller then behaves exactly as before.
 */
export const resolveTelnetSerialConfig = (
  host: Pick<Host, "protocol" | "telnetSerialConfig">,
): TelnetSerialConfig | null => {
  if (host.protocol !== "telnet") return null;
  if (!host.telnetSerialConfig) return null;
  const config = normalizeTelnetSerialConfig(host.telnetSerialConfig);
  return config.enabled ? config : null;
};

export const formatTelnetSerialConfig = (config: TelnetSerialConfig): string => {
  const parity = config.parity === "none" ? "N" : config.parity[0].toUpperCase();
  return `${config.baudRate} ${config.dataBits}${parity}${config.stopBits}`;
};

/**
 * Merge a patch into a host's stored config without dropping the block when
 * the user switches the option off: a stray click must not erase the baud and
 * framing they picked (same rule as the serial host config).
 */
export const mergeTelnetSerialConfig = (
  current: TelnetSerialConfig | undefined,
  patch: Partial<TelnetSerialConfig>,
): TelnetSerialConfig => normalizeTelnetSerialConfig({ ...normalizeTelnetSerialConfig(current), ...patch });
