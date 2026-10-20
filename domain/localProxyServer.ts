/**
 * Local proxy server ("make this PC a proxy server") configuration model.
 *
 * The listener itself runs in the main process (`electron/bridges/localProxyServer.cjs`);
 * this module only owns the persisted shape, its validation, and the translation
 * from a saved proxy profile into the upstream descriptor the bridge expects.
 */

import type { ProxyProfile } from './models';
import { isValidProxyPort } from './proxyProfiles';

export type LocalProxyServerScope = 'loopback' | 'lan';
export type LocalProxyUpstreamType = 'http' | 'socks5';

export interface LocalProxyUpstream {
  type: LocalProxyUpstreamType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface LocalProxyAuth {
  username: string;
  password: string;
}

export interface LocalProxyServerConfig {
  /** Persisted on/off switch: the service starts with the app when true. */
  enabled: boolean;
  /** loopback keeps it local-only; lan exposes it to the network. */
  scope: LocalProxyServerScope;
  port: number;
  /** Saved proxy profile used as the upstream hop, or null for a direct exit. */
  upstreamProfileId: string | null;
  authEnabled: boolean;
  username: string;
  password: string;
}

export interface LocalProxyServerStatus {
  running: boolean;
  host: string;
  port: number;
  upstreamType: LocalProxyUpstreamType | null;
  requiresAuth: boolean;
  activeConnections: number;
  totalConnections: number;
  requests: number;
  failures: number;
  lastError: string | null;
  /** First non-internal IPv4 of this machine, for the LAN endpoint hint. */
  lanAddress?: string | null;
  /** Every reachable IPv4 address, so each network the PC is on is covered. */
  lanAddresses?: string[];
}

export type LocalProxyServerError =
  | 'invalid-port'
  | 'invalid-credentials'
  | 'port-in-use'
  | 'permission-denied'
  | 'listen-failed'
  | 'missing-upstream'
  | 'unsupported-upstream';

export const DEFAULT_LOCAL_PROXY_SERVER_PORT = 1080;

export const DEFAULT_LOCAL_PROXY_SERVER_CONFIG: LocalProxyServerConfig = {
  enabled: false,
  // LAN by default: the point of the feature is that *other* devices use this PC
  // as their proxy. Loopback is one click away and the panel warns when a LAN
  // listener has no password.
  scope: 'lan',
  port: DEFAULT_LOCAL_PROXY_SERVER_PORT,
  upstreamProfileId: null,
  authEnabled: false,
  username: '',
  password: '',
};

export const IDLE_LOCAL_PROXY_SERVER_STATUS: LocalProxyServerStatus = {
  running: false,
  host: '127.0.0.1',
  port: DEFAULT_LOCAL_PROXY_SERVER_PORT,
  upstreamType: null,
  requiresAuth: false,
  activeConnections: 0,
  totalConnections: 0,
  requests: 0,
  failures: 0,
  lastError: null,
};

/** Address handed to the main-process listener for the chosen scope. */
export function resolveLocalProxyListenHost(config: LocalProxyServerConfig): string {
  return config.scope === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

export function normalizeLocalProxyServerConfig(raw: unknown): LocalProxyServerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LOCAL_PROXY_SERVER_CONFIG };
  const value = raw as Partial<LocalProxyServerConfig>;
  const port = Number(value.port);
  const upstreamProfileId =
    typeof value.upstreamProfileId === 'string' && value.upstreamProfileId.trim()
      ? value.upstreamProfileId.trim()
      : null;
  return {
    enabled: value.enabled === true,
    scope: value.scope === 'lan' || value.scope === 'loopback'
      ? value.scope
      : DEFAULT_LOCAL_PROXY_SERVER_CONFIG.scope,
    port: isValidProxyPort(port) ? port : DEFAULT_LOCAL_PROXY_SERVER_PORT,
    upstreamProfileId,
    authEnabled: value.authEnabled === true,
    username: typeof value.username === 'string' ? value.username : '',
    password: typeof value.password === 'string' ? value.password : '',
  };
}

/** Returns the first problem that blocks starting the server, or null. */
export function validateLocalProxyServerConfig(
  config: LocalProxyServerConfig,
): LocalProxyServerError | null {
  if (!isValidProxyPort(config.port)) return 'invalid-port';
  if (config.authEnabled && !config.username.trim()) return 'invalid-credentials';
  return null;
}

export function buildLocalProxyAuth(config: LocalProxyServerConfig): LocalProxyAuth | null {
  if (!config.authEnabled) return null;
  const username = config.username.trim();
  if (!username) return null;
  return { username, password: config.password };
}

export interface ResolvedLocalProxyUpstream {
  upstream: LocalProxyUpstream | null;
  error?: LocalProxyServerError;
}

/**
 * Turn the selected vault proxy profile into the bridge's upstream descriptor.
 * A missing or non-manual profile is an error on purpose: silently falling back
 * to a direct exit would leak traffic the user meant to route through it.
 */
export function resolveLocalProxyUpstream(
  config: LocalProxyServerConfig,
  profiles: ProxyProfile[],
): ResolvedLocalProxyUpstream {
  if (!config.upstreamProfileId) return { upstream: null };
  const profile = profiles.find((entry) => entry.id === config.upstreamProfileId);
  if (!profile) return { upstream: null, error: 'missing-upstream' };
  const { type, host, port, username, password } = profile.config;
  if (type !== 'http' && type !== 'socks5') return { upstream: null, error: 'unsupported-upstream' };
  if (!host.trim() || !isValidProxyPort(port)) return { upstream: null, error: 'missing-upstream' };
  return {
    upstream: {
      type,
      host: host.trim(),
      port: Number(port),
      ...(username ? { username, password: password ?? '' } : {}),
    },
  };
}

/** Proxy URL other devices should point at, e.g. socks5://192.168.1.28:1080. */
export function formatLocalProxyEndpoint(
  host: string,
  port: number,
  protocol: LocalProxyUpstreamType,
): string {
  const trimmed = host.replace(/^\[|\]$/g, '');
  const bracketed = trimmed.includes(':') ? `[${trimmed}]` : trimmed;
  return `${protocol}://${bracketed}:${port}`;
}

/** Whether exposing this listener on the LAN leaves it open to anyone. */
export function isLocalProxyOpenToNetwork(config: LocalProxyServerConfig): boolean {
  return config.scope === 'lan' && !config.authEnabled;
}
