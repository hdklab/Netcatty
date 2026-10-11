/**
 * Vite dev-server URL normalization, shared by every main-process consumer of
 * VITE_DEV_SERVER_URL.
 *
 * Vite binds to 0.0.0.0/127.0.0.1/::1 by default, but Chromium navigates to
 * the renderer through `localhost`. Normalizing the URL once (in main.cjs) keeps
 * the loaded origin and every origin comparison — window navigation allowlists,
 * the plugin bridge's trusted-sender check — on the same value. Comparing an
 * un-normalized `http://127.0.0.1:5173` against a page served from
 * `http://localhost:5173` rejects the app's own renderer.
 */
function normalizeDevServerUrl(urlString) {
  if (!urlString) return urlString;
  try {
    const u = new URL(urlString);
    const host = u.hostname;
    // Vite often binds to 0.0.0.0; Chromium can't navigate to it. Prefer localhost.
    if (
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "[::]" ||
      host === "::"
    ) {
      u.hostname = "localhost";
      return u.toString();
    }
    return urlString;
  } catch {
    return urlString;
  }
}

module.exports = { normalizeDevServerUrl };
