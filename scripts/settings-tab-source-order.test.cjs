"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const SYSTEM_TAB_SOURCE = path.join(__dirname, "..", "components", "settings", "tabs", "SettingsSystemTab.tsx");

test("settings system tab resolves i18n before handlers that depend on it", () => {
  const source = readFileSync(SYSTEM_TAB_SOURCE, "utf8");

  // `useI18n()` must run before any useCallback that lists `t` in its
  // dependency array: the dependency array is evaluated during render, so a
  // handler declared above the hook throws
  // "Cannot access '<t>' before initialization" and the whole lazy settings tab
  // fails to load with "This settings tab could not load".
  const i18nAt = source.indexOf("const { t } = useI18n();");
  assert.notEqual(i18nAt, -1, "the tab must use the i18n hook");

  // First dependency array that pulls in the translation function.
  const firstTDependency = source.indexOf(", t]");
  assert.notEqual(firstTDependency, -1, "the update-source handler must stay wired to i18n");
  assert.ok(
    i18nAt < firstTDependency,
    "declare `const { t } = useI18n()` before the handlers that use `t`",
  );
});
