import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-text guard (the renderer suites here assert component contracts this
 * way): a polled stats strip must never paint stale numbers as if they were
 * live — a stalled exec channel freezes the last sample forever, which reads as
 * "the terminal's system status stopped refreshing".
 */
const source = readFileSync(new URL("./TerminalServerStats.tsx", import.meta.url), "utf8");

test("the strip derives staleness from the polling error and last sample age", () => {
  assert.match(source, /import \{ isServerStatsStale \} from '\.\.\/\.\.\/application\/state\/serverStatsStaleness'/);
  assert.match(source, /const \{ stats: serverStats, error: statsError \} = useServerStats\(/);
  assert.match(source, /isServerStatsStale\(\{/);
  // Wall-clock staleness needs its own tick: a frozen session sends no updates.
  assert.match(source, /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\)/);
});

test("a stale strip is dimmed and labelled instead of looking live", () => {
  assert.match(source, /data-server-stats-stale="true"/);
  assert.match(source, /terminal\.serverStats\.stale"/);
  assert.match(source, /terminal\.serverStats\.staleHint", \{\s*time:/);
  assert.match(source, /stale \? "opacity-45" : "opacity-80"/);
});
