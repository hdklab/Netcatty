/**
 * Bounded parallel map used by the host-command executor.
 *
 * Each host in a node runs independently, so a node fans out over its hosts
 * with a concurrency ceiling. `failFast` stops handing out new work after the
 * first failure; in-flight work still finishes and everything never started is
 * reported as `skipped` instead of silently missing.
 */

export interface MapOutcome<R> {
  index: number;
  value?: R;
  error?: string;
  /** True when the item was never started (fail-fast or abort). */
  skipped: boolean;
}

export interface MapWithConcurrencyOptions<R = unknown> {
  failFast?: boolean;
  signal?: AbortSignal;
  /**
   * With `failFast`, also stop after a worker that *settled successfully* while
   * reporting failure in its value (a host command that exited non-zero, for
   * example).
   */
  shouldStop?: (value: R) => boolean;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions<R> = {},
): Promise<Array<MapOutcome<R>>> {
  const results: Array<MapOutcome<R>> = items.map((_, index) => ({ index, skipped: true }));
  if (items.length === 0) return results;

  const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  let stopped = false;

  const pump = async (): Promise<void> => {
    for (;;) {
      if (stopped || options.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        const value = await worker(item, index);
        results[index] = { index, value, skipped: false };
        if (options.failFast && options.shouldStop?.(value)) stopped = true;
      } catch (err) {
        results[index] = {
          index,
          error: err instanceof Error ? err.message : String(err),
          skipped: false,
        };
        if (options.failFast) stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: boundedLimit }, () => pump()));
  return results;
}
