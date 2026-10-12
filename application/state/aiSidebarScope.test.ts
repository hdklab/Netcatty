import assert from "node:assert/strict";
import test from "node:test";

import {
  rememberAiSidebarTabId,
  resolveAiSidebarContext,
} from "./aiSidebarScope";

type Ctx = {
  scopeType: "terminal" | "workspace";
  scopeTargetId: string;
  terminalSessions: string[];
};

const sessionCtx = (sessionId: string): Ctx => ({
  scopeType: "terminal",
  scopeTargetId: sessionId,
  terminalSessions: [sessionId],
});

const PAGE_FALLBACK: Ctx = {
  scopeType: "workspace",
  scopeTargetId: "ai-sidebar",
  terminalSessions: [],
};

test("sidebar follows the active terminal/workspace tab", () => {
  const contexts = new Map<string, Ctx>([
    ["session-a", sessionCtx("session-a")],
    ["session-b", sessionCtx("session-b")],
  ]);

  assert.deepEqual(
    resolveAiSidebarContext({
      activeTabId: "session-b",
      contextsByTabId: contexts,
      rememberedTabId: "session-a",
      fallback: PAGE_FALLBACK,
    }),
    sessionCtx("session-b"),
  );
});

test("sidebar keeps the last hostable tab while the active view cannot host it", () => {
  // Vaults/SFTP/dashboard are active: the chat must stay on the terminal the
  // user was last on instead of dropping to the host-less page scope, or the
  // agent loses sight of every open session.
  const contexts = new Map<string, Ctx>([["session-a", sessionCtx("session-a")]]);

  assert.deepEqual(
    resolveAiSidebarContext({
      activeTabId: "vault",
      contextsByTabId: contexts,
      rememberedTabId: "session-a",
      fallback: PAGE_FALLBACK,
    }),
    sessionCtx("session-a"),
  );
});

test("sidebar falls back to the page scope only when no live tab can host it", () => {
  const contexts = new Map<string, Ctx>();

  assert.deepEqual(
    resolveAiSidebarContext({
      activeTabId: "vault",
      contextsByTabId: contexts,
      rememberedTabId: "session-a-closed",
      fallback: PAGE_FALLBACK,
    }),
    PAGE_FALLBACK,
  );
});

test("the remembered tab is dropped once its terminal/workspace is gone", () => {
  assert.equal(
    rememberAiSidebarTabId({
      previous: "session-a",
      activeTabId: "session-b",
      contextsByTabId: new Map([["session-b", sessionCtx("session-b")]]),
    }),
    "session-b",
  );

  assert.equal(
    rememberAiSidebarTabId({
      previous: "session-a",
      activeTabId: "vault",
      contextsByTabId: new Map([["session-a", sessionCtx("session-a")]]),
    }),
    "session-a",
  );

  assert.equal(
    rememberAiSidebarTabId({
      previous: "session-a",
      activeTabId: "vault",
      contextsByTabId: new Map(),
    }),
    null,
  );
});
