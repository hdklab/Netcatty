/**
 * Server stats are polled, not pushed: when polling fails the strip keeps
 * painting the last successful sample, so a dead exec channel looks exactly
 * like a healthy idle host. These helpers decide when the numbers on screen
 * are old enough that the UI must say so instead of pretending they are live.
 *
 * Staleness needs both a failure and age: one missed poll at a 5s interval
 * leaves the numbers ~10s old, which is not worth flagging, while a fenced
 * transport never recovers and must become visible.
 */
export const SERVER_STATS_STALE_MIN_AGE_MS = 20_000;

const FALLBACK_INTERVAL_MS = 5_000;

export function resolveServerStatsStaleAfterMs(refreshIntervalSeconds: number): number {
  const intervalMs = Number.isFinite(refreshIntervalSeconds) && refreshIntervalSeconds > 0
    ? refreshIntervalSeconds * 1000
    : FALLBACK_INTERVAL_MS;
  return Math.max(SERVER_STATS_STALE_MIN_AGE_MS, intervalMs * 3);
}

export function isServerStatsStale({
  error,
  lastUpdated,
  refreshIntervalSeconds,
  now,
}: {
  error: string | null;
  lastUpdated: number | null;
  refreshIntervalSeconds: number;
  now: number;
}): boolean {
  if (!error || !lastUpdated) return false;
  if (!Number.isFinite(now)) return false;
  return now - lastUpdated >= resolveServerStatsStaleAfterMs(refreshIntervalSeconds);
}
