/**
 * Where the top-bar AI assistant button can actually show its panel.
 *
 * The AI side panel renders inside the terminal layer and needs an AI context,
 * which only terminal sessions and workspaces provide (see
 * useTerminalAiContexts). From the Vaults view — or any other non-terminal tab —
 * toggling the panel only flipped state that could never paint behind the vault
 * surface, so the button looked completely dead.
 */

interface AiPanelTabIdentity {
  id: string;
}

interface AiPanelSessionIdentity extends AiPanelTabIdentity {
  workspaceId?: string | null;
  hiddenFromTabs?: boolean;
}

/** True when `tabId` is a terminal session or a workspace tab. */
export function canHostAiPanelForTab(
  tabId: string | null | undefined,
  candidates: { sessions: AiPanelTabIdentity[]; workspaces: AiPanelTabIdentity[] },
): boolean {
  if (!tabId) return false;
  return candidates.sessions.some((session) => session.id === tabId)
    || candidates.workspaces.some((workspace) => workspace.id === tabId);
}

/**
 * Terminal tab the AI panel should attach to when the active tab cannot host
 * it. Order: the workspace the user is inside, then a session that owns its own
 * tab (preferring the focused one), then any workspace, then null (no terminal
 * exists yet — the caller has to create one).
 */
export function resolveAiPanelTerminalTab(input: {
  sessions: AiPanelSessionIdentity[];
  workspaces: AiPanelTabIdentity[];
  activeWorkspaceId?: string | null;
  focusedSessionId?: string | null;
  activeSessionId?: string | null;
}): string | null {
  const { sessions, workspaces } = input;
  const activeWorkspaceId = input.activeWorkspaceId ?? null;
  if (activeWorkspaceId && workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
    return activeWorkspaceId;
  }

  // Standalone sessions are the ones that own a top tab: sessions inside a
  // workspace (or explicitly hidden) are addressed through their workspace.
  const standaloneSessions = sessions.filter(
    (session) => !session.workspaceId && !session.hiddenFromTabs,
  );
  if (standaloneSessions.length > 0) {
    const focusedSessionId = input.focusedSessionId ?? input.activeSessionId ?? null;
    const focused = standaloneSessions.find((session) => session.id === focusedSessionId);
    return (focused ?? standaloneSessions[standaloneSessions.length - 1]).id;
  }

  return workspaces[0]?.id ?? null;
}
