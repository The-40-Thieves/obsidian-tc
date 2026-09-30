// ADR-0007 class (b): ONE resolver for retrieval parameters whose right value depends on a
// measurable property of the index, replacing the bare `?? 10` constants that used to live at each
// call site (graph_search, federated_search, multi_query, the federated tool, the retrieval-policy
// record, the gap sweep).
//
// PRECEDENCE (highest first):
//   1. an explicit per-call argument            (source "call")
//   2. an explicit config value                 (source "config")
//   3. a value derived from measured stats      (source "derived") — ONLY when
//                                               `retrieval.derivedDefaults` is true, default FALSE
//   4. the constant main shipped                (source "default")
// With the flag off, steps 1, 2 and 4 are exactly what the old `?? 10` chain computed.
//
// THIS MODULE FLIPS NO LIVE DEFAULT. ADR-0007 requires multi-shape evidence before a class-(b)
// derivation may become the default; the mechanism ships dark behind the flag and the evidence it
// has so far is recorded in that ADR's status section.

import type { Database } from "../db/types";
import { readVaultIndexStats, type VaultIndexStats } from "./vault-index-stats";

/** THE-397's k=10: the RRF rank constant, measured on ~30-deep streams. */
export const DEFAULT_RRF_K = 10;
/** kNN edge floor: 0 keeps every neighbour the kNN returns. */
export const DEFAULT_KNN_MIN_SIM = 0;
/** graphSearch's default seed-stream depth (`opts.seedCount ?? 30`). */
export const DEFAULT_SEED_COUNT = 30;

/** Derived k is clamped to this range. The floor keeps 1/(k+rank) from collapsing to a pure
 *  rank-1 winner-take-all; the ceiling is the folklore k=60 every production engine ships. */
export const RRF_K_MIN = 2;
export const RRF_K_MAX = 60;

/** k per unit of pool depth: THE-397 measured k=10 best at a pool depth of 30. */
const RRF_K_POOL_RATIO = DEFAULT_RRF_K / DEFAULT_SEED_COUNT;

export type DefaultSource = "call" | "config" | "derived" | "default";

export interface ResolvedDefault {
  value: number;
  source: DefaultSource;
}

export interface RetrievalDefaultsConfig {
  rrfK?: number | undefined;
  knnMinSim?: number | undefined;
  /** `retrieval.derivedDefaults`. Absent/false -> never derive. */
  derivedDefaults?: boolean | undefined;
}

export interface RetrievalDefaultsCall {
  rrfK?: number | undefined;
  knnMinSim?: number | undefined;
  /** The seed-stream depth this call actually searches with; feeds the derivation. */
  seedCount?: number | undefined;
}

export interface RetrievalDefaults {
  rrfK: ResolvedDefault;
  knnMinSim: ResolvedDefault;
}

/**
 * Derive the RRF constant from the vault's measured pool depth.
 *
 *   pool = min(seedCount, chunkCount)           (how deep the dense/lexical streams can rank)
 *   k    = clamp(round(pool * 10/30), 2, 60)
 *
 * Why: graph_search.ts's own THE-397 comment — k must stay BELOW the stream pool depth, because at
 * k > M-2 a document at rank M in two streams outranks a rank-1 single-stream hit. A vault smaller
 * than the seed pool has a shallower pool, so the same k over-rewards overlap. The ratio is pinned
 * so the pool THE-397 measured (30) reproduces its constant (10) exactly; every vault with >= 30
 * chunks therefore derives the shipped value, and only sub-pool vaults differ.
 *
 * Monotonic non-decreasing in chunkCount and in seedCount (round and clamp are monotone). Returns
 * an integer in [RRF_K_MIN, RRF_K_MAX], or null when the stats are unusable (missing, NaN, zero or
 * negative chunks) so the caller keeps the constant rather than a fabricated value.
 *
 * Graph density and chunks-per-note are deliberately NOT inputs: no measurement shows rrfK depends
 * on them, and a formula term with no evidence is a tuned constant in disguise. They are recorded
 * in VaultIndexStats so the eval can show whether that should change.
 */
export function deriveRrfK(
  stats: VaultIndexStats | null | undefined,
  seedCount: number = DEFAULT_SEED_COUNT,
): number | null {
  const chunks = stats?.chunkCount;
  if (typeof chunks !== "number" || !Number.isFinite(chunks) || chunks < 1) return null;
  const seeds = Number.isFinite(seedCount) && seedCount > 0 ? seedCount : DEFAULT_SEED_COUNT;
  const pool = Math.min(seeds, chunks);
  return Math.min(RRF_K_MAX, Math.max(RRF_K_MIN, Math.round(pool * RRF_K_POOL_RATIO)));
}

/**
 * Resolve every stat-conditional retrieval default for ONE vault. `stats` may be null/undefined
 * (missing): derivation then falls back to the constant. `knnMinSim` has no derivation — the index
 * records no neighbour-similarity distribution to derive a floor from — so it only ever resolves
 * call > config > constant; it lives here so its constant has one home and one diagnostic.
 */
export function resolveRetrievalDefaults(
  stats: VaultIndexStats | null | undefined,
  config?: RetrievalDefaultsConfig,
  call?: RetrievalDefaultsCall,
): RetrievalDefaults {
  let rrfK: ResolvedDefault;
  if (call?.rrfK != null) rrfK = { value: call.rrfK, source: "call" };
  else if (config?.rrfK != null) rrfK = { value: config.rrfK, source: "config" };
  else {
    const derived = config?.derivedDefaults === true ? deriveRrfK(stats, call?.seedCount) : null;
    rrfK =
      derived !== null
        ? { value: derived, source: "derived" }
        : { value: DEFAULT_RRF_K, source: "default" };
  }

  let knnMinSim: ResolvedDefault;
  if (call?.knnMinSim != null) knnMinSim = { value: call.knnMinSim, source: "call" };
  else if (config?.knnMinSim != null) knnMinSim = { value: config.knnMinSim, source: "config" };
  else knnMinSim = { value: DEFAULT_KNN_MIN_SIM, source: "default" };

  return { rrfK, knnMinSim };
}

/**
 * The stats-reading wrapper every per-vault call site uses. Reads the stats ONLY when the flag is
 * on and nothing explicit already decided rrfK, so the default-off path runs no query.
 */
export function resolveRetrievalDefaultsForVault(
  db: Database,
  vaultId: string,
  config?: RetrievalDefaultsConfig,
  call?: RetrievalDefaultsCall,
): RetrievalDefaults {
  const needStats = config?.derivedDefaults === true && call?.rrfK == null && config?.rrfK == null;
  return resolveRetrievalDefaults(
    needStats ? readVaultIndexStats(db, vaultId) : null,
    config,
    call,
  );
}

/**
 * Cross-LIST fusion (federated vaults, multi-query variants). Those lists are shaped by the
 * caller's finalTopK, not by any one vault's index, so no per-vault stat applies: call > constant.
 */
export function resolveFanOutRrfK(call?: number): ResolvedDefault {
  return call != null
    ? { value: call, source: "call" }
    : { value: DEFAULT_RRF_K, source: "default" };
}
