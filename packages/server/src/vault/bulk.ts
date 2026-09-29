// Generic bulk executor (THE-182 / M6 Domain 25). Runs a set of sub-operations
// through a bounded-concurrency worker pool and aggregates a per-item result
// report — the locked partial-failure contract: best-effort-continue by default
// (every item attempted, individual failures captured in results[]), or
// stop-on-first-error to halt the queue. Each result carries a stable identity
// (e.g. {path}) so a failed item is still attributable. The clock is injectable
// so duration_ms is deterministic in tests. No vault/IO here — the per-item
// callback does the work (resolveVaultPath + enforcePathAcl + write), so this
// stays pure orchestration.
import { type ErrorJSON, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { redactSecrets } from "../experiential/redact";

export interface BulkOptions {
  /** Maximum sub-operations in flight at once (clamped to >= 1). */
  maxConcurrent: number;
  /** Halt the queue on the first failing item (in-flight items still finish). */
  stopOnFirstError: boolean;
  /** Injectable clock for deterministic duration_ms. */
  now?: () => number;
}

export type BulkItemOutcome = Record<string, unknown> & { ok: boolean; error?: ErrorJSON };

export interface BulkReport {
  processed: number;
  succeeded: number;
  failed: number;
  results: BulkItemOutcome[];
  duration_ms: number;
}

function toErrorJson(e: unknown): ErrorJSON {
  return (
    e instanceof ObsidianTcError ? e : new ObsidianTcError("internal_error", (e as Error).message)
  ).toJSON();
}

/** Review finding: a `secret_detected` refusal must not echo the secret-shaped value BACK in the
 *  same failed item it refused — `identity(item)` can carry the very field that triggered the
 *  refusal (bulk_create_notes'/bulk_set_property's `path`, when the PATH itself is secret-shaped).
 *  Redacts every string leaf (recursing into arrays/nested objects, though today's callers are
 *  flat) with the same scanner every write path uses, so the class of leak memory-defense.test.ts
 *  already pins for `add_tag`/`rewrite_link` extends to a bulk item's own identity fields too. */
function redactIdentityValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactIdentityValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactIdentityValue(v)]),
    );
  }
  return value;
}

function redactIdentityFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, redactIdentityValue(v)]));
}

/**
 * Execute `perItem` over `items` with bounded concurrency, returning a per-item
 * report. `identity` labels each result (success and failure alike) so a thrown
 * sub-op is still attributable to its input. Results preserve input order; items
 * skipped after a stop-on-first-error halt are omitted (processed < total).
 */
export async function runBulk<T>(
  items: readonly T[],
  opts: BulkOptions,
  identity: (item: T, index: number) => Record<string, unknown>,
  perItem: (item: T, index: number) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<BulkReport> {
  const now = opts.now ?? Date.now;
  const start = now();
  const results: (BulkItemOutcome | undefined)[] = new Array(items.length);
  let next = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    while (!stop) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      const idFields = identity(item, i);
      try {
        const out = await perItem(item, i);
        results[i] = { ...idFields, ok: true, ...out };
      } catch (e) {
        // Review finding: a secret_detected refusal must not echo the secret-shaped identity
        // field(s) — e.g. a caller-supplied `path` that was ITSELF secret-shaped — back in the
        // same failed item that refused it.
        const safeIdFields =
          e instanceof ObsidianTcError && e.code === "secret_detected"
            ? redactIdentityFields(idFields)
            : idFields;
        results[i] = { ...safeIdFields, ok: false, error: toErrorJson(e) };
        if (opts.stopOnFirstError) stop = true;
      }
    }
  };

  const poolSize = Math.max(1, Math.min(opts.maxConcurrent, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const finalized = results.filter((r): r is BulkItemOutcome => r !== undefined);
  const succeeded = finalized.filter((r) => r.ok).length;
  return {
    processed: finalized.length,
    succeeded,
    failed: finalized.length - succeeded,
    results: finalized,
    duration_ms: Math.max(0, now() - start),
  };
}
