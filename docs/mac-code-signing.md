# macOS code signing (fixed self-signed identity)

Status: **implemented** — `.github/workflows/build.yml` trusts a self-signed
certificate before packaging, names the identity via `CSC_NAME`, and fails the
macOS leg when a configured certificate did not end up on the app.

## Why the macOS build must be signed at all

`electron-updater` installs macOS updates through Squirrel.Mac. Before it hands
an update to ShipIt it verifies the downloaded bundle against the **designated
requirement (DR) of the running application**.

- Certificate-signed app → `designated => identifier "…" and anchor apple generic …`
  (or, for a self-signed chain, `identifier "…" and certificate root = H"…"`).
  This requirement is a property of the *identity*, so the next build satisfies it.
- Ad-hoc signed app (`identity: null`, no `CSC_LINK`) → the DR is
  `cdhash H"…"` — a hash of that one binary. A new build always has a different
  cdhash, so **the update can never satisfy it**. Squirrel fails the check before
  it even writes `ShipItState.plist`, the renderer shows the generic
  "更新失败 / 下载更新失败" toast (the download itself was fine), and the app
  never restarts into the new version. No version, retry, network or volume
  change can fix this.

Diagnosing the same symptom later:

```sh
ls -la ~/Library/Caches/com.netcatty.app.ShipIt/     # empty = died in Squirrel's check
codesign -d -r- /path/to/installed/Netcatty.app      # `# designated => cdhash H"…"` = ad-hoc
codesign -d -r- /path/to/new/Netcatty.app
codesign -v -R='<installed DR>' /path/to/new/Netcatty.app   # exit 3 = this bug
```

## The chosen fix: one fixed self-signed certificate

There is no Apple Developer ID for this fork, so every macOS build is signed with
**one self-signed certificate that never changes**. Its DR is
`identifier "com.netcatty.app" and certificate root = H"<cert hash>"` — stable
across builds — which Squirrel.Mac accepts. `scripts/mac-selfsigned-cert.sh`
implements the whole flow.

| Step | Command | Where |
| --- | --- | --- |
| Create the identity once | `scripts/mac-selfsigned-cert.sh create` | a dev Mac |
| Store it as secrets | `MAC_CSC_LINK` (base64 p12), `MAC_CSC_KEY_PASSWORD` | GitHub repo secrets |
| Trust it before packaging | `scripts/mac-selfsigned-cert.sh trust` | the macOS CI leg / dev Mac |
| Name the identity | `CSC_NAME=Netcatty Self-Signed` | the "Build package" step |
| Check the result | `scripts/mac-selfsigned-cert.sh verify-release` | after packaging |

`create` writes `netcatty-selfsigned.{key,crt,p12}` to `~/.netcatty/mac-signing`
(never inside a git work tree — the script refuses) and prints the two secrets.

Two details that are easy to get wrong:

- **The certificate must be trusted.** electron-builder resolves the signing
  identity through `security find-identity -v`, which only reports *trusted*
  certificates. An imported-but-untrusted self-signed certificate yields
  "0 valid identities found" and the build silently stays unsigned. The `trust`
  subcommand sets the trust setting in the user domain (the setting is per
  certificate, so it also covers the throwaway keychain electron-builder creates
  for each build); it falls back to the admin domain via `sudo` when needed.
- **The identity must be named.** With `CSC_IDENTITY_AUTO_DISCOVERY=false` (set
  since the fork has no Apple identity to discover) and an unnamed `CSC_LINK`,
  electron-builder's `findIdentity()` returns `null` and skips signing entirely.
  `CSC_NAME` is what makes it look the certificate up by name.

## Bootstrapping an already-installed app

An installed app is validated by *its own* DR, so a machine currently running an
ad-hoc build cannot auto-update to the first signed build (the ad-hoc DR is that
old cdhash). Install the first signed release by hand once per machine —
download the dmg/zip and replace `Netcatty.app` — and every later release
updates in-app again. In-app updates also clear the quarantine attribute
(ShipIt does that itself), so no Gatekeeper step is needed after that.

First launch of a downloaded (quarantined) archive still needs the usual
right-click → Open, exactly as with today's ad-hoc builds. A self-signed chain
is not notarized, so this does not change Gatekeeper behaviour.

## Which machine needs what

| Machine | Certificate imported | Trust setting | Why |
| --- | --- | --- | --- |
| Build machine (dev Mac / CI runner) | yes (from `CSC_LINK`) | yes (`trust`) | only so electron-builder's `security find-identity -v` can *see* the identity |
| Any user's Mac | no | no | nothing — the update check does not evaluate trust |

Squirrel.Mac matches the update against the running app's designated requirement
with `SecStaticCodeCheckValidity`, which resolves the requirement **structurally**
(`identifier` + `certificate root` hash) and never evaluates certificate trust.
That is a different API from the trust evaluation Gatekeeper uses
(`SecTrustEvaluate` / `security verify-cert`, which returns
`CSSMERR_TP_NOT_TRUSTED` for a self-signed chain and is why an untrusted
download still needs right-click → Open the first time).

Verified on a Mac with the certificate present in **no** keychain and no trust
settings at all (`security find-certificate -c "Netcatty Self-Signed"` empty,
`find-identity -v` → 0 valid identities): two different builds produced the same
DR, and `codesign -v -R='identifier "com.netcatty.app" and certificate root = H"…"' <other build>`
returned 0. So nothing has to be installed on a user machine for in-app updates
to validate.

### Smoke-testing a second Mac

Copy any two signed builds (`release/mac-arm64/Netcatty.app` of two releases, or
one of them plus the installed app) to that Mac and run:

```sh
scripts/mac-selfsigned-cert.sh verify <App.app>            # cert-signed, not ad-hoc
codesign -d -r- <App.app>                                  # identifier + certificate root
codesign -v -R='<the installed app DR>' <the new app>      # 0 = Squirrel will accept it
```

No certificate, profile or setting is required on that machine for these to
pass. The real acceptance test is still the in-app one: install the first signed
release by hand, then let the app update itself to the next release and confirm
the version changed.

Two stages are not re-verified by the checks above, because they run inside
ShipIt during an actual install: the bundle swap itself (identical to what every
other Electron app on that machine already does) and, for installs outside
`/Applications`, the cross-volume move (~/Library/Caches → the app's volume).

## Rules

- **Never rotate the certificate.** A new certificate changes the DR and
  re-breaks auto-update for every installed client. `create` refuses to
  overwrite an existing p12 unless `--force` is passed.
- **Keep the p12 backed up** (password manager / private storage) and never
  commit it. Losing it is like rotating it: the next build needs a new identity,
  and clients need one more manual install.
- The certificate is valid for 10 years by default (`--days`); re-creating it
  after expiry is the same rotation caveat.
- macOS-only. Windows (NSIS) and Linux (AppImage/deb) do not go through
  Squirrel's requirement check.
- **Sign local builds too.** A build handed to a machine without the `CSC_*`
  variables is ad-hoc again, so that machine's next in-app update fails and it
  needs another manual install. On a dev Mac run
  `scripts/mac-selfsigned-cert.sh trust <p12> <password>` once and export
  `CSC_LINK=file://<p12>` / `CSC_KEY_PASSWORD` / `CSC_NAME=Netcatty Self-Signed`
  before `npm run pack:mac`.

## Acceptance test

Signing is not the goal — *Squirrel accepting the update* is. After a signed
release is published:

```sh
scripts/mac-selfsigned-cert.sh verify /Applications/Netcatty.app   # cert-signed, not ad-hoc
codesign -d -r- /Applications/Netcatty.app                         # identifier + certificate root
```

Then let the in-app updater install the next release, and confirm the version
actually changed. A missing `~/Library/Caches/com.netcatty.app.ShipIt/ShipItState.plist`
plus an unchanged version means the DR check failed again.

## Turning it off

Delete the `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` secrets. `CSC_LINK` becomes
empty, the trust step and the signature check both skip themselves, and the
macOS build goes back to ad-hoc signing (and back to broken in-app updates).
