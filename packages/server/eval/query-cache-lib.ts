// Pure helpers for eval/query-cache.ts (the retrieval.cache latency / identity / memory harness).
// Kept apart from the driver so the stream construction and the comparison rules can be unit-tested
// without a database, a provider or a registry.

/** Seeded PRNG (mulberry32): the stream must be reproducible from its seed alone. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StreamCall {
  /** Index into the distinct-query pool. */
  query: number;
  /** True when this call re-asks a query an earlier call in the stream already asked. */
  repeat: boolean;
}

/** Longest look-back, in calls, a repeat may reach. Under the cache's 64-entry cap, so the LRU never
 *  evicts a query before its repeat arrives. */
export const MAX_REPEAT_GAP = 20;

/**
 * `distinct` first sightings in a seeded shuffled order, plus `ceil(distinct * r / (1 - r))` repeats.
 * Each repeat re-asks the query `1..MAX_REPEAT_GAP` calls behind it, so the repeat fraction is r to
 * within one call and the structure is controlled in CALLS, not seconds.
 */
export function buildStream(distinct: number, repeatRate: number, seed: number): StreamCall[] {
  if (!Number.isInteger(distinct) || distinct < 1) throw new Error("distinct must be >= 1");
  if (!(repeatRate >= 0 && repeatRate < 1)) throw new Error("repeatRate must be in [0, 1)");
  const rand = mulberry32(seed);
  const order = Array.from({ length: distinct }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  const repeats = repeatRate === 0 ? 0 : Math.ceil((distinct * repeatRate) / (1 - repeatRate));
  const total = distinct + repeats;
  // Position 0 can never be a repeat (nothing precedes it).
  const repeatSlots = new Set<number>();
  while (repeatSlots.size < repeats) repeatSlots.add(1 + Math.floor(rand() * (total - 1)));
  const calls: StreamCall[] = [];
  let next = 0;
  for (let p = 0; p < total; p++) {
    if (repeatSlots.has(p)) {
      const gap = 1 + Math.floor(rand() * Math.min(MAX_REPEAT_GAP, p));
      calls.push({ query: (calls[p - gap] as StreamCall).query, repeat: true });
    } else {
      calls.push({ query: order[next++] as number, repeat: false });
    }
  }
  return calls;
}

/** Nearest-rank quantile of an ASCENDING-sorted sample. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  ] as number;
}

export function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

export interface LatencySummary {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.length === 0 ? Number.NaN : sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), mean };
}

/** Top-level keys whose JSON differs between two responses (the whole-response identity check names
 *  WHAT differed, not just that something did). Both inputs are the parsed `dispatch` data. */
export function differingKeys(a: unknown, b: unknown): string[] {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).sort();
}

/**
 * Deterministic restricted-caller folder set: top-level folders in name order until their chunks cover
 * at least `fraction` of the total, never all of them. Root-level files (no folder) are never covered,
 * so the restricted caller really is excluded from something.
 */
export function foldersCovering(
  chunkCountByPath: ReadonlyMap<string, number>,
  fraction: number,
): string[] {
  const byFolder = new Map<string, number>();
  let total = 0;
  for (const [path, n] of chunkCountByPath) {
    total += n;
    const slash = path.indexOf("/");
    if (slash <= 0) continue;
    const folder = path.slice(0, slash);
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + n);
  }
  const names = [...byFolder.keys()].sort();
  const picked: string[] = [];
  let covered = 0;
  for (const name of names) {
    if (picked.length === names.length - 1) break;
    picked.push(name);
    covered += byFolder.get(name) as number;
    if (covered >= fraction * total) break;
  }
  return picked;
}

/** True when `path` sits under one of the `folders` (top-level folder names). */
export function underFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((f) => path.startsWith(`${f}/`));
}
