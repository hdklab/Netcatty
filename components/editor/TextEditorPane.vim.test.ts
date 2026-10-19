import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const paneSource = readFileSync(new URL("./TextEditorPane.tsx", import.meta.url), "utf8");
const modalSource = readFileSync(new URL("../TextEditorModal.tsx", import.meta.url), "utf8");

test("Vim mode is a persisted global preference with a toolbar toggle", () => {
  assert.match(paneSource, /useStoredBoolean\(STORAGE_KEY_EDITOR_VIM_MODE, false\)/);
  assert.match(paneSource, /data-editor-vim-toggle=\{vimMode \? 'on' : 'off'\}/);
  assert.match(paneSource, /onClick=\{\(\) => setVimMode\(!vimMode\)\}/);
});

test("Vim bindings load lazily and are disposed on unmount or toggle-off", () => {
  assert.match(paneSource, /import\('\.\.\/\.\.\/infrastructure\/monaco\/monacoVim'\)/);
  assert.match(paneSource, /api\.initVimMode\(editor, vimStatusRef\.current\)/);
  assert.match(paneSource, /adapter\?\.dispose\(\)/);
  // Attach only once Monaco mounted the live editor instance.
  assert.match(paneSource, /canAttachVimMode\(\{ enabled: vimMode, editorMounted \}\)/);
});

test("Vim's :w saves the focused editor", () => {
  assert.match(paneSource, /setSaveHandler = mod\.setActiveVimSaveHandler/);
  assert.match(paneSource, /editor\.onDidFocusEditorText\(\(\) => setSaveHandler\?\.\(saveCurrentFile\)\)/);
  assert.match(paneSource, /setSaveHandler\?\.\(null\)/);
});

test("monaco-vim gets a status-bar host only while Vim mode is on", () => {
  assert.match(paneSource, /\{vimMode && \(/);
  assert.match(paneSource, /data-editor-vim-status="true"/);
});

test("Escape stays inside the editor instead of closing the file", () => {
  assert.match(modalSource, /onEscapeKeyDown=\{\(event\) => event\.preventDefault\(\)\}/);
});
