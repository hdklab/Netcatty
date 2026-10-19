import test from "node:test";
import assert from "node:assert/strict";

import { wrapMonacoVimUmd } from "./monacoVimUmd.ts";

/** Same branch structure as monaco-vim's UMD preamble. */
const FAKE_UMD = `
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? factory(exports, require('monaco-editor/esm/vs/editor/editor.api'))
    : typeof define === 'function' && define.amd
      ? define(['monaco-editor/esm/vs/editor/editor.api'], factory)
      : (global = typeof globalThis !== 'undefined' ? globalThis : global || self,
         factory((global.MonacoVim = {}), global.monaco));
})(this, function (exports, monaco) {
  exports.initVimMode = function (editor, statusNode) {
    return { editor: editor, statusNode: statusNode, mode: monaco && monaco.marker, dispose: function () {} };
  };
  return exports;
});
`;

type Globals = typeof globalThis & {
  define?: unknown;
  monaco?: unknown;
  MonacoVim?: unknown;
};

interface FakeApi {
  initVimMode: (editor: unknown, statusNode: unknown) => { mode?: string; dispose: () => void };
}

const runWrapped = (wrapped: string): FakeApi => {
  const body = wrapped.replace(/export default globalThis\.MonacoVim;\s*$/, "");
  // Node has no CSP; this mirrors what Vite emits for the virtual module.
  return new Function(`${body}\nreturn globalThis.MonacoVim;`)();
};

const withGlobals = (fn: () => void) => {
  const g = globalThis as Globals;
  const previous = { define: g.define, monaco: g.monaco, MonacoVim: g.MonacoVim };
  try {
    fn();
  } finally {
    g.define = previous.define;
    g.monaco = previous.monaco;
    g.MonacoVim = previous.MonacoVim;
  }
};

test("wrapped bundle takes the global branch even though Monaco's AMD loader defines define.amd", () => {
  withGlobals(() => {
    const g = globalThis as Globals;
    let amdCalls = 0;
    g.define = Object.assign(() => { amdCalls += 1; }, { amd: true });
    g.monaco = { marker: "live-instance" };

    const api = runWrapped(wrapMonacoVimUmd(FAKE_UMD));

    assert.equal(amdCalls, 0);
    assert.equal(typeof api.initVimMode, "function");
    assert.equal(g.MonacoVim, api);
    const adapter = api.initVimMode({ id: "editor" }, null);
    assert.equal(adapter.mode, "live-instance");
  });
});

test("wrapped bundle exports the API for the lazy chunk", () => {
  const wrapped = wrapMonacoVimUmd(FAKE_UMD);
  assert.match(wrapped, /\(function \(define, module, exports, require\) \{/);
  assert.match(wrapped, /\}\)\(undefined, undefined, undefined, undefined\);/);
  assert.match(wrapped, /export default globalThis\.MonacoVim;/);
});
