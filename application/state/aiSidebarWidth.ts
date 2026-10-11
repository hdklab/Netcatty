/**
 * Width math for the global AI side panel (VS Code style). The panel is docked
 * to the right of the app shell and drag-resizable, so the bounds live here as
 * pure helpers — mirroring `terminalSidePanelWidth.ts`.
 */
export const AI_SIDEBAR_DEFAULT_WIDTH = 399;
export const AI_SIDEBAR_MIN_WIDTH = 280;
export const AI_SIDEBAR_MAX_WIDTH = 1200;
/** The chat column never takes more than this share of the window. */
export const AI_SIDEBAR_MAX_VIEWPORT_RATIO = 0.7;

export function getAiSidebarMaxWidth(viewportWidth: number): number {
  const viewportCap = Math.floor(viewportWidth * AI_SIDEBAR_MAX_VIEWPORT_RATIO);
  return Math.max(
    AI_SIDEBAR_MIN_WIDTH,
    Math.min(AI_SIDEBAR_MAX_WIDTH, viewportCap),
  );
}

export function clampAiSidebarWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return AI_SIDEBAR_DEFAULT_WIDTH;
  return Math.max(
    AI_SIDEBAR_MIN_WIDTH,
    Math.min(getAiSidebarMaxWidth(viewportWidth), Math.round(width)),
  );
}
