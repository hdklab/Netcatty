import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { TerminalSession, Workspace } from "../../types";
import type { SplitHint } from "./TerminalLayerSupport";
import { useTerminalWorkspaceLayout } from "./useTerminalWorkspaceLayout.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type LayoutApi = ReturnType<typeof useTerminalWorkspaceLayout>;

const WORKSPACE_ID = "ws-1";

const workspace: Workspace = {
  id: WORKSPACE_ID,
  title: "Workspace",
  focusedSessionId: "s1",
  focusSessionOrder: ["s1", "s2"],
  root: {
    id: "split-1",
    type: "split",
    direction: "vertical",
    sizes: [1, 1],
    children: [
      { id: "pane-1", type: "pane", sessionId: "s1" },
      { id: "pane-2", type: "pane", sessionId: "s2" },
    ],
  },
} as Workspace;

const sessions = [
  { id: "s1", workspaceId: WORKSPACE_ID },
  { id: "s2", workspaceId: WORKSPACE_ID },
  { id: "orphan", workspaceId: undefined },
] as unknown as TerminalSession[];

const surface = {
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    right: 400,
    bottom: 200,
    width: 400,
    height: 200,
    x: 0,
    y: 0,
  }),
};

function createDropEvent(sessionId: string, clientX: number, clientY: number) {
  let defaultPrevented = false;
  return {
    clientX,
    clientY,
    dataTransfer: { getData: (format: string) => (format === "session-id" ? sessionId : "") },
    preventDefault: () => { defaultPrevented = true; },
    get defaultPrevented() { return defaultPrevented; },
  };
}

async function mountLayout(options?: {
  isFocusMode?: boolean;
}) {
  const calls = {
    added: [] as unknown[],
    created: [] as unknown[],
    moved: [] as unknown[],
    dragging: [] as Array<string | null>,
    hint: null as SplitHint,
  };
  let api: LayoutApi | null = null;

  function Harness() {
    api = useTerminalWorkspaceLayout({
      activeSession: undefined,
      activeWorkspace: workspace,
      isFocusMode: options?.isFocusMode ?? false,
      shouldKeepHiddenWorkspaceLaidOut: () => false,
      onAddSessionToWorkspace: (...args) => calls.added.push(args),
      onCreateWorkspaceFromSessions: (...args) => calls.created.push(args),
      onMoveSessionInWorkspace: (...args) => calls.moved.push(args),
      onSetDraggingSessionId: (id) => calls.dragging.push(id),
      onUpdateSplitSizes: () => undefined,
      sessions,
      workspaces: [workspace],
    });
    return null;
  }

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness));
  });
  await act(async () => {
    api!.setWorkspaceArea({ width: 400, height: 200 });
    // The hook owns these refs; point the surface at a measured rect.
    (api!.workspaceInnerRef as { current: unknown }).current = surface;
    (api!.workspaceOuterRef as { current: unknown }).current = surface;
  });

  return {
    calls,
    api: () => api!,
    unmount: async () => { await act(async () => { renderer!.unmount(); }); },
  };
}

test("dropping a workspace pane on another pane's centre swaps them", async () => {
  const layout = await mountLayout();

  await act(async () => {
    layout.api().handleWorkspaceDrop(createDropEvent("s1", 300, 100) as never);
  });

  assert.equal(layout.calls.added.length, 0, "an in-workspace pane must not be re-added");
  assert.equal(layout.calls.moved.length, 1);
  const [workspaceId, sessionId, hint] = layout.calls.moved[0] as [string, string, SplitHint];
  assert.equal(workspaceId, WORKSPACE_ID);
  assert.equal(sessionId, "s1");
  assert.deepEqual(
    { position: hint?.position, target: hint?.targetSessionId },
    { position: "center", target: "s2" },
  );
  assert.ok(hint?.rect, "a swap preview highlights the whole target pane");
  assert.equal(hint?.rect?.w, 200);
  assert.equal(hint?.rect?.h, 200);

  await layout.unmount();
});

test("dropping a workspace pane on another pane's edge re-splits", async () => {
  const layout = await mountLayout();

  await act(async () => {
    // Right edge of the second pane (x 300..400 of the 200..400 pane).
    layout.api().handleWorkspaceDrop(createDropEvent("s1", 390, 100) as never);
  });

  assert.equal(layout.calls.moved.length, 1);
  const [, sessionId, hint] = layout.calls.moved[0] as [string, string, SplitHint];
  assert.equal(sessionId, "s1");
  assert.equal(hint?.position, "right");
  assert.equal(hint?.targetSessionId, "s2");
  assert.equal(hint?.rect?.w, 100, "an edge drop previews half of the target pane");

  await layout.unmount();
});

test("dropping a workspace pane on itself does nothing", async () => {
  const layout = await mountLayout();

  await act(async () => {
    layout.api().handleWorkspaceDrop(createDropEvent("s1", 100, 100) as never);
  });

  assert.equal(layout.calls.moved.length, 0);
  assert.equal(layout.calls.added.length, 0);

  await layout.unmount();
});

test("an orphan tab dropped on a pane centre still splits, never swaps", async () => {
  const layout = await mountLayout();

  await act(async () => {
    layout.api().handleWorkspaceDrop(createDropEvent("orphan", 300, 100) as never);
  });

  assert.equal(layout.calls.moved.length, 0);
  assert.equal(layout.calls.added.length, 1);
  const [workspaceId, sessionId, hint] = layout.calls.added[0] as [string, string, SplitHint];
  assert.equal(workspaceId, WORKSPACE_ID);
  assert.equal(sessionId, "orphan");
  assert.notEqual(hint?.position, "center");

  await layout.unmount();
});

test("focus mode never rearranges panes", async () => {
  const layout = await mountLayout({ isFocusMode: true });

  await act(async () => {
    layout.api().handleWorkspaceDrop(createDropEvent("s1", 300, 100) as never);
  });

  assert.equal(layout.calls.moved.length, 0);
  assert.equal(layout.calls.added.length, 0);

  await layout.unmount();
});
