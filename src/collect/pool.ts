/** Default parallel workers for Instagram permalink detail enrichment. */
export const DEFAULT_DETAIL_WORKERS = 10;

/**
 * Run `fn` over `items` with at most `workers` in flight.
 * Results are always indexed by input position (stable by input index).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  workers: number,
  fn: (item: T, index: number, workerId: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (n === 0) return out;

  const workerCount = Math.max(1, Math.min(Math.floor(workers) || 1, n));
  let next = 0;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(items[i]!, i, workerId);
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, id) => worker(id)),
  );
  return out;
}
