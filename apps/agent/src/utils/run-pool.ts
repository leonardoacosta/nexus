/**
 * Run N async tasks with a concurrency cap. Each task receives its input and
 * returns a promise; the returned array is index-aligned with `items`.
 * Failures propagate to the caller (wrap in the worker if you need per-item
 * error isolation).
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function run(): Promise<void> {
    while (idx < items.length) {
      const myIdx = idx++;
      results[myIdx] = await worker(items[myIdx]!);
    }
  }
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}
