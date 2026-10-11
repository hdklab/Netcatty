/**
 * Update Service
 *
 * Combines two update mechanisms:
 * 1. Self-hosted release metadata check (used by useUpdateCheck for the banner)
 * 2. electron-updater bridge (used by SettingsSystemTab for download/install)
 *
 * The cloud (GitHub Releases) source is intentionally gone: updates come from
 * the self-hosted endpoints reserved in infrastructure/config/selfHostedEndpoints.json.
 * While those endpoints are unset nothing is checked and no cloud request is
 * made, so the app cannot silently upgrade from GitHub. The contract the server
 * has to serve is documented in docs/self-hosted-update-and-config-server.md.
 */

import { netcattyBridge } from "./netcattyBridge";
import selfHostedEndpoints from "../config/selfHostedEndpoints.json";

// ================================
// Part 1: Self-hosted Release Metadata Check
// ================================

/** Trim a configured URL and strip trailing slashes; null when unset/blank. */
function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export type UpdateSourceOrigin = 'env' | 'config' | 'default' | 'none';

export interface UpdateSourceConfig {
  /** electron-updater feed base for the self-hosted update server (null = unconfigured). */
  updateServerUrl: string | null;
  /** Human-facing download page on the self-hosted server (null = unconfigured). */
  releasesPageUrl: string | null;
  /** Where the effective URL comes from — shown in Settings. */
  source: UpdateSourceOrigin;
  /** True when NETCATTY_UPDATE_SERVER_URL overrides the in-app configuration. */
  envOverride: boolean;
}

/**
 * Factory defaults. The app resolves the effective source in the main process
 * (env override → in-app configuration → these defaults) and hydrates this
 * store from `netcatty:update:getUpdateSource`; a save in Settings updates it
 * immediately through the returned config and the source-changed broadcast.
 */
const DEFAULT_UPDATE_SOURCE: UpdateSourceConfig = {
  updateServerUrl: normalizeBaseUrl(selfHostedEndpoints.updateServerUrl),
  releasesPageUrl: normalizeBaseUrl(selfHostedEndpoints.releasesPageUrl),
  source: normalizeBaseUrl(selfHostedEndpoints.updateServerUrl) ? 'default' : 'none',
  envOverride: false,
};

let updateSource: UpdateSourceConfig = DEFAULT_UPDATE_SOURCE;
const updateSourceListeners = new Set<() => void>();

/** Current (hydrated) update source. */
export function getUpdateSourceConfig(): UpdateSourceConfig {
  return updateSource;
}

/** Subscribe to source changes; returns the unsubscribe function. */
export function subscribeUpdateSource(listener: () => void): () => void {
  updateSourceListeners.add(listener);
  return () => {
    updateSourceListeners.delete(listener);
  };
}

/** Apply a source snapshot (hydrated from main, or returned by a save). */
export function applyUpdateSourceConfig(next: Partial<UpdateSourceConfig> | null | undefined): void {
  if (!next) return;
  const updateServerUrl = next.updateServerUrl === undefined
    ? updateSource.updateServerUrl
    : normalizeBaseUrl(next.updateServerUrl);
  const releasesPageUrl = next.releasesPageUrl === undefined
    ? updateSource.releasesPageUrl
    : normalizeBaseUrl(next.releasesPageUrl);
  updateSource = {
    updateServerUrl,
    releasesPageUrl,
    source: next.source ?? updateSource.source,
    envOverride: next.envOverride ?? updateSource.envOverride,
  };
  for (const listener of updateSourceListeners) listener();
}

let hydrationPromise: Promise<void> | null = null;

/**
 * Read the effective source from the main process once per window. Safe to call
 * from every consumer — the promise is shared.
 */
export function ensureUpdateSourceHydrated(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      const bridge = netcattyBridge.get();
      if (!bridge?.getUpdateSource) return;
      try {
        applyUpdateSourceConfig(await bridge.getUpdateSource());
      } catch (err) {
        console.warn('[updateService] Failed to read the update source:', err);
      }
    })();
  }
  return hydrationPromise;
}

/** Persist a new self-hosted source (Settings) and apply it to the live store. */
export async function saveUpdateSourceConfig(input: {
  updateServerUrl: string;
  releasesPageUrl: string;
}): Promise<{ success: boolean; error?: string }> {
  const bridge = netcattyBridge.get();
  if (!bridge?.setUpdateSource) return { success: false, error: 'bridgeUnavailable' };
  try {
    const result = await bridge.setUpdateSource(input);
    if (result?.success) applyUpdateSourceConfig(result);
    return { success: Boolean(result?.success), error: result?.error };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Track source saves made in another window (Settings) so a check started here
 * uses the same source without a restart. Returns the unsubscribe function.
 */
export function subscribeUpdateSourceChanges(): () => void {
  const bridge = netcattyBridge.get();
  return bridge?.onUpdateSourceChanged?.((config) => applyUpdateSourceConfig(config)) ?? (() => {});
}

/**
 * True once a self-hosted update source is configured. While false every update
 * entry point (startup check, manual check, release links) stays inert instead
 * of falling back to the cloud.
 */
export function isUpdateSourceConfigured(): boolean {
  return updateSource.updateServerUrl !== null;
}

/**
 * Reserved release-metadata path on the self-hosted server. The file keeps the
 * shape of GitHub's `releases/latest` payload so the parsing below stays
 * unchanged: { tag_name, name, body, html_url, published_at, assets[] }.
 */
export function buildReleaseMetadataUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl) ?? ""}/latest.json`;
}

export interface ReleaseInfo {
  version: string;       // e.g. "1.0.0" (without 'v' prefix)
  tagName: string;       // e.g. "v1.0.0"
  name: string;          // Release title
  body: string;          // Release notes (markdown)
  htmlUrl: string;       // URL to the release page
  publishedAt: string;   // ISO date string
  assets: ReleaseAsset[];
}

export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestRelease: ReleaseInfo | null;
  error?: string;
}

/**
 * Parse version string to comparable array
 * e.g. "1.2.3" -> [1, 2, 3]
 */
function parseVersion(version: string): number[] {
  // Remove 'v' prefix if present
  const clean = version.replace(/^v/i, '');
  return clean.split('.').map((part) => {
    const num = parseInt(part, 10);
    return isNaN(num) ? 0 : num;
  });
}

/**
 * Compare two version strings
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Check for updates against the configured self-hosted release metadata.
 * Used by useUpdateCheck for the notification banner.
 *
 * With no configured source this returns "no update" without any network call —
 * the cloud path is cancelled, not merely deprioritized.
 */
export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  return checkForUpdatesAgainst(getUpdateSourceConfig().updateServerUrl, currentVersion);
}

/**
 * Read the release manifest (`<baseUrl>/latest.json`).
 *
 * The main process performs the request whenever the bridge is available: feed
 * hosts generally answer without an Access-Control-Allow-Origin header (the
 * factory GitHub release-asset URL does not), so the renderer's own fetch is
 * blocked by CORS even though the file is reachable. Browsers and unit tests
 * without the bridge fall back to fetch.
 */
async function readReleaseMetadata(baseUrl: string): Promise<unknown> {
  const bridge = netcattyBridge.get();
  if (bridge?.fetchUpdateMetadata) {
    const result = await bridge.fetchUpdateMetadata({ baseUrl });
    if (!result?.ok) throw new Error(result?.error || 'Update check failed');
    return result.data;
  }

  const response = await fetch(buildReleaseMetadataUrl(baseUrl), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Update server returned ${response.status}`);
  }
  return response.json();
}

/** Release metadata as served on the wire (GitHub `releases/latest` shape). */
interface ReleaseMetadataPayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>;
}

/**
 * Source-explicit variant of checkForUpdates. `baseUrl === null` means the
 * cloud source is cancelled and the reserved self-hosted source is still
 * unconfigured, so no request is made at all.
 */
export async function checkForUpdatesAgainst(
  baseUrl: string | null,
  currentVersion: string,
): Promise<UpdateCheckResult> {
  if (!baseUrl) {
    return { hasUpdate: false, currentVersion, latestRelease: null };
  }

  try {
    const data = (await readReleaseMetadata(baseUrl)) as ReleaseMetadataPayload;
    const latestVersion = String(data.tag_name).replace(/^v/i, '');

    const latestRelease: ReleaseInfo = {
      version: latestVersion,
      tagName: String(data.tag_name),
      name: String(data.name || data.tag_name),
      body: typeof data.body === 'string' ? data.body : '',
      htmlUrl: String(data.html_url ?? ''),
      publishedAt: String(data.published_at ?? ''),
      assets: (data.assets ?? []).map((a) => ({
        name: String(a.name ?? ''),
        browserDownloadUrl: String(a.browser_download_url ?? ''),
        size: Number(a.size ?? 0),
      })),
    };

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return { hasUpdate, currentVersion, latestRelease };
  } catch (error) {
    return {
      hasUpdate: false,
      currentVersion,
      latestRelease: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Human-facing download page of the configured self-hosted update source.
 * Returns '' while no source is configured — callers must not open anything
 * in that state (there is no cloud page to fall back to).
 */
export function getReleasesPageUrl(): string {
  return getUpdateSourceConfig().releasesPageUrl ?? '';
}

/**
 * Get download URL for current platform
 */
export function getDownloadUrlForPlatform(
  release: ReleaseInfo,
  platform: string
): string | null {
  const assets = release.assets;

  // Platform-specific file patterns
  const patterns: Record<string, RegExp[]> = {
    win32: [/\.exe$/i, /win.*\.zip$/i, /windows/i],
    darwin: [/\.dmg$/i, /mac.*\.zip$/i, /darwin/i],
    linux: [/\.AppImage$/i, /\.deb$/i, /linux/i],
  };

  const platformPatterns = patterns[platform] || [];

  for (const pattern of platformPatterns) {
    const asset = assets.find((a) => pattern.test(a.name));
    if (asset) {
      return asset.browserDownloadUrl;
    }
  }

  // Fallback to release page
  return null;
}

// =============================================
// Part 2: electron-updater Bridge (IPC-based)
// =============================================

export interface ElectronUpdateCheckResult {
  available: boolean;
  supported?: boolean;
  version?: string;
  releaseNotes?: string;
  releaseDate?: string | null;
  error?: string;
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export async function checkForUpdate(): Promise<ElectronUpdateCheckResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.checkForUpdate) {
    return { available: false, supported: false, error: "Bridge unavailable" };
  }
  try {
    return await bridge.checkForUpdate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { available: false, error: message };
  }
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
  const bridge = netcattyBridge.get();
  if (!bridge?.downloadUpdate) {
    return { success: false, error: "Bridge unavailable" };
  }
  return bridge.downloadUpdate();
}

export function installUpdate(): void {
  const bridge = netcattyBridge.get();
  bridge?.installUpdate?.();
}

export function onDownloadProgress(
  cb: (progress: UpdateDownloadProgress) => void,
): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateDownloadProgress?.(cb);
}

export function onDownloaded(cb: () => void): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateDownloaded?.(cb);
}

export function onError(
  cb: (payload: { error: string }) => void,
): (() => void) | undefined {
  return netcattyBridge.get()?.onUpdateError?.(cb);
}
