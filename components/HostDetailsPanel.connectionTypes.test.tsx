import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import { TooltipProvider } from "./ui/tooltip";
import HostDetailsPanel from "./HostDetailsPanel";

const render = (initialData: Record<string, unknown>) => renderToStaticMarkup(
  React.createElement(I18nProvider, { locale: "en" },
    React.createElement(TooltipProvider, null,
      React.createElement(HostDetailsPanel, {
        initialData,
        availableKeys: [], identities: [], proxyProfiles: [], groups: [],
        managedSources: [], allTags: [], allHosts: [],
        terminalThemeId: "default", terminalFontSize: 14,
        onSave: () => {}, onCancel: () => {},
      } as never),
    ),
  ),
);

const base = { id: "h1", label: "sw", hostname: "10.0.0.9", port: 23, username: "admin", tags: [], os: "linux", createdAt: 1 };

test("telnet keeps appearance/terminal behaviour but hides SSH-only blocks", () => {
  const markup = render({ ...base, protocol: "telnet" });
  const has = (needle: string) => markup.includes(needle);

  assert.ok(has("Appearance"), "appearance section must stay");
  assert.ok(has("Terminal Behavior"), "backspace / line timestamps must stay");
  assert.ok(has("Startup Command"), "startup command must stay");
  assert.ok(!has("SSH Algorithms"), "SSH algorithm overrides must be hidden");
  assert.ok(!has("System SSH Agent"), "ssh agent must be hidden");
  assert.ok(!has("Jump Hosts"), "jump hosts must be hidden");
  assert.ok(has("Telnet on"), "telnet credentials must be shown");
});
