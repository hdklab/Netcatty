/**
 * Build-time helpers for the Vim bindings of the built-in text editor.
 *
 * `monaco-vim` ships only as ESM (which would bundle a *second* Monaco, because
 * it imports `monaco-editor/esm/vs/editor/editor.api` while this app loads
 * Monaco through an AMD loader) and as a UMD bundle. The UMD bundle's branches
 * are:
 *   1. CommonJS            → `require('monaco-editor/esm/...')`
 *   2. AMD (`define.amd`)  → `define(['monaco-editor/esm/...'], factory)`
 *   3. otherwise           → `globalThis.MonacoVim` bound to `globalThis.monaco`
 *
 * Monaco's AMD loader installs `define`, so branch 2 always wins when the file
 * is dropped on the page. `wrapMonacoVimUmd` wraps the bundle in an IIFE whose
 * parameters shadow `define` / `module` / `exports` / `require`, which forces
 * branch 3 — the live `window.monaco` instance — without `eval` (the renderer's
 * CSP forbids it) and without shipping a duplicated Monaco.
 */
export const MONACO_VIM_UMD_MODULE_ID = 'virtual:monaco-vim-umd';

export interface MonacoVimAdapter {
  dispose(): void;
}

export interface MonacoVimExApi {
  /** monaco-vim's Ex command registry (`VimMode.Vim.defineEx`). */
  defineEx?(name: string, prefix: string, handler: () => void): void;
}

export interface MonacoVimApi {
  initVimMode(
    editor: import('monaco-editor').editor.IStandaloneCodeEditor,
    statusNode: HTMLElement | null,
  ): MonacoVimAdapter;
  VimMode?: { Vim?: MonacoVimExApi };
}

export const wrapMonacoVimUmd = (source: string): string => `/* monaco-vim UMD, bound to the live window.monaco */
(function (define, module, exports, require) {
${source}
})(undefined, undefined, undefined, undefined);
export default globalThis.MonacoVim;
`;
