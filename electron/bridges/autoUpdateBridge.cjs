/**
 * Auto-Update Bridge
 *
 * Wraps electron-updater to provide IPC-driven update checks, downloads, and
 * install-on-quit. Designed around a "prompt" model: the renderer asks to
 * check, then explicitly triggers download and install.
 *
 * Update source: the operator's own server. It resolves from, in order,
 * NETCATTY_UPDATE_SERVER_URL (launch-time override), the in-app configuration in
 * <userData>/self-hosted-update.json (Settings > System > Software Update), and
 * the factory defaults in infrastructure/config/selfHostedEndpoints.json. It is
 * consumed as an electron-updater "generic" feed, which replaces the cloud
 * release feed baked into app-update.yml. While no source is configured, cloud
 * (GitHub) auto-update stays cancelled — no feed is contacted for checks or
 * downloads. The server-side layout is documented in
 * docs/self-hosted-update-and-config-server.md.
 *
 * Linux packages use electron-updater's package-manager path when the
 * electron-builder package-type marker is present. Unmarked Linux builds
 * (including snap and development runs) get a graceful fallback so the
 * renderer can offer a manual download link.
 */

let _deps = null;

/**
 * Read the persisted auto-update preference from a JSON file in userData.
 * Returns true (default) if the file doesn't exist or is unreadable.
 */
function readAutoUpdatePreference() {
  try {
    const { app } = _deps?.electronModule || {};
    if (!app) return true;
    const path = require('path');
    const fs = require('fs');
    const prefPath = path.join(app.getPath('userData'), 'auto-update-pref.json');
    const data = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    return data.enabled !== false;
  } catch {
    return true; // default to enabled
  }
}

/**
 * Persist the auto-update preference to a JSON file in userData.
 */
function writeAutoUpdatePreference(enabled) {
  try {
    const { app } = _deps?.electronModule || {};
    if (!app) return;
    const path = require('path');
    const fs = require('fs');
    const prefPath = path.join(app.getPath('userData'), 'auto-update-pref.json');
    fs.writeFileSync(prefPath, JSON.stringify({ enabled }), 'utf8');
  } catch (err) {
    console.warn('[AutoUpdate] Failed to write preference:', err?.message || err);
  }
}

const SUPPORTED_LINUX_PACKAGE_TYPES = new Set(["deb", "rpm", "pacman"]);

/** Trim a configured base URL and drop trailing slashes; null when blank. */
function normalizeBaseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Factory defaults shipped with the app (no user configuration). */
function readShippedSelfHostedEndpoints() {
  try {
    return require("../../infrastructure/config/selfHostedEndpoints.cjs") || {};
  } catch (err) {
    console.warn("[AutoUpdate] Failed to read shipped self-hosted endpoints:", err?.message || err);
    return {};
  }
}

/** Path of the in-app update source configuration (userData JSON). */
function selfHostedConfigPath() {
  const { app } = _deps?.electronModule || {};
  if (!app?.getPath) return null;
  const path = require("path");
  return path.join(app.getPath("userData"), "self-hosted-update.json");
}

/**
 * Configuration written from Settings, or {} when unreadable/unset.
 *
 * `stored: true` means the operator saved the form — even if they cleared both
 * fields. That is an explicit decision and has to outrank the shipped factory
 * feed, otherwise "Clear" silently puts the cloud source back.
 */
function readStoredSelfHostedConfig() {
  const file = selfHostedConfigPath();
  if (!file) return {};
  try {
    const fs = require("fs");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return {
      stored: true,
      updateServerUrl: normalizeBaseUrl(parsed.updateServerUrl) ?? null,
      releasesPageUrl: normalizeBaseUrl(parsed.releasesPageUrl) ?? null,
    };
  } catch {
    return {};
  }
}

/** Persist the Settings configuration. `null` clears an entry. */
function writeStoredSelfHostedConfig({ updateServerUrl = null, releasesPageUrl = null } = {}) {
  const file = selfHostedConfigPath();
  if (!file) return false;
  try {
    const fs = require("fs");
    fs.writeFileSync(
      file,
      JSON.stringify(
        { updateServerUrl: normalizeBaseUrl(updateServerUrl), releasesPageUrl: normalizeBaseUrl(releasesPageUrl) },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch (err) {
    console.warn("[AutoUpdate] Failed to write update source config:", err?.message || err);
    return false;
  }
}

/**
 * Validate the two URLs coming from Settings. Empty strings clear an entry;
 * anything else must be an absolute http(s) URL.
 */
function validateUpdateSourceInput(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const normalized = {};
  for (const key of ["updateServerUrl", "releasesPageUrl"]) {
    const raw = typeof input[key] === "string" ? input[key].trim() : "";
    if (!raw) {
      normalized[key] = null;
      continue;
    }
    // Require an explicit authority right after the scheme: WHATWG URL parsing
    // happily turns `https:///path` into host "path", which is never what an
    // update feed URL means.
    if (!/^https?:\/\/[^\s/?#]+/i.test(raw)) return { ok: false, error: "invalidUrl" };
    try {
      new URL(raw);
    } catch {
      return { ok: false, error: "invalidUrl" };
    }
    normalized[key] = normalizeBaseUrl(raw);
  }
  return { ok: true, ...normalized };
}

/**
 * Effective update source: NETCATTY_UPDATE_SERVER_URL wins over the in-app
 * configuration, which wins over the shipped factory defaults. A saved
 * configuration always beats the factory defaults — saving it with an empty feed
 * URL means "updates off", and `null` then means "not configured", so the cloud
 * source is cancelled and never used as a fallback.
 */
function resolveUpdateSource() {
  const shipped = readShippedSelfHostedEndpoints();
  const stored = readStoredSelfHostedConfig();
  const fromEnv = normalizeBaseUrl(process.env.NETCATTY_UPDATE_SERVER_URL);
  const shippedUpdateUrl = normalizeBaseUrl(shipped.updateServerUrl);
  const shippedPageUrl = normalizeBaseUrl(shipped.releasesPageUrl);
  const storedUpdateUrl = stored.updateServerUrl ?? null;
  const storedPageUrl = stored.releasesPageUrl ?? null;
  const savedConfig = Boolean(stored.stored);

  const updateServerUrl = fromEnv ?? (savedConfig ? storedUpdateUrl : shippedUpdateUrl ?? null);
  const releasesPageUrl = storedPageUrl ?? shippedPageUrl ?? null;
  const source = fromEnv
    ? "env"
    : (storedUpdateUrl ? "config" : (savedConfig ? "none" : (shippedUpdateUrl ? "default" : "none")));

  return {
    updateServerUrl,
    releasesPageUrl,
    source,
    envOverride: Boolean(fromEnv),
    // Explicitly switched off in Settings (as opposed to "never configured").
    disabled: !fromEnv && savedConfig && !storedUpdateUrl,
  };
}

/**
 * Base URL of the operator's self-hosted update feed (null when unset).
 */
function readSelfHostedUpdateUrl() {
  return resolveUpdateSource().updateServerUrl;
}

/** True once a self-hosted update feed is configured. */
function isUpdateSourceConfigured() {
  return readSelfHostedUpdateUrl() !== null;
}

/**
 * Apply a changed feed to the already-resolved updater so a save in Settings
 * takes effect without restarting the app. Clearing the URL leaves the old
 * provider in place: the source gates (`isUpdateSourceConfigured()`) are what
 * keep every check entry point inert once the feed is cleared.
 */
function applySelfHostedFeedChange(updater) {
  const target = updater ?? _autoUpdater;
  if (!target || typeof target.setFeedURL !== "function") return;
  const url = readSelfHostedUpdateUrl();
  if (!url) return;
  try {
    target.setFeedURL({ provider: "generic", url });
    console.log("[AutoUpdate] Using self-hosted update feed:", url);
  } catch (err) {
    console.warn("[AutoUpdate] Failed to apply update feed:", err?.message || err);
  }
}

/**
 * Identify the Linux package format written by electron-builder into the
 * packaged resources directory. AppImage does not have this marker; its
 * runtime exposes the APPIMAGE environment variable instead.
 */
function getLinuxPackageType() {
  if (process.env.APPIMAGE) return "AppImage";
  if (typeof process.resourcesPath !== "string") return null;

  try {
    const fs = require("fs");
    const path = require("path");
    const packageType = fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
    return SUPPORTED_LINUX_PACKAGE_TYPES.has(packageType) ? packageType : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the current packaging format supports electron-updater
 * (macOS zip/dmg, Windows NSIS, Linux AppImage/deb/rpm/pacman).
 */
function isAutoUpdateSupported() {
  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }
  return process.platform === "linux" && getLinuxPackageType() !== null;
}

/** Lazily resolved autoUpdater — avoids importing electron-updater in
 *  contexts where native modules might not be available. */
let _autoUpdater = null;

/** Guard against duplicate listener registration */
let _listenersRegistered = false;

/** Track whether a download is in progress to distinguish download errors from check errors */
let _isDownloading = false;

/** Track whether quitAndInstall has entered the package installation phase */
let _isInstalling = false;

/** Track whether a checkForUpdates call is in flight (set before call, cleared on result event) */
let _isChecking = false;

/**
 * Snapshot of the last known update status so newly opened windows can hydrate
 * without waiting for the next IPC event.
 * @type {{ status: 'idle' | 'downloading' | 'ready' | 'error', percent: number, error: string | null, version: string | null, isChecking: boolean }}
 */
let _lastStatus = { status: 'idle', percent: 0, error: null, version: null, isChecking: false };
function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = readAutoUpdatePreference();
    autoUpdater.autoInstallOnAppQuit = false;
    // Silence the default electron-log transport (we log ourselves).
    autoUpdater.logger = null;
    // Point electron-updater at the operator's own feed, replacing the cloud
    // provider baked into app-update.yml. Skipped while the source is
    // unconfigured, in which case nothing below ever contacts a feed.
    applySelfHostedFeedChange(autoUpdater);
    _autoUpdater = autoUpdater;
    return autoUpdater;
  } catch (err) {
    console.error("[AutoUpdate] Failed to load electron-updater:", err?.message || err);
    return null;
  }
}

/**
 * Register persistent global IPC event listeners for auto-download flow.
 * Called once in init(). Forwards electron-updater events to the renderer
 * even when no manual download was initiated.
 */
function setupGlobalListeners() {
  if (_listenersRegistered) return;
  const updater = getAutoUpdater();
  if (!updater) return;
  _listenersRegistered = true;

  updater.on("update-not-available", () => {
    _isChecking = false;
    // Reset stale status so late-opening windows don't hydrate from a
    // previous 'error' or 'ready' snapshot after a "no update" check.
    _lastStatus = { status: 'idle', percent: 0, error: null, version: null, isChecking: false };
    broadcastToAllWindows("netcatty:update:update-not-available", {});
  });

  updater.on("update-available", (info) => {
    _isChecking = false;
    // Only track as downloading when autoDownload is enabled — otherwise no
    // download will actually start and the status would be stuck at 0%.
    // Use 'available' so late-opening windows can still hydrate the version.
    const willDownload = updater.autoDownload !== false;
    _isDownloading = willDownload;
    _lastStatus = { status: willDownload ? 'downloading' : 'available', percent: 0, error: null, version: info.version || null, isChecking: false };
    broadcastToAllWindows("netcatty:update:update-available", {
      version: info.version || "",
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "",
      releaseDate: info.releaseDate || null,
    });
  });

  updater.on("download-progress", (info) => {
    _lastStatus.percent = Math.round(info.percent ?? 0);
    broadcastToAllWindows("netcatty:update:download-progress", {
      percent: info.percent ?? 0,
      bytesPerSecond: info.bytesPerSecond ?? 0,
      transferred: info.transferred ?? 0,
      total: info.total ?? 0,
    });
  });

  updater.on("update-downloaded", () => {
    _isDownloading = false;
    _lastStatus = { ..._lastStatus, status: 'ready', percent: 100 };
    broadcastToAllWindows("netcatty:update:downloaded");
  });

  updater.on("error", (err) => {
    _isChecking = false;
    // Only broadcast download-phase errors; check-phase errors (e.g. network failures
    // during checkForUpdates) are not download failures and must not set autoDownloadStatus.
    // Install errors are also broadcast: Linux package managers report a cancelled
    // elevation prompt or a failed command after update-downloaded has already
    // cleared _isDownloading.
    if (!_isDownloading && !_isInstalling) {
      _lastStatus = { ..._lastStatus, isChecking: false };
      console.warn("[AutoUpdate] Check-phase error (not broadcast to renderer):", err?.message || err);
      return;
    }
    _isDownloading = false;
    const errorMsg = err?.message || "Unknown update error";
    if (_isInstalling) {
      _isInstalling = false;
      cancelQuittingForUpdateWatchdog();
      setQuittingForUpdate(false);
    }
    _lastStatus = { ..._lastStatus, status: 'error', error: errorMsg };
    broadcastToAllWindows("netcatty:update:error", {
      error: errorMsg,
    });
  });

  console.log("[AutoUpdate] Global listeners registered");
}

/**
 * Trigger an automatic update check after a delay.
 * No-op on platforms that don't support auto-update (for example Linux snap
 * or an unmarked development build).
 * Called from main process after the main window is created.
 *
 * @param {number} delayMs - Milliseconds to wait before checking (default: 5000)
 */
let _autoCheckTimer = null;

function startAutoCheck(delayMs = 5000) {
  if (!isAutoUpdateSupported()) {
    console.log("[AutoUpdate] Platform does not support auto-update, skipping auto-check");
    return;
  }
  if (!isUpdateSourceConfigured()) {
    // Cloud (GitHub) auto-update is cancelled until the reserved self-hosted
    // update feed is configured — never fall back to the packaged cloud feed.
    console.log("[AutoUpdate] No self-hosted update source configured, skipping auto-check");
    return;
  }
  // Cancel any existing timer to avoid duplicate concurrent checks
  // (e.g. from multiple windows initializing or re-enable toggle).
  cancelAutoCheck();
  _autoCheckTimer = setTimeout(async () => {
    _autoCheckTimer = null;
    const updater = getAutoUpdater();
    if (!updater) {
      console.warn("[AutoUpdate] Auto-check skipped — updater not available");
      return;
    }
    // Respect autoDownload flag — the renderer may have disabled it via IPC
    // before this timer fires.
    if (updater.autoDownload === false) {
      console.log("[AutoUpdate] Auto-check skipped — autoDownload is disabled");
      return;
    }
    _isChecking = true;
    _lastStatus = { ..._lastStatus, isChecking: true };
    try {
      console.log("[AutoUpdate] Starting automatic update check...");
      const checked = await checkForUpdatesWithRetry(updater);
      if (checked.error) throw checked.error;
    } catch (err) {
      _isChecking = false;
      _lastStatus = { ..._lastStatus, isChecking: false };
      console.warn("[AutoUpdate] Auto-check failed:", describeUpdateError(err));
    }
  }, delayMs);
}

/** Small backoff before re-trying a failed check (transient feed/network hiccups). */
const CHECK_RETRY_DELAYS_MS = [800, 2500];

/**
 * Turn an updater failure into something the settings panel can explain.
 * electron-updater's own message ("Fail to fetch") says nothing about whether
 * the feed was unreachable, rate-limited, or not published yet, so surface the
 * HTTP status / error code that came with it.
 *
 * The most common self-hosted failure — a release whose `latest*.yml` has not
 * been published yet — arrives as an ERR_UPDATER_CHANNEL_FILE_NOT_FOUND whose
 * message embeds the raw 404 *plus a stack trace*, and it carries no
 * statusCode. Recover the status from the text, say what it means in one line,
 * and never let the stack reach the UI.
 */
function describeUpdateError(err) {
  const raw = (err && err.message) || String(err || "Unknown update check error");
  const firstLine = String(raw).split("\n")[0].trim();
  const status = err && (err.statusCode || err.status);
  if (status) return `${firstLine} (HTTP ${status})`;

  const code = err && err.code;
  // electron-updater's HttpError puts the status in the text ("HttpError: 404
  // Not Found"), not in a property.
  const httpFromText = /HTTP[\s:]*(?:Error[\s:]*)?(\d{3})/i.exec(String(raw));
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") {
    const http = httpFromText ? ` (HTTP ${httpFromText[1]})` : "";
    return (
      `The update feed is missing its latest-*.yml metadata${http} — ` +
      `the release may still be publishing. (${code})`
    );
  }
  if (typeof code === "string" && code) return `${firstLine} (${code})`;
  return firstLine;
}

/**
 * checkForUpdates() with a couple of retries. A feed that is mid-publish (or a
 * momentary proxy failure) fails once and then succeeds, which is exactly the
 * case that used to leave the user staring at a bare fetch error.
 */
async function checkForUpdatesWithRetry(updater) {
  let lastError = null;
  for (let attempt = 0; attempt <= CHECK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return { result: await updater.checkForUpdates() };
    } catch (err) {
      lastError = err;
      const delay = CHECK_RETRY_DELAYS_MS[attempt];
      if (delay == null) break;
      console.warn(`[AutoUpdate] Check failed (${err && err.message ? err.message : err}); retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { error: lastError };
}

/**
 * Cancel a pending startAutoCheck timer.  Called when the renderer triggers
 * a manual check to avoid racing with the queued auto-check.
 */
function cancelAutoCheck() {
  if (_autoCheckTimer) {
    clearTimeout(_autoCheckTimer);
    _autoCheckTimer = null;
  }
}

/**
 * Flip the windowManager "quitting for update" flag, swallowing the case where
 * the window manager module isn't available. Used by the install handler to
 * commit the app to a clean quit before quitAndInstall, and to roll back if the
 * install never actually quits (#1215).
 */
function setQuittingForUpdate(enabled) {
  try {
    const windowManager = require("./windowManager.cjs");
    windowManager.setQuittingForUpdate(!!enabled);
  } catch {
    // ignore — window manager may not be available
  }
}

/**
 * The webContents for usable dirty-editor windows. Used by the install handler
 * to ask every renderer that can own editor tabs about unsaved work before
 * committing to a quit. Targets registered editor owners specifically (not
 * getAllWindows()[0]) so we never query tray/settings windows, whose renderers
 * don't participate in the dirty-editor protocol.
 */
function getDirtyEditorWebContentsList() {
  try {
    const windowManager = require("./windowManager.cjs");
    const windows = typeof windowManager.getDirtyEditorWindows === "function"
      ? windowManager.getDirtyEditorWindows()
      : typeof windowManager.getMainWindows === "function"
        ? windowManager.getMainWindows()
        : [windowManager.getMainWindow?.()].filter(Boolean);
    return windows
      .filter((win) => win && !win.isDestroyed?.())
      .map((win) => win.webContents)
      .filter((wc) => wc && !wc.isDestroyed?.() && !wc.isCrashed?.());
  } catch {
    return [];
  }
}

/**
 * Tell the renderer that the update can't install yet because there are unsaved
 * editors. The renderer surfaces a toast asking the user to save, then click
 * "Restart Now" again.
 *
 * Broadcast to ALL windows, not just the main one: the install can be triggered
 * from the Settings window's "Restart to Update" button, and that's the focused
 * window the user is looking at. Sending only to the (possibly hidden/behind)
 * main window would make the click appear to do nothing (#1215 review). The
 * unsaved editors live in the main window, but every window surfaces the same
 * "save first" notice so it lands wherever the user is.
 */
function notifyNeedsSave() {
  broadcastToAllWindows("netcatty:update:needs-save");
}

/** Max time to wait for the renderer's unsaved-editors reply before the install
 *  fails open and proceeds (matches the before-quit guard timeout). */
const INSTALL_DIRTY_CHECK_TIMEOUT_MS = 5000;

/**
 * Ask the main-window renderer whether it has unsaved editor changes, reusing
 * the shared dirty-editor round-trip. Resolves false (fail open) if the helper
 * is unavailable, so a missing module can never block an install. `ipcMain` is
 * the instance passed to registerHandlers; the helper needs it to listen for
 * the reply.
 */
function queryDirtyEditorsSafe(webContents, ipcMain) {
  try {
    const { queryDirtyEditors } = require("./dirtyEditorGuard.cjs");
    return queryDirtyEditors(webContents, INSTALL_DIRTY_CHECK_TIMEOUT_MS, { ipcMain });
  } catch (err) {
    console.warn("[AutoUpdate] dirty-editor guard unavailable:", err?.message || err);
    return Promise.resolve(false);
  }
}

/**
 * If quitAndInstall doesn't lead to the app actually quitting (it returns
 * without app.quit(), e.g. on a Squirrel.Mac follow-up error or a stale
 * downloaded file), the quitting-for-update flags would stay set and
 * permanently bypass close-to-tray + the dirty-editor quit guard. This
 * watchdog clears them if we're still running after a grace period.
 *
 * The grace period is deliberately long. On macOS quitAndInstall() can return
 * while Squirrel.Mac is still pulling the already-downloaded ZIP from the local
 * update server before it actually closes the windows; for a large/slow update
 * that second stage can take well over 10s. If the watchdog cleared isQuitting
 * during that window, the eventual native quit would hit a *non*-quitting
 * close-to-tray handler and get stranded again — the exact #1215 failure. So we
 * only roll back after a window long enough that the app is realistically stuck,
 * not merely slow. The cost of waiting longer is just that close-to-tray stays
 * bypassed a bit longer in the rare genuine-failure case (#1215 review).
 */
let _quittingForUpdateWatchdog = null;
const QUITTING_FOR_UPDATE_WATCHDOG_MS = 60000;

function cancelQuittingForUpdateWatchdog() {
  if (_quittingForUpdateWatchdog) {
    clearTimeout(_quittingForUpdateWatchdog);
    _quittingForUpdateWatchdog = null;
  }
}

function scheduleQuittingForUpdateWatchdog() {
  if (_quittingForUpdateWatchdog) {
    clearTimeout(_quittingForUpdateWatchdog);
  }
  _quittingForUpdateWatchdog = setTimeout(() => {
    _quittingForUpdateWatchdog = null;
    _isInstalling = false;
    // Still alive after the grace period — the install did not quit the app.
    console.warn("[AutoUpdate] App still running after quitAndInstall; clearing quitting-for-update state");
    setQuittingForUpdate(false);
  }, QUITTING_FOR_UPDATE_WATCHDOG_MS);
  // Don't let the watchdog keep the event loop (and thus the process) alive —
  // if the app is otherwise ready to quit, the timer must not block it.
  if (typeof _quittingForUpdateWatchdog.unref === "function") {
    _quittingForUpdateWatchdog.unref();
  }
}

/**
 * Cancel an install after the main quit guard finds unsaved editor changes.
 * The main process owns the dirty-editor decision, but the install lifecycle
 * state lives here and must be released together with the window-manager flag.
 */
function cancelPendingInstall() {
  if (!_isInstalling) return;
  _isInstalling = false;
  cancelQuittingForUpdateWatchdog();
  setQuittingForUpdate(false);
}

function init(deps) {
  _deps = deps;
  setupGlobalListeners();
}

/**
 * Broadcast an IPC event to all non-destroyed BrowserWindows.
 * Ensures both the main window and settings window always receive
 * auto-update events.
 * @param {string} channel
 * @param {unknown} [payload]
 */
function broadcastToAllWindows(channel, payload) {
  try {
    const { BrowserWindow } = _deps?.electronModule || {};
    if (!BrowserWindow) return;
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        if (payload !== undefined) {
          win.webContents.send(channel, payload);
        } else {
          win.webContents.send(channel);
        }
      }
    }
  } catch (err) {
    console.warn("[AutoUpdate] broadcastToAllWindows failed:", err?.message || err);
  }
}

function registerHandlers(ipcMain) {
  // ---- Check for updates ------------------------------------------------
  ipcMain.handle("netcatty:update:check", async () => {
    // Cancel any pending auto-check to prevent concurrent checkForUpdates()
    // calls — electron-updater rejects them and surfaces false errors.
    cancelAutoCheck();

    if (!isAutoUpdateSupported()) {
      return {
        available: false,
        supported: false,
        error: "Auto-update is not supported on this platform/package format.",
      };
    }

    if (!isUpdateSourceConfigured()) {
      // Cloud (GitHub) auto-update is cancelled and the reserved self-hosted
      // feed is still unconfigured: there is nothing to check against.
      return {
        available: false,
        supported: false,
        error: "No self-hosted update source configured.",
      };
    }

    const updater = getAutoUpdater();
    if (!updater) {
      return {
        available: false,
        supported: false,
        error: "Update module failed to load.",
      };
    }

    // If a check is already in flight (e.g. from startAutoCheck), don't
    // start a concurrent one — electron-updater rejects it and surfaces a
    // confusing error.  Return a sentinel so the renderer knows to wait.
    if (_isChecking) {
      return { available: false, supported: true, checking: true };
    }

    // If a download is already in progress or the update is ready to install,
    // skip the check entirely — calling checkForUpdates() while downloading
    // can cause electron-updater to error, which corrupts the download state
    // and forces the user to download manually (GitHub issue #522).
    if (_isDownloading) {
      return { available: true, supported: true, downloading: true, version: _lastStatus.version };
    }
    if (_lastStatus.status === 'ready') {
      return { available: true, supported: true, ready: true, version: _lastStatus.version };
    }

    try {
      _isChecking = true;
      _lastStatus = { ..._lastStatus, isChecking: true };
      const checked = await checkForUpdatesWithRetry(updater);
      if (checked.error) throw checked.error;
      const result = checked.result;
      if (!result || !result.updateInfo) {
        return { available: false, supported: true };
      }

      const { version, releaseNotes, releaseDate } = result.updateInfo;

      // Compare with current version using semver ordering.
      // Only report an update when the feed version is strictly newer,
      // avoiding false positives for pre-release or nightly builds.
      const { app } = _deps?.electronModule || {};
      const currentVersion = app?.getVersion?.() || "0.0.0";
      const isNewer = currentVersion.localeCompare(version, undefined, { numeric: true, sensitivity: 'base' }) < 0;
      if (!isNewer) {
        return { available: false, supported: true };
      }

      return {
        available: true,
        supported: true,
        version,
        releaseNotes: typeof releaseNotes === "string" ? releaseNotes : "",
        releaseDate: releaseDate || null,
      };
    } catch (err) {
      _isChecking = false;
      _lastStatus = { ..._lastStatus, isChecking: false };
      const described = describeUpdateError(err);
      console.warn("[AutoUpdate] Check failed:", described);
      return {
        available: false,
        supported: true,
        error: described,
      };
    }
  });

  // ---- Download update ---------------------------------------------------
  ipcMain.handle("netcatty:update:download", async () => {
    if (_isDownloading) {
      return { success: true };
    }
    if (!isUpdateSourceConfigured()) {
      return { success: false, error: "No self-hosted update source configured." };
    }
    const updater = getAutoUpdater();
    if (!updater) {
      return { success: false, error: "Update module not available." };
    }
    try {
      _isDownloading = true;
      _lastStatus = { ..._lastStatus, status: 'downloading', percent: 0, error: null };
      await updater.downloadUpdate();
      return { success: true };
    } catch (err) {
      _isDownloading = false;
      _lastStatus = { ..._lastStatus, status: 'error', error: err?.message || "Download failed", percent: 0 };
      // Don't broadcast here — the global updater "error" listener already handles it
      console.error("[AutoUpdate] Download failed:", err?.message || err);
      return { success: false, error: err?.message || "Download failed" };
    }
  });

  // ---- Get current update status (for late-opening windows) ---------------
  ipcMain.handle("netcatty:update:getStatus", () => {
    return { ..._lastStatus };
  });

  // ---- Install (quit & install) ------------------------------------------
  ipcMain.handle("netcatty:update:install", async () => {
    const updater = getAutoUpdater();
    if (!updater) return;
    if (_isInstalling) return;

    // Check for unsaved editors BEFORE committing to a quit (#1215 review).
    //
    // On macOS quitAndInstall() closes windows first and only then fires
    // before-quit. Once setQuittingForUpdate(true) lets the main window
    // actually close (instead of hiding to tray), the before-quit dirty-editor
    // guard can run after the window is already gone — isReachableByUser is
    // false, so it commits the quit and silently drops unsaved SFTP edits.
    //
    // So we ask the renderer here, while the window and renderer are still
    // alive. If there's unsaved work in any main window, abort the install
    // (don't touch the quitting flags, don't quitAndInstall) and tell the
    // renderer to prompt the user to save; they can click "Restart Now" again
    // afterwards. If no main window is reachable (no window / crashed
    // renderer) there's no user to ask, so we install directly — matching the
    // before-quit fail-open path.
    const editorWebContents = getDirtyEditorWebContentsList();
    if (editorWebContents.length > 0) {
      const dirtyResults = await Promise.all(
        editorWebContents.map((webContents) => queryDirtyEditorsSafe(webContents, ipcMain)),
      );
      if (dirtyResults.some(Boolean)) {
        // Broadcast so the notice reaches whichever window the user clicked
        // from (main or Settings), not just the main window we queried.
        notifyNeedsSave();
        return;
      }
    }

    // Another request may have completed its dirty-editor check while this
    // request was waiting. Only one request may commit the app to a quit.
    if (_isInstalling) return;

    // Commit the app to a real quit BEFORE quitAndInstall fires app.quit().
    // Without this the in-place install silently fails (#1215): the main-window
    // close handler hides to tray when close-to-tray is on, so the process
    // stays alive and Squirrel.Mac's ShipIt helper — which waits on the parent
    // PID to die before swapping the bundle — ends up in launchd "pending
    // spawn" limbo and never installs. setQuittingForUpdate(true) sets
    // isQuitting so close-to-tray is bypassed and the window actually closes.
    _isInstalling = true;
    setQuittingForUpdate(true);

    // On macOS, the system tray keeps the app process alive even after all
    // windows are closed, which prevents quitAndInstall from completing.
    // Destroy the tray (and its panel window) before quitting so the app
    // can exit cleanly and the installer can proceed.
    if (process.platform === "darwin") {
      try {
        const globalShortcutBridge = require("./globalShortcutBridge.cjs");
        globalShortcutBridge.cleanup();
      } catch {
        // ignore — bridge may not be available
      }
    }

    try {
      updater.quitAndInstall(false, true);
    } catch (err) {
      // quitAndInstall threw synchronously — the app will NOT quit. Roll back
      // the quitting-for-update flags so later closes/quits behave normally
      // instead of permanently bypassing close-to-tray + the dirty-editor
      // guard (#1215 review).
      console.error("[AutoUpdate] quitAndInstall failed:", err?.message || err);
      _isInstalling = false;
      cancelQuittingForUpdateWatchdog();
      setQuittingForUpdate(false);
      return;
    }

    // Linux package-manager failures emit the updater error synchronously from
    // quitAndInstall(). The error listener clears _isInstalling in that case,
    // so do not install a watchdog after the failure has already been handled.
    if (!_isInstalling) return;

    // quitAndInstall can also fail to quit asynchronously (e.g. Squirrel.Mac's
    // follow-up check errors, or a stale/missing downloaded file) — it returns
    // without app.quit() ever firing. A watchdog clears the flags if we're
    // still alive shortly after, so the app doesn't get stuck in a state where
    // every window close bypasses close-to-tray and the dirty-editor guard.
    scheduleQuittingForUpdateWatchdog();
  });

  // ---- Get auto-update preference -----------------------------------------
  ipcMain.handle("netcatty:update:getAutoUpdate", () => {
    return { enabled: readAutoUpdatePreference() };
  });

  // ---- Enable/disable auto-update ----------------------------------------
  let _prevAutoDownloadEnabled = readAutoUpdatePreference();
  ipcMain.handle("netcatty:update:setAutoUpdate", (_event, { enabled }) => {
    const wasEnabled = _prevAutoDownloadEnabled;
    _prevAutoDownloadEnabled = !!enabled;
    const updater = getAutoUpdater();
    if (updater) {
      updater.autoDownload = !!enabled;
      console.log("[AutoUpdate] autoDownload set to:", !!enabled);
    }
    // Persist so the preference survives app restarts
    writeAutoUpdatePreference(!!enabled);
    if (!enabled) {
      cancelAutoCheck();
    } else if (!wasEnabled && !_isChecking) {
      // Only re-schedule when actually re-enabling (not on every mount sync),
      // to avoid duplicate checks from multiple windows initializing.
      // Skip if a check is already in flight to prevent concurrent calls.
      startAutoCheck(2000);
    }
    return { success: true };
  });

  // ---- Update source (self-hosted server) configuration --------------------
  const describeUpdateSource = () => {
    const shipped = readShippedSelfHostedEndpoints();
    const stored = readStoredSelfHostedConfig();
    const effective = resolveUpdateSource();
    return {
      ...effective,
      // Editable values shown in Settings (empty string = not stored).
      storedUpdateServerUrl: stored.updateServerUrl ?? "",
      storedReleasesPageUrl: stored.releasesPageUrl ?? "",
      // Factory defaults, so the UI can explain where a value comes from.
      defaultUpdateServerUrl: normalizeBaseUrl(shipped.updateServerUrl) ?? "",
      defaultReleasesPageUrl: normalizeBaseUrl(shipped.releasesPageUrl) ?? "",
    };
  };

  ipcMain.handle("netcatty:update:getUpdateSource", () => describeUpdateSource());

  ipcMain.handle("netcatty:update:setUpdateSource", (_event, payload) => {
    const validation = validateUpdateSourceInput(payload);
    if (!validation.ok) {
      return { success: false, error: validation.error };
    }
    if (!writeStoredSelfHostedConfig({
      updateServerUrl: validation.updateServerUrl,
      releasesPageUrl: validation.releasesPageUrl,
    })) {
      return { success: false, error: "writeFailed" };
    }

    // Apply immediately: a new URL switches the feed without a restart, a
    // cleared URL makes every entry point inert through the source gates.
    applySelfHostedFeedChange();
    const described = describeUpdateSource();
    broadcastToAllWindows("netcatty:update:source-changed", described);
    console.log("[AutoUpdate] Update source saved:", described.source);
    return { success: true, ...described };
  });

  console.log("[AutoUpdate] Handlers registered");
}

module.exports = {
  // exported for tests: the retry wrapper and its error summariser
  checkForUpdatesWithRetry,
  describeUpdateError,
  init,
  registerHandlers,
  isAutoUpdateSupported,
  isUpdateSourceConfigured,
  readSelfHostedUpdateUrl,
  resolveUpdateSource,
  validateUpdateSourceInput,
  readStoredSelfHostedConfig,
  writeStoredSelfHostedConfig,
  startAutoCheck,
  cancelPendingInstall,
};
