/**
 * Scope resolution for the app-wide AI sidebar.
 *
 * The sidebar is not a terminal accessory any more (see AiGlobalSidebar), but its
 * chats are still scope-bound: a chat lives under `terminal:<sessionId>` or
 * `workspace:<workspaceId>`, and only that scope's sessions are exposed to the
 * agent's injected Netcatty MCP server. So the sidebar has to pick a scope that
 * has a live terminal behind it, otherwise the agent sees zero sessions
 * ("No hosts are available in the current scope") while the user has terminals
 * open.
 *
 * Rules, in order:
 *   1. the active tab's context, when that tab is a terminal session/workspace;
 *   2. the last tab that had one, while it is still live — switching to Vaults or
 *      the dashboard must not drop the conversation back to a host-less scope;
 *   3. the caller's page-level fallback (no terminal exists at all).
 *
 * Kept pure and React-free so the wiring bug this fixes stays covered by unit
 * tests instead of only by a running app.
 */

export interface AiSidebarContextLike {
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
}

/**
 * Pick the context the sidebar should render for, or `fallback` when no live
 * terminal/workspace can host it.
 */
export function resolveAiSidebarContext<C extends AiSidebarContextLike>(input: {
  activeTabId: string | null | undefined;
  contextsByTabId: Map<string, C>;
  rememberedTabId: string | null;
  fallback: C;
}): C {
  const { activeTabId, contextsByTabId, rememberedTabId, fallback } = input;
  if (activeTabId) {
    const active = contextsByTabId.get(activeTabId);
    if (active) return active;
  }
  if (rememberedTabId) {
    const remembered = contextsByTabId.get(rememberedTabId);
    if (remembered) return remembered;
  }
  return fallback;
}

/**
 * Next value for the "last hostable tab" memory: the active tab once it can host
 * the panel, otherwise the previous id only while it still has a context (a
 * closed terminal/workspace must not keep an agent bound to a dead session).
 */
export function rememberAiSidebarTabId(input: {
  previous: string | null;
  activeTabId: string | null | undefined;
  contextsByTabId: Map<string, unknown>;
}): string | null {
  const { previous, activeTabId, contextsByTabId } = input;
  if (activeTabId && contextsByTabId.has(activeTabId)) return activeTabId;
  if (previous && contextsByTabId.has(previous)) return previous;
  return null;
}
