import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const vaultViewLayoutSource = readFileSync(new URL("./vault/VaultViewLayout.tsx", import.meta.url), "utf8");
const pluginImporterCommitHookSource = readFileSync(new URL("../application/state/usePluginImporterCommit.ts", import.meta.url), "utf8");
const topTabsSource = readFileSync(new URL("./TopTabs.tsx", import.meta.url), "utf8");

test("file transfer and workflows entries live in the vault sidebar, not the top tab bar", () => {
  assert.doesNotMatch(topTabsSource, /tabId="sftp"/);
  assert.doesNotMatch(topTabsSource, /tabId="workflows"/);
  assert.match(topTabsSource, /tabId="vault"/);

  // Both entries stay root-view switches, so they reuse the existing root tab ids.
  assert.match(vaultViewLayoutSource, /activeTabStore\.setActiveTabId\("sftp"\)/);
  assert.match(vaultViewLayoutSource, /activeTabStore\.setActiveTabId\("workflows"\)/);
  // Same collapsed-sidebar rule as the other nav items: hidden label, tooltip only.
  assert.match(vaultViewLayoutSource, /\{!sidebarCollapsed && t\("terminal\.layer\.sftp"\)\}/);
  assert.match(vaultViewLayoutSource, /\{!sidebarCollapsed && t\("workflow\.title"\)\}/);
  assert.match(vaultViewLayoutSource, /<Folder size=\{16\} className="flex-shrink-0" \/>/);
  assert.match(vaultViewLayoutSource, /<Workflow size=\{16\} className="flex-shrink-0" \/>/);

  // Order: right under "Hosts", before Monitor.
  const hostsIndex = vaultViewLayoutSource.indexOf('t("vault.nav.hosts")');
  const sftpIndex = vaultViewLayoutSource.indexOf('activeTabStore.setActiveTabId("sftp")');
  const workflowIndex = vaultViewLayoutSource.indexOf('activeTabStore.setActiveTabId("workflows")');
  const monitorIndex = vaultViewLayoutSource.indexOf("<MonitorNavButton");
  assert.ok(hostsIndex > 0 && hostsIndex < sftpIndex, "SFTP entry follows the hosts nav item");
  assert.ok(sftpIndex < workflowIndex, "workflows entry follows the file transfer entry");
  assert.ok(workflowIndex < monitorIndex, "both entries sit above Monitor");
});

test("vault stage aligns its content to the top tab bar", () => {
  assert.match(vaultViewLayoutSource, /className="flex min-w-0 flex-1 py-0 pr-2 pb-2 pl-0"/);
  assert.doesNotMatch(vaultViewLayoutSource, /className="flex min-w-0 flex-1 p-2 pl-0"/);
});

test("vault notes stay mounted while switching sections", () => {
  assert.match(vaultViewLayoutSource, /data-section="vault-notes-retained"/);
  assert.match(vaultViewLayoutSource, /currentSection !== "notes" && "hidden"/);
  assert.doesNotMatch(vaultViewLayoutSource, /currentSection === "notes" && \(\s*<NotesManager/);
});

test("vault header collapsed actions cannot retain hidden focus", () => {
  assert.match(vaultViewLayoutSource, /newHostActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /sessionActionsRef\.current\?\.contains\(activeElement\)/);
  assert.match(vaultViewLayoutSource, /activeElement\.blur\(\)/);
  // Both the SSH/new-host panel and the local-shell host panel collapse the
  // header actions so hidden buttons cannot retain focus.
  assert.match(vaultViewLayoutSource, /aria-hidden=\{isHostAsideOpen \? true : undefined\}/);
  assert.match(vaultViewLayoutSource, /inert=\{isHostAsideOpen \? true : undefined\}/);
});

test("vault sidebar toggle keeps an accessible action label", () => {
  assert.match(
    vaultViewLayoutSource,
    /aria-label=\{sidebarCollapsed \? t\("vault\.sidebar\.expand"\) : t\("vault\.sidebar\.collapse"\)\}/,
  );
});

test("keychain deletion clears the remembered passphrase through the vault handler", () => {
  assert.match(vaultViewLayoutSource, /const handleDeleteVaultKey = React\.useCallback/);
  assert.match(vaultViewLayoutSource, /void deleteVaultKey\(\{/);
  assert.match(vaultViewLayoutSource, /onDelete=\{handleDeleteVaultKey\}/);
});

test("plugin importer merge and commit workflow is owned by application state", () => {
  assert.match(vaultViewLayoutSource, /usePluginImporterCommit\(\{/);
  assert.doesNotMatch(vaultViewLayoutSource, /normalizePluginImporterRecords|mergePluginImporterDrafts|buildPluginImporterSafePreview/);
  assert.match(pluginImporterCommitHookSource, /normalizePluginImporterRecords/);
  assert.match(pluginImporterCommitHookSource, /mergePluginImporterDrafts/);
  assert.match(pluginImporterCommitHookSource, /buildPluginImporterSafePreview/);
});

test("Vault import entry is disabled while an import is running", () => {
  assert.match(vaultViewLayoutSource, /disabled=\{importProgress\?\.status === "running"\}/);
  assert.match(vaultViewLayoutSource, /if \(importProgress\?\.status === "running"\) return;/);
});
