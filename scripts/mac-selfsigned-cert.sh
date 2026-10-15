#!/usr/bin/env bash
#
# Fixed self-signed macOS code-signing identity (create / trust / verify).
#
# Why this exists
# ---------------
# A macOS build without a Developer ID certificate is only ad-hoc signed. The
# designated requirement (DR) of an ad-hoc signature is `cdhash H"..."` — a hash
# of that exact binary. Squirrel.Mac, which installs electron-updater's macOS
# updates, validates a downloaded update against the DR of the *running* app, so
# the update can never satisfy it: every in-app update on macOS fails before
# ShipIt is even launched ("更新失败"), no matter the version. See
# docs/mac-code-signing.md.
#
# Signing every build with ONE fixed certificate replaces that DR with
# `identifier "..." and certificate root = H"..."`, which is stable across
# builds: the next build satisfies the installed app's requirement and in-app
# updates work. No Apple account is needed.
#
# Usage
# -----
#   mac-selfsigned-cert.sh create [--out-dir DIR] [--cn NAME] [--days N]
#                                 [--password PASS] [--force]
#   mac-selfsigned-cert.sh trust  [P12] [PASSWORD] [--keychain PATH]
#   mac-selfsigned-cert.sh verify <App.app> [App.app...]
#   mac-selfsigned-cert.sh verify-release        # CI: checks release/mac*/Netcatty.app
#
# `create` writes the private key, certificate and p12 into --out-dir (default
# ~/.netcatty/mac-signing, never inside a git work tree) and prints the two
# GitHub secrets plus the trust command.
#
# IMPORTANT: keep the generated p12 backed up and NEVER rotate it. A new
# certificate changes the DR, so every already-installed client stops being able
# to auto-update (they would need another manual install).
set -euo pipefail

CN_DEFAULT="Netcatty Self-Signed"
OUT_DIR_DEFAULT="${HOME}/.netcatty/mac-signing"
DAYS_DEFAULT=3650

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

need_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "$1 only works on macOS"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# ---------------------------------------------------------------- create -----

openssl_major_version() {
  openssl version | sed -n 's/^OpenSSL \([0-9][0-9]*\).*/\1/p'
}

write_cert_config() {
  # A config file (rather than -addext) is what keeps this working on the
  # LibreSSL that ships with macOS as well as Homebrew's OpenSSL 3.
  cat > "$1" <<EOF
[req]
distinguished_name = dn
prompt             = no
x509_extensions    = v3_codesign

[dn]
CN = ${CN}
O  = Netcatty
C  = CN

[v3_codesign]
basicConstraints     = critical, CA:FALSE
keyUsage             = critical, digitalSignature
extendedKeyUsage     = critical, codeSigning
subjectKeyIdentifier = hash
EOF
}

export_p12() {
  # macOS's `security import` is happiest with the legacy PKCS#12 algorithms.
  # LibreSSL already defaults to them; OpenSSL 3 needs -legacy (or explicit
  # 3DES/SHA1 parameters when the legacy provider is unavailable).
  if [[ "$(openssl_major_version)" == "3" ]]; then
    if openssl pkcs12 -export -legacy -out "$2" -inkey "$1" -in "$3" \
      -passout "pass:${PASSWORD}" -name "${CN}" 2>/dev/null; then
      return 0
    fi
    openssl pkcs12 -export -out "$2" -inkey "$1" -in "$3" \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
      -passout "pass:${PASSWORD}" -name "${CN}"
    return 0
  fi
  openssl pkcs12 -export -out "$2" -inkey "$1" -in "$3" \
    -passout "pass:${PASSWORD}" -name "${CN}"
}

cmd_create() {
  require_cmd openssl

  local out_dir="$OUT_DIR_DEFAULT"
  local password=""
  local force=0
  CN="$CN_DEFAULT"
  DAYS="$DAYS_DEFAULT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out-dir) out_dir="${2:-}"; shift 2 ;;
      --cn) CN="${2:-}"; shift 2 ;;
      --days) DAYS="${2:-}"; shift 2 ;;
      --password) password="${2:-}"; shift 2 ;;
      --force) force=1; shift ;;
      *) die "unknown option for create: $1" ;;
    esac
  done

  [[ -n "$out_dir" ]] || die "--out-dir needs a value"
  [[ "$DAYS" =~ ^[0-9]+$ ]] || die "--days needs a number"
  mkdir -p "$out_dir"
  out_dir="$(cd "$out_dir" && pwd)"

  # A signing key must never be committed: refuse to write into a work tree.
  if git -C "$out_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
    die "$out_dir is inside a git work tree; pick a location outside the repository"
  fi

  local key_file="$out_dir/netcatty-selfsigned.key"
  local cert_file="$out_dir/netcatty-selfsigned.crt"
  local p12_file="$out_dir/netcatty-selfsigned.p12"
  if [[ -e "$p12_file" && "$force" != "1" ]]; then
    die "$p12_file already exists — reusing the existing certificate is required for updates to keep working (pass --force only if you really mean to replace it)"
  fi

  PASSWORD="${password:-$(openssl rand -hex 24)}"
  local config_file="$out_dir/openssl-codesign.cnf"
  write_cert_config "$config_file"

  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$DAYS" \
    -config "$config_file" -keyout "$key_file" -out "$cert_file" >/dev/null 2>&1
  export_p12 "$key_file" "$p12_file" "$cert_file"
  chmod 600 "$key_file" "$p12_file" 2>/dev/null || true

  local base64_p12 fingerprint
  base64_p12="$(openssl base64 -A -in "$p12_file")"
  fingerprint="$(openssl x509 -in "$cert_file" -noout -fingerprint -sha1 | sed 's/.*=//')"

  info ""
  info "Self-signed macOS signing identity created."
  info ""
  info "  common name (must never change) : ${CN}"
  info "  certificate                     : ${cert_file}"
  info "  private key                     : ${key_file}"
  info "  pkcs#12 bundle                  : ${p12_file}"
  info "  sha1 fingerprint                : ${fingerprint}"
  info "  valid until                     : $(openssl x509 -in "$cert_file" -noout -enddate | sed 's/.*=//')"
  info ""
  info "Keep ${p12_file} backed up. It must NOT be rotated: a new certificate"
  info "changes the app's designated requirement and breaks auto-update for every"
  info "installed client."
  info ""
  info "GitHub repository secrets:"
  info "  MAC_CSC_LINK         = ${base64_p12}"
  info "  MAC_CSC_KEY_PASSWORD = ${PASSWORD}"
  info ""
  info "Local builds: run the trust step once on the build machine, then export"
  info "the same three variables before npm run pack:mac:"
  info "  scripts/mac-selfsigned-cert.sh trust ${p12_file} '${PASSWORD}'"
  info "  export CSC_LINK=\"${p12_file}\""
  info "  export CSC_KEY_PASSWORD='${PASSWORD}'"
  info "  export CSC_NAME=\"${CN}\""
}

# ----------------------------------------------------------------- trust -----

# Turn a CSC_LINK-shaped value (path, file:// URL, http(s) URL or base64 blob)
# into a local p12 path.
resolve_p12() {
  local link="$1" dest="$2"
  if [[ -f "$link" ]]; then
    printf '%s' "$link"
    return 0
  fi
  case "$link" in
    file://*)
      local path="${link#file://}"
      [[ -f "$path" ]] || die "file:// link does not exist: $path"
      printf '%s' "$path"
      return 0
      ;;
    http://*|https://*)
      curl -fsSL "$link" -o "$dest" || die "cannot download CSC_LINK: $link"
      printf '%s' "$dest"
      return 0
      ;;
  esac
  if printf '%s' "$link" | tr -d '\n' | grep -Eq '^[A-Za-z0-9+/]+=*$'; then
    printf '%s' "$link" | base64 --decode > "$dest" 2>/dev/null \
      || printf '%s' "$link" | base64 -D > "$dest" 2>/dev/null \
      || die "CSC_LINK does not look like base64 p12 data"
    printf '%s' "$dest"
    return 0
  fi
  die "cannot interpret CSC_LINK (expected a path, file:// URL, http(s) URL or base64)"
}

cmd_trust() {
  need_macos trust
  require_cmd openssl

  local p12="" password="" keychain="" positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keychain) keychain="${2:-}"; shift 2 ;;
      -*) die "unknown option for trust: $1" ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  p12="${positional[0]:-}"
  password="${positional[1]:-}"

  if [[ -z "$p12" ]]; then
    p12="${CSC_LINK:-}"
    password="${password:-${CSC_KEY_PASSWORD:-}}"
    if [[ -z "$p12" ]]; then
      info "no CSC_LINK configured — skipping certificate trust (the build stays unsigned)"
      return 0
    fi
  fi
  [[ -n "$password" ]] || die "p12 password is required (second argument or CSC_KEY_PASSWORD)"

  local work_dir
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/netcatty-trust.XXXXXX")"
  local local_p12
  local_p12="$(resolve_p12 "$p12" "$work_dir/link.p12")"
  local cert_pem="$work_dir/cert.pem"
  openssl pkcs12 -in "$local_p12" -clcerts -nokeys -passin "pass:${password}" \
    -out "$cert_pem" >/dev/null 2>&1 || die "cannot read the p12 (wrong password?)"

  local cn_hash
  cn_hash="$(openssl x509 -in "$cert_pem" -noout -subject_hash)"
  [[ -n "$keychain" ]] || keychain="$work_dir/signing.keychain-db"

  if ! security list-keychains -d user | grep -q "$keychain"; then
    security create-keychain -p netcatty "$keychain" >/dev/null
  fi
  security unlock-keychain -p netcatty "$keychain" >/dev/null
  # Importing the p12 (private key included) is what makes the identity show up
  # as a codesigning identity — exactly what electron-builder looks for in its
  # own throwaway keychain.
  security import "$local_p12" -k "$keychain" -P "$password" \
    -T /usr/bin/codesign -T /usr/bin/productbuild >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k netcatty "$keychain" >/dev/null

  # electron-builder resolves the signing identity through
  # `security find-identity -v`, which only reports *trusted* certificates.
  # The trust setting is per certificate, not per keychain, so setting it here
  # also covers the keychain electron-builder creates for the build.
  if ! security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$cert_pem" 2>/dev/null; then
    if sudo -n true 2>/dev/null; then
      security add-trusted-cert -d -r trustRoot -p codeSign \
        -k /Library/Keychains/System.keychain "$cert_pem" \
        || die "could not set the certificate trust setting"
    else
      die "could not set the certificate trust setting (tried the user domain; no passwordless sudo for the admin domain)"
    fi
  fi

  local identities
  identities="$(security find-identity -v -p codesigning "$keychain")"
  info "$identities"
  if ! printf '%s' "$identities" | grep -qE '[0-9]+\) '; then
    die "the certificate is imported but still not a valid codesigning identity"
  fi
  info "certificate trusted (sha1 subject hash ${cn_hash}); electron-builder will find it"
}

# ---------------------------------------------------------------- verify -----

verify_one() {
  local app="$1"
  [[ -d "$app" ]] || die "not an app bundle: $app"
  local details dr
  if ! details="$(codesign -d --verbose=2 "$app" 2>&1)"; then
    printf 'FAIL %s: not code signed\n' "$app" >&2
    return 1
  fi
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^\(# \)\{0,1\}designated => //p')"
  printf '%s\n' "--- $app"
  # FreeBSD/macOS sed has no \| alternation: use grep -E for the field filter.
  printf '%s\n' "$details" | grep -E '^(Authority|Signature|Identifier|TeamIdentifier|flags)=' | sed 's/^/    /' || true
  printf '    designated requirement: %s\n' "$dr"
  if printf '%s' "$details" | grep -q 'Signature=adhoc'; then
    printf 'FAIL %s: ad-hoc signed — in-app updates on macOS cannot work\n' "$app" >&2
    return 1
  fi
  if ! codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    printf 'FAIL %s: signature does not verify (codesign --verify --deep --strict)\n' "$app" >&2
    return 1
  fi
  printf '%s\n' "    OK: certificate-signed and verified"
  return 0
}

cmd_verify() {
  need_macos verify
  [[ $# -gt 0 ]] || die "verify needs at least one .app path"
  local status=0
  local app
  for app in "$@"; do
    verify_one "$app" || status=1
  done
  return "$status"
}

cmd_verify_release() {
  need_macos verify-release
  if [[ -z "${CSC_LINK:-}" ]]; then
    info "no CSC_LINK configured — macOS builds are unsigned, skipping the signature check"
    return 0
  fi
  local apps=()
  local candidate
  for candidate in release/mac*/Netcatty.app; do
    [[ -d "$candidate" ]] && apps+=("$candidate")
  done
  [[ ${#apps[@]} -gt 0 ]] || die "no release/mac*/Netcatty.app found to verify"
  cmd_verify "${apps[@]}"
}

# ------------------------------------------------------------------ main -----

main() {
  local command="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$command" in
    create) cmd_create "$@" ;;
    trust) cmd_trust "$@" ;;
    verify) cmd_verify "$@" ;;
    verify-release) cmd_verify_release "$@" ;;
    ""|-h|--help|help)
      sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
      ;;
    *)
      die "unknown command: $command (expected create, trust, verify or verify-release)"
      ;;
  esac
}

main "$@"
