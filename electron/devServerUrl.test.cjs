"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeDevServerUrl } = require("./devServerUrl.cjs");

/**
 * Chromium loads the dev renderer from `localhost` even when VITE_DEV_SERVER_URL
 * points at a loopback literal, so every origin comparison downstream (window
 * navigation allowlist, plugin bridge trusted sender) has to see the same value.
 */
test("loopback dev server hosts normalize to localhost", () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "[::1]", "[::]"]) {
    assert.equal(
      normalizeDevServerUrl(`http://${host}:5173`),
      "http://localhost:5173/",
      `${host} must normalize to localhost`,
    );
  }
});

test("localhost and non-loopback dev server hosts are left alone", () => {
  assert.equal(normalizeDevServerUrl("http://localhost:5173"), "http://localhost:5173");
  assert.equal(normalizeDevServerUrl("http://192.168.1.5:5173"), "http://192.168.1.5:5173");
  assert.equal(normalizeDevServerUrl("https://dev.example.test:5173/app"), "https://dev.example.test:5173/app");
});

test("the path and port survive normalization", () => {
  assert.equal(normalizeDevServerUrl("http://127.0.0.1:4173/index.html"), "http://localhost:4173/index.html");
});

test("missing or invalid values pass through unchanged", () => {
  assert.equal(normalizeDevServerUrl(undefined), undefined);
  assert.equal(normalizeDevServerUrl(""), "");
  assert.equal(normalizeDevServerUrl("not a url"), "not a url");
  // Unbracketed IPv6 literals are not valid URLs, so they never reach the
  // loopback comparison and are returned as-is.
  assert.equal(normalizeDevServerUrl("http://::1:5173"), "http://::1:5173");
});
