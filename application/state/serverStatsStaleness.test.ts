import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_STATS_STALE_MIN_AGE_MS,
  isServerStatsStale,
  resolveServerStatsStaleAfterMs,
} from "./serverStatsStaleness.ts";

test("staleness threshold scales with the refresh interval but never below the floor", () => {
  assert.equal(resolveServerStatsStaleAfterMs(1), SERVER_STATS_STALE_MIN_AGE_MS);
  assert.equal(resolveServerStatsStaleAfterMs(5), SERVER_STATS_STALE_MIN_AGE_MS);
  assert.equal(resolveServerStatsStaleAfterMs(10), 30_000);
  assert.equal(resolveServerStatsStaleAfterMs(0), SERVER_STATS_STALE_MIN_AGE_MS);
  assert.equal(resolveServerStatsStaleAfterMs(Number.NaN), SERVER_STATS_STALE_MIN_AGE_MS);
});

test("a fresh successful sample is never stale, even with a lingering error", () => {
  const now = 1_000_000;
  assert.equal(
    isServerStatsStale({ error: null, lastUpdated: now - 60_000, refreshIntervalSeconds: 5, now }),
    false,
  );
  // A single failed poll leaves a ~10s old reading: still live enough.
  assert.equal(
    isServerStatsStale({
      error: "SSH exec channel open still pending on this connection",
      lastUpdated: now - 10_000,
      refreshIntervalSeconds: 5,
      now,
    }),
    false,
  );
});

test("a fenced transport turns the strip stale instead of freezing silently", () => {
  const now = 1_000_000;
  assert.equal(
    isServerStatsStale({
      error: "SSH exec channel open still pending on this connection",
      lastUpdated: now - 5 * 60_000,
      refreshIntervalSeconds: 5,
      now,
    }),
    true,
  );
  // No successful sample at all (first poll failed): nothing to mark as stale.
  assert.equal(
    isServerStatsStale({ error: "boom", lastUpdated: null, refreshIntervalSeconds: 5, now }),
    false,
  );
});
