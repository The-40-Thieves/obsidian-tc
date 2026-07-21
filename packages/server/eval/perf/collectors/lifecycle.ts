import { performance } from "node:perf_hooks";
import {
  CHUNKER_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
} from "../../../src/search/representation";
import { ensureVecChunks } from "../../../src/search/vec";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

const SHUTDOWN_DEADLINE_MS = 5000;

// Family 12 (HTTP cold/warm handshake) is deferred to a follow-up ticket — this task ships
// only families 11 (vec migration) and 13 (shutdown drain); see task-9 report for rationale.

/**
 * Family 11 (vec-index migration) + Family 13 (shutdown drain).
 *
 * This collector closes `vault.db` as its shutdown-drain measurement, so it MUST run last in
 * any orchestration order (Task 10) — nothing that touches `vault.db` can run after it.
 */
export async function collectLifecycle(vault: VaultCtx): Promise<MetricSample[]> {
  // Family 11: force a vec-index rebuild by requesting a fingerprint whose dimension (64) differs
  // from the corpus embedding dimension (32, see eval/perf/harness.ts). THE-460 replaced the old
  // dims-only argument with a full VecFingerprint; dimension is one folded field, so a differing
  // dimension still trips the fingerprint-mismatch rebuild path. Under Node vitest sqlite-vec is
  // not loaded, so `ensureVecChunks` returns false -> `migration.rebuilt` is 0; that's expected
  // here and NOT asserted true by the test.
  const t0 = performance.now();
  const rebuilt = ensureVecChunks(vault.db, {
    provider: "perf",
    model: "perf-model",
    dimensions: 64,
    distanceMetric: VEC_DISTANCE_METRIC,
    enrichmentVersion: 0,
    chunkerVersion: CHUNKER_VERSION,
    schemaGen: VEC_SCHEMA_GEN,
  });
  const migMs = performance.now() - t0;

  // Family 13: time closing the DB under a deadline.
  const s0 = performance.now();
  vault.db.close?.();
  const drainMs = performance.now() - s0;
  const drained = drainMs < SHUTDOWN_DEADLINE_MS ? 1 : 0;

  return [
    {
      key: "migration.rebuilt",
      value: rebuilt ? 1 : 0,
      unit: "bool",
      class: "hard",
      direction: "exact",
    },
    { key: "migration.ms", value: migMs, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "shutdown.drained", value: drained, unit: "bool", class: "hard", direction: "exact" },
    { key: "shutdown.ms", value: drainMs, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}
