"use strict";

/**
 * Chromium only auto-selects gnome-libsecret/kwallet for the desktops it knows
 * (GNOME, Unity, Cinnamon, KDE, ...). On anything else — Hyprland, sway, a bare
 * wlroots session — it silently settles for the plaintext "basic" backend, so
 * Electron's safeStorage reports encryption as unavailable and the app can never
 * save or read credentials: every start shows "凭据保护不可用" and connections ask
 * for the password again.
 *
 * When a running gnome-keyring is visible (`$XDG_RUNTIME_DIR/keyring`, created by
 * gnome-keyring-daemon) point Chromium at it explicitly. An explicit
 * `--password-store` on the command line always wins, and desktops Chromium
 * already handles are left untouched.
 */

const fs = require("node:fs");
const path = require("node:path");

const LIBSECRET_DESKTOPS = ["gnome", "unity", "cinnamon", "mate", "budgie", "pantheon"];
const KWALLET_DESKTOPS = ["kde", "plasma", "lxqt"];

function hasGnomeKeyringRuntimeDir(env = process.env) {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return false;
  try {
    return fs.existsSync(path.join(runtimeDir, "keyring"));
  } catch {
    return false;
  }
}

function resolveLinuxPasswordStoreSwitch(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;

  const argv = options.argv ?? process.argv;
  if (argv.some((arg) => String(arg).startsWith("--password-store"))) return null;

  const desktop = String(options.desktop ?? process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  if (KWALLET_DESKTOPS.some((entry) => desktop.includes(entry))) return null;
  if (LIBSECRET_DESKTOPS.some((entry) => desktop.includes(entry))) return null;

  const keyringVisible = options.keyringVisible ?? hasGnomeKeyringRuntimeDir();
  return keyringVisible ? "gnome-libsecret" : null;
}

module.exports = { resolveLinuxPasswordStoreSwitch, hasGnomeKeyringRuntimeDir };
