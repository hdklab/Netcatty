/**
 * Running a workflow command inside an already-open terminal session.
 *
 * This is the only way to run commands on telnet / serial devices, mosh hosts
 * and hosts behind a jump chain: they have no SSH exec channel, so we type the
 * command into the live session and read the visible screen back. The extraction
 * rules live in domain/workflow/sessionOutput.ts.
 *
 * Consequence to keep in mind: the run is visible in that terminal and the
 * session must be otherwise idle (a running editor would swallow the input).
 */

import {
  extractCommandOutput,
  isCommandEchoVisible,
  screenFingerprint,
} from '@/domain/workflow/sessionOutput.ts';

export interface WorkflowSessionRef {
  id: string;
  hostId?: string;
}

export interface SessionChannelDeps {
  sessions: readonly WorkflowSessionRef[];
  writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  captureSnapshot: (sessionId: string) => { lines: string[] };
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface SessionCommandParams {
  hostId: string;
  command: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Screen must stay unchanged this long to count as finished. */
  settleMs?: number;
  pollMs?: number;
}

export interface SessionCommandResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export const SESSION_POLL_MS = 300;
export const SESSION_SETTLE_MS = 900;

export function findSessionForHost(
  sessions: readonly WorkflowSessionRef[],
  hostId: string,
): WorkflowSessionRef | undefined {
  return sessions.find((session) => session.hostId === hostId);
}

export async function runCommandInSession(
  params: SessionCommandParams,
  deps: SessionChannelDeps,
): Promise<SessionCommandResult> {
  const session = findSessionForHost(deps.sessions, params.hostId);
  if (!session) {
    return { ok: false, error: 'No open terminal session for this host' };
  }

  const now = deps.now ?? (() => Date.now());
  const settleMs = params.settleMs ?? SESSION_SETTLE_MS;
  const pollMs = params.pollMs ?? SESSION_POLL_MS;

  deps.writeToSession(session.id, `${params.command}\r`, { automated: true });

  const startedAt = now();
  let lastFingerprint = '';
  let stableSince = 0;
  let timedOut = false;

  for (;;) {
    try {
      await deps.sleep(pollMs, params.signal);
    } catch {
      return { ok: false, error: 'Cancelled' };
    }
    const fingerprint = screenFingerprint(deps.captureSnapshot(session.id).lines);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = now();
    } else if (stableSince > 0 && now() - stableSince >= settleMs) {
      break;
    }
    if (now() - startedAt >= params.timeoutMs) {
      timedOut = true;
      break;
    }
  }

  const lines = deps.captureSnapshot(session.id).lines;
  const stdout = extractCommandOutput({ lines, command: params.command });
  if (!isCommandEchoVisible(lines, params.command)) {
    return {
      ok: false,
      stdout,
      error: 'The session did not accept the command (is it busy, or waiting for input?)',
    };
  }
  if (timedOut) {
    return { ok: false, stdout, error: 'Timed out waiting for the session output to settle' };
  }
  return { ok: true, stdout };
}
