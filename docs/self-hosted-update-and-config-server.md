# Self-hosted update & config server (reserved)

Status: **reserved, not configured.** Nothing in the app contacts a cloud update
source any more; the endpoints below are placeholders to fill in once the server
exists.

## What is already in place

| Concern | Where | Today |
| --- | --- | --- |
| Update feed base URL | Settings > System > Software Update (persisted in `<userData>/self-hosted-update.json`) | unset |
| Launch-time override | `NETCATTY_UPDATE_SERVER_URL` env var (wins over the saved value) | unset |
| Factory defaults | `infrastructure/config/selfHostedEndpoints.json` → `updateServerUrl` / `releasesPageUrl` | `null` |
| Human download page | same field pair (`releasesPageUrl`) | unset |
| Config / vault storage | Cloud Sync built-in providers (`webdav`, `s3`) | user-entered, no code change needed |

Resolution order for the feed URL: `NETCATTY_UPDATE_SERVER_URL` → the value saved
in Settings → the factory defaults. Saving in Settings takes effect immediately
(the feed is swapped on the running updater and every window is notified); an env
override pins the inputs and is reported in the UI.

While `updateServerUrl` is `null` (and the env override is unset):

- the main process never resolves an update feed — `startAutoCheck` returns early,
  `netcatty:update:check` answers `supported: false`, `netcatty:update:download`
  refuses;
- the renderer skips its release-metadata check without any network request;
- Settings → System → Software Update shows "not configured" instead of claiming
  the app is up to date, and no download-page link is offered.

The packaged `app-update.yml` (which still points at the cloud release provider so
CI can publish artifacts) is deliberately overridden at runtime, never used as a
fallback.

## What the update server has to serve

`updateServerUrl` is consumed as an electron-updater **generic** provider base:

```
<updateServerUrl>/latest.yml                 # Windows NSIS/portable
<updateServerUrl>/latest-mac.yml             # macOS zip/dmg
<updateServerUrl>/latest-linux.yml           # Linux x64 (AppImage/deb/rpm/pacman)
<updateServerUrl>/latest-linux-<arch>.yml    # other Linux architectures
<updateServerUrl>/<artifact files>           # the packages named inside those manifests
<updateServerUrl>/latest.json                # release metadata for the in-app banner
```

`latest.json` keeps the shape of GitHub's `releases/latest` response, so the
renderer parsing stays unchanged:

```json
{
  "tag_name": "v1.2.3",
  "name": "Netcatty v1.2.3",
  "body": "release notes (markdown)",
  "html_url": "https://updates.example/netcatty/",
  "published_at": "2026-01-01T00:00:00Z",
  "assets": [
    { "name": "Netcatty-1.2.3-linux-x86_64.AppImage", "browser_download_url": "https://updates.example/netcatty/Netcatty-1.2.3-linux-x86_64.AppImage", "size": 0 }
  ]
}
```

The manifests themselves are produced by the packaging step; the feed only has to
serve them over plain HTTP(S) (a static file server is enough).

## How to enable it later

1. Build with `electron-builder` and copy the generated `latest*.yml` files plus
   the artifacts into the server directory.
2. Open Settings > System > Software Update > Self-hosted Update Server, fill in
   the feed URL (and optionally the download page) and press Save — or launch the
   app with `NETCATTY_UPDATE_SERVER_URL=https://updates.example/netcatty`.
   The saved configuration also serves as the default for the next launch.

## Config / vault storage

No code change is needed for "save my configuration on my own server": Settings →
Sync → Cloud Sync already offers **WebDAV** and **S3** built-in providers, both of
which accept a self-hosted endpoint (`cloudSync.provider.webdav.desc` — "Connect
to a self-hosted WebDAV endpoint"). Point one of them at the server once it is
reachable; the sync payload stays encrypted client-side as it does today.
