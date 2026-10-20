import { useSyncExternalStore } from 'react';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_LOCAL_PROXY_SERVER } from '../../infrastructure/config/storageKeys';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { ProxyProfile } from '../../domain/models';
import {
  DEFAULT_LOCAL_PROXY_SERVER_CONFIG,
  IDLE_LOCAL_PROXY_SERVER_STATUS,
  buildLocalProxyAuth,
  normalizeLocalProxyServerConfig,
  resolveLocalProxyListenHost,
  resolveLocalProxyUpstream,
  type LocalProxyServerConfig,
  type LocalProxyServerError,
  type LocalProxyServerStatus,
} from '../../domain/localProxyServer';

/**
 * App-wide state for the "make this PC a proxy server" service.
 *
 * The listener lives in the main process, so this store only owns the persisted
 * configuration, mirrors the pushed runtime status, and forwards start/stop.
 * It is a module-level store (not a hook) because the service must keep running
 * while the vault proxy page is unmounted.
 */

function readStoredConfig(): LocalProxyServerConfig {
  try {
    const raw = localStorageAdapter.readString(STORAGE_KEY_LOCAL_PROXY_SERVER);
    if (!raw) return { ...DEFAULT_LOCAL_PROXY_SERVER_CONFIG };
    return normalizeLocalProxyServerConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LOCAL_PROXY_SERVER_CONFIG };
  }
}

type State = {
  config: LocalProxyServerConfig;
  status: LocalProxyServerStatus;
  /** A start/stop round-trip is in flight. */
  busy: boolean;
  error: LocalProxyServerError | null;
};

let state: State = {
  config: readStoredConfig(),
  status: { ...IDLE_LOCAL_PROXY_SERVER_STATUS },
  busy: false,
  error: null,
};

/** Latest vault proxy profiles, used to resolve the upstream hop on demand. */
let proxyProfiles: ProxyProfile[] = [];
let unsubscribeStatus: (() => void) | null = null;
let bootstrapped = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  emit();
}

function persistConfig(config: LocalProxyServerConfig): void {
  try {
    localStorageAdapter.writeString(STORAGE_KEY_LOCAL_PROXY_SERVER, JSON.stringify(config));
  } catch {
    // Storage quota problems must not stop the service from starting.
  }
}

export function getLocalProxyServerState(): State {
  return state;
}

export function subscribeLocalProxyServer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocalProxyServer(): State {
  return useSyncExternalStore(subscribeLocalProxyServer, getLocalProxyServerState, getLocalProxyServerState);
}

/** Keep the upstream resolver in sync with the vault's proxy profiles. */
export function syncLocalProxyServerProfiles(profiles: ProxyProfile[]): void {
  const changed = profiles !== proxyProfiles;
  proxyProfiles = profiles;
  // A service the user left enabled may have deferred its start because the
  // vault had not loaded the upstream profile yet — resume once it arrives.
  if (changed && state.config.enabled && !state.status.running && !state.busy) {
    void startLocalProxyServer();
  }
}

function applyStatus(status: LocalProxyServerStatus | undefined): void {
  if (!status) return;
  setState({ status });
}

export function setLocalProxyServerConfig(patch: Partial<LocalProxyServerConfig>): void {
  const next = normalizeLocalProxyServerConfig({ ...state.config, ...patch });
  const changed = JSON.stringify(next) !== JSON.stringify(state.config);
  if (!changed) return;
  persistConfig(next);
  setState({ config: next, error: null });
}

/**
 * Start the listener with the current config. Persists `enabled` so the service
 * comes back on the next launch unless the user stops it.
 */
export async function startLocalProxyServer(): Promise<LocalProxyServerError | null> {
  const bridge = netcattyBridge.get();
  const resolved = resolveLocalProxyUpstream(state.config, proxyProfiles);
  if (resolved.error) {
    setState({ error: resolved.error, busy: false });
    return resolved.error;
  }
  if (!bridge?.startLocalProxyServer) {
    setState({ error: 'listen-failed', busy: false });
    return 'listen-failed';
  }
  setState({ busy: true, error: null });
  try {
    const result = await bridge.startLocalProxyServer({
      bindHost: resolveLocalProxyListenHost(state.config),
      port: state.config.port,
      upstream: resolved.upstream,
      auth: buildLocalProxyAuth(state.config),
    });
    if (!result?.success) {
      const failure = (result?.error as LocalProxyServerError) || 'listen-failed';
      setState({ busy: false, error: failure });
      applyStatus(result?.status);
      return failure;
    }
    const config = { ...state.config, enabled: true };
    persistConfig(config);
    setState({ config, busy: false, error: null });
    applyStatus(result.status);
    return null;
  } catch {
    setState({ busy: false, error: 'listen-failed' });
    return 'listen-failed';
  }
}

export async function stopLocalProxyServer(): Promise<void> {
  const bridge = netcattyBridge.get();
  const config = { ...state.config, enabled: false };
  persistConfig(config);
  setState({ config, busy: true, error: null });
  try {
    const status = await bridge?.stopLocalProxyServer?.();
    applyStatus(status);
  } catch {
    // ignore: the run state is authoritative from the next status push
  }
  setState({ busy: false, status: { ...state.status, running: false, activeConnections: 0 } });
}

/** Toggle used by the panel's main switch; returns the failure, if any. */
export async function setLocalProxyServerEnabled(
  enabled: boolean,
): Promise<LocalProxyServerError | null> {
  if (!enabled) {
    await stopLocalProxyServer();
    return null;
  }
  return startLocalProxyServer();
}

/**
 * Mirror the main-process status and resume a service the user left enabled.
 * Safe to call more than once (idempotent); AppView calls it on mount.
 */
export function bootstrapLocalProxyServer(): () => void {
  if (bootstrapped) return () => {};
  bootstrapped = true;
  const bridge = netcattyBridge.get();
  if (bridge?.onLocalProxyServerStatus && !unsubscribeStatus) {
    unsubscribeStatus = bridge.onLocalProxyServerStatus((status) => {
      applyStatus(status as LocalProxyServerStatus);
    });
  }
  void (async () => {
    try {
      const status = await bridge?.getLocalProxyServerStatus?.();
      applyStatus(status as LocalProxyServerStatus);
    } catch {
      // ignore
    }
    if (state.config.enabled && !state.status.running) {
      void startLocalProxyServer();
    }
  })();
  return () => {
    bootstrapped = false;
    unsubscribeStatus?.();
    unsubscribeStatus = null;
  };
}

/** Persist a config change and restart when the listener is already up. */
export async function updateLocalProxyServerConfig(
  patch: Partial<LocalProxyServerConfig>,
): Promise<void> {
  const previous = state.config;
  setLocalProxyServerConfig(patch);
  if (state.config === previous) return;
  if (state.status.running) await startLocalProxyServer();
}
