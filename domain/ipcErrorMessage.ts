const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*/i;

/**
 * Drop the Electron IPC wrapper from a rejected `ipcRenderer.invoke` so the UI
 * can show the backend error itself.
 *
 * `ipcRenderer.invoke` rejects with `Error invoking remote method 'netcatty:x':
 * Error: <real message>`, and that whole string reaches the terminal line, the
 * toast and the reconnect dialog whenever a start fails.
 */
export function stripIpcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const unwrapped = raw.replace(IPC_ERROR_PREFIX, "").replace(/^Error:\s*/, "").trim();
  return unwrapped || raw;
}
