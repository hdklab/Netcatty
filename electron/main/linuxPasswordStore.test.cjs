"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveLinuxPasswordStoreSwitch } = require("./linuxPasswordStore.cjs");

const base = { platform: "linux", argv: ["netcatty"], keyringVisible: true };

test("picks gnome-libsecret on desktops Chromium does not detect (Hyprland)", () => {
  assert.equal(resolveLinuxPasswordStoreSwitch({ ...base, desktop: "Hyprland" }), "gnome-libsecret");
});

test("leaves desktops Chromium already handles alone", () => {
  for (const desktop of ["GNOME", "ubuntu:GNOME", "X-Cinnamon", "KDE", "plasma"]) {
    assert.equal(resolveLinuxPasswordStoreSwitch({ ...base, desktop }), null, desktop);
  }
});

test("an explicit --password-store always wins", () => {
  assert.equal(
    resolveLinuxPasswordStoreSwitch({ ...base, desktop: "Hyprland", argv: ["netcatty", "--password-store=basic"] }),
    null,
  );
});

test("does nothing without a visible gnome-keyring", () => {
  assert.equal(resolveLinuxPasswordStoreSwitch({ ...base, desktop: "Hyprland", keyringVisible: false }), null);
});

test("does nothing off Linux", () => {
  assert.equal(resolveLinuxPasswordStoreSwitch({ ...base, platform: "darwin", desktop: "Hyprland" }), null);
});
