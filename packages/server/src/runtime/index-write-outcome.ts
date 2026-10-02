// What an index-on-write failure DID, split by kind — the index-on-write twin of
// reconcile-outcome.ts's applyReconcileOutcome.
//
// A note whose frontmatter is not valid YAML cannot be indexed, but that is a typo in one note, not
// a broken index. Counting it in `writeFailures` tripped the index-stalled alert (keyed on
// write_failures > 0) for a typo and hid a real I/O failure behind it. The reconcile already treats
// the same error kind as skip-and-warn (index-vault.ts: counted, listed, hinted); this applies the
// same policy per write: the old rows stay (the throw lands before any row is touched), the failure
// is counted on the same Prometheus counter, and health gets its own field that clears when the
// note is repaired.

import type { Database } from "../db/types";
import { recordFrontmatterSkip } from "../metrics/ingest-stats";
import type { MetricsRecorder } from "../metrics/registry";
import { errorMessage } from "../util/errors";
import { isFrontmatterYamlError } from "../vault/frontmatter";
import { FRONTMATTER_SKIP_HINT } from "./reconcile-outcome";

export interface FrontmatterFailure {
  vault: string;
  path: string;
  error: string;
}

/** The slice of IndexHealthState this module reads and writes. */
export interface IndexWriteHealth {
  writeFailures: number;
  lastWriteError?: string;
  /** Notes whose latest index-on-write failed on bad frontmatter YAML, keyed `vault\0path`. */
  frontmatterFailures: Map<string, FrontmatterFailure>;
  lastFrontmatterFailure?: FrontmatterFailure;
}

const keyOf = (vault: string, path: string): string => `${vault}\u0000${path}`;

export function applyIndexWriteError(
  e: unknown,
  vaultId: string,
  path: string,
  health: IndexWriteHealth,
  deps: { db: Database; metrics: MetricsRecorder; write: (s: string) => void },
): void {
  if (!isFrontmatterYamlError(e)) {
    health.writeFailures++;
    health.lastWriteError = errorMessage(e);
    return;
  }
  const failure = { vault: vaultId, path, error: errorMessage(e) };
  health.frontmatterFailures.set(keyOf(vaultId, path), failure);
  health.lastFrontmatterFailure = failure;
  recordFrontmatterSkip(deps.db, deps.metrics, vaultId);
  deps.write(
    `[index] index-on-write skipped "${path}" in vault "${vaultId}": ${failure.error}. ` +
      `The search index keeps its previous rows for it; ${FRONTMATTER_SKIP_HINT}\n`,
  );
}

/** A write or delete for this path went through: the note no longer fails on frontmatter. */
export function clearFrontmatterFailure(
  health: Pick<IndexWriteHealth, "frontmatterFailures" | "lastFrontmatterFailure">,
  vaultId: string,
  path: string,
): void {
  if (!health.frontmatterFailures.delete(keyOf(vaultId, path))) return;
  if (
    health.lastFrontmatterFailure?.vault === vaultId &&
    health.lastFrontmatterFailure.path === path
  )
    health.lastFrontmatterFailure = [...health.frontmatterFailures.values()].pop();
}

/** A completed reconcile pass saw exactly `failing` for this vault: every other note it walked
 *  parsed, so an earlier index-on-write failure for it is stale (repaired outside the server). */
export function syncFrontmatterFailures(
  health: Pick<IndexWriteHealth, "frontmatterFailures" | "lastFrontmatterFailure">,
  vaultId: string,
  failing: ReadonlyArray<{ path: string }>,
): void {
  const still = new Set(failing.map((f) => f.path));
  for (const f of [...health.frontmatterFailures.values()])
    if (f.vault === vaultId && !still.has(f.path)) clearFrontmatterFailure(health, vaultId, f.path);
}
