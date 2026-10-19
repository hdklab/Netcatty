/**
 * Vim keybindings for the built-in text editor.
 *
 * `monaco-vim` is the Monaco port of CodeMirror's vim bindings (the same
 * implementation VS Code's Vim extension is modelled on). It is bundled from a
 * build-time virtual module (`virtual:monaco-vim-umd`, see
 * `monacoVimUmd.ts` + vite.config.ts) so the bindings act on the live
 * `window.monaco` instance instead of a second, bundled Monaco.
 *
 * Keep this module behind a dynamic `import()`: the bundle is ~200 kB and most
 * sessions never enable Vim mode.
 */
import monacoVim from 'virtual:monaco-vim-umd';

import type { MonacoVimApi } from './monacoVimUmd';

export type { MonacoVimAdapter, MonacoVimApi } from './monacoVimUmd';

let cached: MonacoVimApi | null = null;
let activeSaveHandler: (() => void) | null = null;
let exCommandsRegistered = false;

/**
 * The editor that owns Vim's `:w` command — the focused pane sets this, so the
 * Ex command saves the file the user is looking at (monaco-vim's Ex registry is
 * process-global).
 */
export const setActiveVimSaveHandler = (handler: (() => void) | null): void => {
  activeSaveHandler = handler;
};

const registerExCommands = (api: MonacoVimApi): void => {
  if (exCommandsRegistered) return;
  const defineEx = api.VimMode?.Vim?.defineEx;
  if (typeof defineEx !== 'function') return;
  defineEx('write', 'w', () => {
    activeSaveHandler?.();
  });
  exCommandsRegistered = true;
};

/** Resolve the shared monaco-vim module (binds to the live Monaco instance). */
export const loadMonacoVim = async (): Promise<MonacoVimApi> => {
  if (cached) return cached;
  if (!(globalThis as { monaco?: unknown }).monaco) {
    throw new Error('monaco-vim requires the Monaco editor instance to be loaded first');
  }
  if (!monacoVim || typeof monacoVim.initVimMode !== 'function') {
    throw new Error('monaco-vim did not expose initVimMode');
  }
  registerExCommands(monacoVim);
  cached = monacoVim;
  return cached;
};
