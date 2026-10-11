/**
 * Reserved self-hosted update/config endpoints (main process view).
 *
 * Single source of truth: selfHostedEndpoints.json. This .cjs wrapper exists
 * because electron-builder ships explicit commonjs modules into app.asar while
 * the renderer imports the JSON directly through Vite.
 *
 * `updateServerUrl` is the electron-updater "generic" feed base (it must serve
 * latest.yml / latest-linux.yml / latest-mac.yml and the artifacts, plus a
 * latest.json release metadata file). It defaults to this fork's own GitHub
 * release assets (https://github.com/hdklab/Netcatty/releases/latest/download);
 * clearing it in Settings disables updates entirely — there is no cloud
 * fallback. See docs/self-hosted-update-and-config-server.md.
 */
module.exports = require("./selfHostedEndpoints.json");
