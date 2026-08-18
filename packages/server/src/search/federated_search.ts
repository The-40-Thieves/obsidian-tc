// THE-630: federated multi-vault search — the fan-out/fusion engine `vault_graph_search` uses when
// a caller supplies more than one target vault.
//
// This is a structural sibling of THE-448's multi_query.ts (query-VARIANT fan-out), on a DIFFERENT
// axis (vault instead of phrasing), and deliberately reuses its shape rather than inventing a new
// one: bounded concurrency via runWithConcurrency, and cross-pool fusion by rank-based RRF rather
// than raw-score fusion. The reasoning for RANK over SCORE is the same one multi_query.ts's header
// gives for query variants, restated here for vaults: graph_search's convex fusion min-max-
// normalizes raw stream scores over a SINGLE vault's own candidate pool (fuseScores' `minMaxNorm`
// in graph_search_stages/fusion.ts). A vault's own BM25/fused score is corpus-relative to THAT
// vault's index — a 0.8 in vault A's pool and a 0.8 in vault B's pool are not the same evidence
// strength, and two vaults can have very different corpus statistics (size, term distribution).
// Rank is comparable across vaults by construction, so scoring on rank sidesteps the cross-vault
// normalization mismatch entirely, exactly as it does across query variants.
//
// DELIBERATELY GENERIC: this module knows nothing about ACL, the query cache, or how a "vault
// leg" is actually computed — `FederatedLeg.run` is an opaque thunk the CALLER builds (in
// tools/m7/knowledge/graph-search.ts) already closed over that vault's own ACL and its own
// `cachedGraphSearch` cache context. Keeping ACL/cache concerns out of this module is what makes
// the two THE-630 security invariants (per-vault ACL, per-vault cache isolation) provable at the
// call site that builds each leg, rather than something this fan-out engine could get wrong.
//
// Fuses on the COMPOSITE key (vault, path), never bare `path`: two different vaults can legitimately
// share a relative path for two unrelated notes (e.g. both have "Inbox/note.md"). Collapsing on
// path alone would silently merge two unrelated notes' results into one entry — a correctness bug
// worse than the "N separate calls" gap this ticket exists to close. See fuseFederatedResults.
//
// Deliberately does NOT do content-hash dedup across vaults (v1 scope decision, THE-630): two
// vaults holding the same note is a fact worth surfacing, not noise to silently collapse. Every
// vault's hit for a shared note is returned as a separate, distinctly-tagged entry.
import { runWithConcurrency } from "../util/concurrency";
import type { GraphSearchResult } from "./graph_search_stages/types";

/** THE-630 fan-out tuning — same off-by-default-shape convention as
 *  MultiQueryFanOutOptions (multi_query.ts): depth/concurrency knobs, not a behavior toggle
 *  (federation itself is gated by the caller supplying 2+ target vaults). */
export interface FederatedFanOutOptions {
  /** Max simultaneous per-vault searches. Default 3 — same default as THE-448's fan-out. */
  concurrency?: number;
  /** RRF k for the ACROSS-vault fusion (rank-based). Defaults to 10, matching both graph_search's
   *  own in-query rrfK default and THE-448's fuseVariants default, for tuning consistency across
   *  every fusion layer in this codebase. */
  rrfK?: number;
}

/** One target vault's search, already fully assembled by the caller: its own ACL baked into
 *  `isReadable`, its own query-cache context (or none), its own routing decision. `meta` carries
 *  whatever caller-defined bookkeeping (mode_used, coverage, ...) the caller wants back per vault,
 *  untouched by this module — generic so this engine stays ignorant of the m7 tool's response
 *  shape. */
export interface FederatedLeg<Meta = undefined> {
  vaultId: string;
  run: () => Promise<{ results: GraphSearchResult[]; meta?: Meta }>;
}

/** The result of running one leg: always present even when the leg threw (empty results, no
 *  meta) — a single bad vault (transient error, vault-specific misconfiguration) must not sink the
 *  others, mirroring multiQueryGraphSearch's per-variant catch. */
export interface FederatedLegOutcome<Meta = undefined> {
  vaultId: string;
  results: GraphSearchResult[];
  meta?: Meta;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_FAN_OUT_RRF_K = 10;

/**
 * Run every vault leg with bounded concurrency (default 3). A leg that throws contributes an empty
 * result set rather than failing the whole federated call — the same per-leg isolation
 * multiQueryGraphSearch already gives per-variant.
 */
export async function runFederatedLegs<Meta = undefined>(
  legs: FederatedLeg<Meta>[],
  fanOutOpts?: FederatedFanOutOptions,
): Promise<FederatedLegOutcome<Meta>[]> {
  const concurrency = Math.max(1, fanOutOpts?.concurrency ?? DEFAULT_CONCURRENCY);
  return runWithConcurrency(legs, concurrency, async (leg) => {
    try {
      const { results, meta } = await leg.run();
      return { vaultId: leg.vaultId, results, meta };
    } catch {
      return { vaultId: leg.vaultId, results: [] as GraphSearchResult[] };
    }
  });
}

/** A fused result, tagged with the vault it came from — required so a caller can tell two
 *  same-path hits from different vaults apart (they are never the same note). */
export interface TaggedGraphSearchResult extends GraphSearchResult {
  vault: string;
}

/**
 * Fuse several vaults' RANKED result lists by Reciprocal Rank Fusion on rank position: each
 * candidate's score is Σ over the vaults it appears in of 1/(rrfK + rank-in-that-vault) (rank is
 * 1-based, matching graph_search.ts's and multi_query.ts's own rrf convention).
 *
 * Dedupes on the COMPOSITE key `(vaultId, path)`, never bare `path` — see this module's header.
 * Because each vault only ever contributes entries keyed under its OWN vaultId, two vaults can
 * never collide on this key even when they share a relative path; the accumulation branch below
 * only ever fires for genuine repeats WITHIN one vault's own ranked list (which graphSearch itself
 * does not produce, but is not assumed away here either).
 */
export function fuseFederatedResults<Meta = undefined>(
  legOutcomes: Array<Pick<FederatedLegOutcome<Meta>, "vaultId" | "results">>,
  rrfK: number,
  finalTopK: number,
): TaggedGraphSearchResult[] {
  const byKey = new Map<
    string,
    { result: TaggedGraphSearchResult; bestRank: number; score: number }
  >();
  for (const { vaultId, results } of legOutcomes) {
    results.forEach((r, i) => {
      const rank = i + 1;
      const contribution = 1 / (rrfK + rank);
      // Separator is an ASCII unit separator (\x1f), which VaultId's regex
      // (`^[a-z0-9_-]+$`) guarantees a vault id can never contain, so this cannot collide the
      // way a plain `${vaultId}:${path}` join could if a path ever contained ":".
      const key = `${vaultId}\x1f${r.path}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { result: { ...r, vault: vaultId }, bestRank: rank, score: contribution });
      } else {
        existing.score += contribution;
        if (rank < existing.bestRank) {
          existing.result = { ...r, vault: vaultId };
          existing.bestRank = rank;
        }
      }
    });
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, finalTopK)
    .map((e) => e.result);
}

/** Run every leg and fuse the results — the composition every caller actually wants. Exported
 *  separately from `runFederatedLegs`/`fuseFederatedResults` so a caller that also needs the
 *  per-vault outcomes (e.g. to report per-vault coverage/mode_used) can call those two directly
 *  instead of re-deriving them from this function's return value. */
export async function federatedGraphSearch<Meta = undefined>(
  legs: FederatedLeg<Meta>[],
  finalTopK: number,
  fanOutOpts?: FederatedFanOutOptions,
): Promise<{ legOutcomes: FederatedLegOutcome<Meta>[]; fused: TaggedGraphSearchResult[] }> {
  const rrfK = fanOutOpts?.rrfK ?? DEFAULT_FAN_OUT_RRF_K;
  const legOutcomes = await runFederatedLegs(legs, fanOutOpts);
  const fused = fuseFederatedResults(legOutcomes, rrfK, finalTopK);
  return { legOutcomes, fused };
}
