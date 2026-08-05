// WP2 slice 1: the shared retrieval helpers moved verbatim out of knowledge-tools.ts — the cache
// key builder, policy/coverage capture sinks, hit logging, budget packing, the prewarm bundle
// path extractor, the config-driven graphSearch options builder, and the tag/contradiction
// lookups the tool handlers compose. `buildKnowledgeTools` (still in knowledge-tools.ts) imports
// these; nothing here imports the facade back.

import { version as VERSION } from "../../../../package.json";
import { tableExists } from "../../../db/introspect";
import type { Database } from "../../../db/types";
import { readLatestCalibration } from "../../../experiential/calibration";
import type { RetrievalPolicyRecord } from "../../../experiential/log";
import type { CallerContext } from "../../../mcp/registry";
import { type ContradictionContext, EVIDENCE_TRUNCATE } from "../../../plane/challenge";
import type { ColbertMatrix } from "../../../search/colbert";
import type { EvidenceBudget } from "../../../search/evidence";
import { readGeneration } from "../../../search/generation";
import type {
  CoverageEstimate,
  GraphSearchOptions,
  GraphSearchResult,
} from "../../../search/graph_search";
import type { StageMetric } from "../../../search/graph_search_stages/instrumentation";
import { callerAclFingerprint } from "../../../search/prefetch";
import type { QueryCacheContext, QueryVectors } from "../../../search/query_cache";
import type { RerankOutcome } from "../../../search/rerank";
import type { SparseVec } from "../../../search/sparse";
import type { M7Deps } from "./deps";

/**
 * WP2.2: the shared retrieval state `buildKnowledgeTools` used to build as bare local closures at
 * its top — `embedQuery`/`embedQuerySparse`/`embedQueryColbert` (the three query encodings) plus
 * `embedAll` (the THE-497 bundle of them, invoked only on a cache miss). Constructed exactly ONCE
 * in `buildKnowledgeTools` and handed to every tool factory as a single object so no factory can
 * end up building its own embedder, cache, or policy state — see embedAll's own doc comment (in
 * knowledge-tools.ts, where it is still built) on why `embedAll` must stay a thunk rather than
 * something already awaited: it is invoked ONLY on a cache miss, so eagerly evaluating it while
 * hoisting would make a cache hit start making provider network calls.
 */
export interface RetrievalRuntime {
  embedQuery: (query: string) => Promise<number[]>;
  embedQuerySparse: (query: string) => Promise<SparseVec | undefined>;
  embedQueryColbert: (query: string) => Promise<ColbertMatrix | undefined>;
  embedAll: (denseText: string, lexicalText: string) => Promise<QueryVectors>;
}

/**
 * THE-497: the per-dispatch half of the cache key. Built here, at the only place that has all
 * three inputs: the CALLER (ACL fingerprint — the isolation guarantee), the VAULT (generation —
 * the staleness guarantee), and what the query vectors will MEAN (provider/model/dimensions plus
 * which multi-vector streams are on, since those decide which heads `embed()` even produces).
 *
 * Returns undefined when the cache is off, which makes every call site an exact pass-through.
 */
export function cacheContextFor(
  deps: M7Deps,
  ctx: CallerContext,
  vaultId: string,
  denseText: string,
): QueryCacheContext | undefined {
  if (!deps.retrievalCaches) return undefined;
  return {
    caches: deps.retrievalCaches,
    denseText,
    binding: {
      aclFingerprint: callerAclFingerprint(ctx.acl, ctx.grantedScopes),
      generation: readGeneration(ctx.db, vaultId),
      representation: {
        id: deps.embeddingProvider.id,
        provider: deps.embeddingProvider.provider,
        model: deps.embeddingProvider.model,
        dimensions: deps.embeddingProvider.dimensions,
        sparse: deps.retrieval?.sparse === true,
        colbert: deps.retrieval?.colbert === true,
      },
    },
  };
}

/**
 * THE-538: capture the ranking policy behind ONE search call, for `retrieval_policy`.
 *
 * The weights are taken from the fusion stage's own sink rather than re-derived from config: under
 * adaptive RRF they are computed PER QUERY from lexical specificity, and a missing FTS signal
 * silently falls back to static all-1 weights — so a record built from the configured gain would
 * describe a policy that did not run. No sink call (the lexical short-circuit never fuses) leaves
 * the weights null and the policy id explicit.
 */
export function capturePolicy(deps: M7Deps, vaultId: string, routeClass: string) {
  let weights: { policyId: string; dense: number; lex: number; sparse: number } | undefined;
  return {
    sink: (w: typeof weights) => {
      weights = w;
    },
    record: (fallbackPolicyId: string): RetrievalPolicyRecord => ({
      vaultId,
      policyId: weights?.policyId ?? fallbackPolicyId,
      denseW: weights?.dense ?? null,
      lexW: weights?.lex ?? null,
      sparseW: weights?.sparse ?? null,
      // These surfaces never override fusionMode, so the effective mode is graphSearch's default.
      fusionMode: weights ? "graph_rrf" : null,
      rrfK: weights ? (deps.retrieval?.rrfK ?? 10) : null,
      routeClass,
    }),
  };
}

/** THE-631: capture the coverage estimate for ONE search call, mirroring capturePolicy's sink
 *  pattern above. Under multi-query fan-out, graphSearch's onCoverage fires once per variant (see
 *  its own doc comment); `get()` returns whichever call landed last, matching capturePolicy's/
 *  onFusionWeights' existing precedent for the same fan-out shape. Undefined when the search
 *  never reached graphSearch at all (the lexical-route arm) — that stays undefined -> omitted
 *  from the response, matching CoverageEstimateSchema's `.optional()`. */
export function captureCoverage() {
  let coverage: CoverageEstimate | undefined;
  return {
    sink: (c: CoverageEstimate) => {
      coverage = c;
    },
    get: () => coverage,
  };
}

/** THE-538: one log hit per result, carrying the fusion STREAM that produced it. */
export function retrievalHits(results: GraphSearchResult[]) {
  return results.map((r, i) => ({
    chunkId: r.chunk_id,
    rank: i + 1,
    score: r.rerank_score,
    streamSource: r.source,
  }));
}

/** THE-231: lesson-class paths — decision notes, lessons, postmortems, retros. Convention-based
 *  (path substring), matching the vault layouts the challenge corpus already assumes. */
export const LESSON_PATH_RE = /decision|lesson|postmortem|retro/i;
/** THE-231: the queued-thread signal note written at the end of the previous session. */
export const NEXT_SESSION_NOTE = "_next-session.md";

/** THE-222: grounded-synthesis role prompt for reflect's default mode. */
export const REFLECT_SYSTEM_PROMPT =
  "You synthesize a grounded answer from the user's own notes. Use ONLY the numbered evidence " +
  "chunks; cite them inline as [n]; state plainly what the evidence does not establish. " +
  "Concise, factual, no filler.";

/** THE-132: greedy budget packer — walk fused-rank order, spend token costs until the budget
 *  binds. Pure and exported for the packing pins. */
export function packBudget<T>(
  items: T[],
  tokenOf: (item: T) => number,
  budget: number,
): { packed: T[]; tokens: number } {
  const packed: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = Math.max(1, tokenOf(item));
    if (tokens + cost > budget && packed.length > 0) break;
    packed.push(item);
    tokens += cost;
    if (tokens >= budget) break;
  }
  return { packed, tokens };
}

export const CHALLENGE_RECALL = 30;

/** The evidence budget for the challenge prompt, composed here because this is the side of the
 *  tools -> plane edge that may name both halves: CHALLENGE_RECALL is local, EVIDENCE_TRUNCATE
 *  comes from plane/challenge.ts, and importing CHALLENGE_RECALL the other way would close a
 *  cycle against a zero baseline.
 *
 *  Both callers that assemble challenge evidence (knowledge-challenge.ts and reflect.ts's
 *  challenge mode) build against this, so the two paths can no longer disagree about how much the
 *  judge sees. The item count and per-item truncation are exactly what those paths already
 *  applied. `maxPerNote` is NEW and deliberately loose — at 6 of 30 it binds only when a single
 *  note supplies a fifth of the whole evidence set, the degenerate shape a quota exists for
 *  rather than anything ordinary retrieval produces. */
export const CHALLENGE_EVIDENCE_BUDGET: EvidenceBudget = {
  maxItems: CHALLENGE_RECALL,
  maxCharsPerItem: EVIDENCE_TRUNCATE,
  maxPerNote: 6,
};

/** The evidence budget for reflect's SYNTHESIS prompt. Its caps are what that path already hard-
 *  coded inline (`results.slice(0, 20)`, `content.slice(0, 800)`); naming them makes the gap
 *  visible rather than accidental — synthesis shows the model 800 characters of a chunk where
 *  challenge shows 1800, a 2.25x difference that nothing recorded as a decision. Left as-is here
 *  because closing it changes what a model is shown, which is an evaluated change, not a refactor.
 *  `maxPerNote` at 5 of 20 (25%) is the same loose quota rationale as the challenge budget. */
export const SYNTHESIS_EVIDENCE_BUDGET: EvidenceBudget = {
  maxItems: 20,
  maxCharsPerItem: 800,
  maxPerNote: 5,
};

/** THE-543 layer 3 (defence in depth): every vault-relative path a cached prewarm bundle
 *  references, so the hit path can re-run each one through readableRel before trusting the
 *  bundle — even a bundle whose cache key checks out gets one final authorization pass. */
export function prewarmBundlePaths(bundle: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["notes", "lessons"] as const) {
    const arr = bundle[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const p = (item as { path?: unknown } | null)?.path;
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

/** THE-545: every CONFIG-DERIVED graphSearch option, assembled in exactly one place.
 *
 *  The four graphSearch call sites in this module each hand-assembled this object, and the copies
 *  drifted. `ranking.metadataPrior` reached vault_context and reflect but neither
 *  vault_graph_search — the primary search verb — nor knowledge_search. Partial reachability is
 *  worse than no reachability: the knob measurably changed two surfaces and silently did nothing on
 *  the other two, so any measurement taken on one surface did not describe the others.
 *
 *  The generator of that defect was the hand-assembly itself — a new knob had to be remembered four
 *  separate times, and remembering is not a mechanism. Routing every site through one builder makes
 *  threading structural: a knob added here reaches every surface by construction.
 *
 *  Genuinely per-site values stay explicit parameters rather than being defaulted here, so a
 *  deliberate deviation stays visible at its call site. `reranker` is the one that matters:
 *  knowledge_search pins it to null on purpose (THE-441, reranking lost on the docs corpus), and
 *  that decision must not look like an omission. */
export function buildGraphSearchOptions(
  deps: M7Deps,
  site: {
    route: { class: string };
    query: string;
    /** THE-497: optional. The cached path builds these options BEFORE embedding — a cache hit must
     *  skip the model round-trip, so the vectors are merged in afterwards on a miss only. */
    queryVec?: number[];
    querySparse?: GraphSearchOptions["querySparse"];
    queryColbert?: GraphSearchOptions["queryColbert"];
    vaultId: string;
    finalTopK: number;
    reranker: GraphSearchOptions["reranker"];
    isReadable: GraphSearchOptions["isReadable"];
    /** THE-538: per-query fusion-weight sink for retrieval-policy provenance. */
    onFusionWeights?: GraphSearchOptions["onFusionWeights"];
    /** THE-631: per-query coverage-estimate sink, mirrors onFusionWeights above. */
    onCoverage?: GraphSearchOptions["onCoverage"];
    /** THE-632: diagnose_retrieval's per-note trace. Same pure-side-channel contract as the two
     *  sinks above — supplied only by diagnose_retrieval, never by a normal search, so the
     *  production path is byte-identical to before. */
    traceNotePath?: GraphSearchOptions["traceNotePath"];
    onRetrievalTrace?: GraphSearchOptions["onRetrievalTrace"];
  },
): Omit<GraphSearchOptions, "queryVec"> & { queryVec?: number[] } {
  return {
    ...(site.route.class === "temporal" ? { temporal: { enabled: true } } : {}),
    query: site.query,
    ...(site.queryVec ? { queryVec: site.queryVec } : {}),
    model: deps.embeddingProvider.id, // THE-530: constrain seeds to the active model
    vaultId: site.vaultId,
    finalTopK: site.finalTopK,
    ...(deps.retrieval?.rrfK !== undefined ? { rrfK: deps.retrieval.rrfK } : {}),
    ...(deps.retrieval?.densify?.includeInWalk ? { densify: deps.retrieval.densify } : {}),
    ...(deps.retrieval?.adaptiveRrf?.enabled ? { adaptiveRrf: deps.retrieval.adaptiveRrf } : {}),
    // THE-693: the hub defence, reachable from config at last. Passed WHOLE, not just `enabled` —
    // hubDegreeCap/perSeedCap/expansionSeeds must travel with it or an operator who tunes the cap
    // gets the default silently.
    ...(deps.retrieval?.graphStream?.enabled ? { graphStream: deps.retrieval.graphStream } : {}),
    ...(deps.retrieval?.gatedRerank ? { gatedRerank: { enabled: true } } : {}),
    ...(deps.ranking?.metadataPrior?.enabled ? { metadataPrior: deps.ranking.metadataPrior } : {}),
    ...(site.querySparse ? { querySparse: site.querySparse } : {}),
    ...(site.queryColbert ? { queryColbert: site.queryColbert } : {}),
    reranker: site.reranker,
    isReadable: site.isReadable,
    ...(site.onFusionWeights ? { onFusionWeights: site.onFusionWeights } : {}),
    ...(site.onCoverage ? { onCoverage: site.onCoverage } : {}),
    // THE-733: the vault's persisted score calibration, read ONLY when a caller asked for
    // coverage — an ordinary search pays nothing for a reported-only side channel. Read here
    // rather than inside graphSearch because `score_calibration` lives in the EXPERIENTIAL store
    // and the search path only holds the authored cache db.
    //
    // Absent edb, or a vault never calibrated, yields `null` -> confidence reports
    // `not_calibrated`. That is the designed answer, not a degraded one: a number derived from
    // another vault's percentiles would look authoritative and be meaningless.
    ...(site.onCoverage && deps.edb
      ? {
          scoreCalibration: readLatestCalibration(deps.edb, site.vaultId),
          engineVersion: VERSION,
        }
      : {}),
    // THE-632: both or neither — a trace path with no sink traces into nothing, and a sink with no
    // path has nothing to follow. Gating them together keeps that unrepresentable.
    ...(site.traceNotePath && site.onRetrievalTrace
      ? { traceNotePath: site.traceNotePath, onRetrievalTrace: site.onRetrievalTrace }
      : {}),
    ...(deps.activationFor ? { activationFor: deps.activationFor } : {}),
    // THE-585: vec0 -> brute-force degradation signal, bound to this vault. Threaded through the
    // options builder so EVERY graph-search site gets it — wiring it per call site is how a
    // counter ends up covering some paths and silently missing others.
    ...(deps.onVecFallback
      ? {
          onVecFallback: (reason: "error" | "underfill") =>
            deps.onVecFallback?.(site.vaultId, reason),
        }
      : {}),
    // THE-585 (#6): same options-builder placement, same reason — a per-call-site wiring would
    // cover some retrieval paths and silently miss others, which is the failure mode a funnel
    // metric is least able to survive (a missing stage reads as a stage that never ran).
    ...(deps.onStageMetric
      ? { onStageMetric: (metric: StageMetric) => deps.onStageMetric?.(site.vaultId, metric) }
      : {}),
    // same options-builder placement as onVecFallback/onStageMetric above, same reason —
    // a per-call-site wiring would cover some rerank call sites and silently miss others.
    ...(deps.onRerankOutcome
      ? {
          onRerankOutcome: (outcome: RerankOutcome) =>
            deps.onRerankOutcome?.(site.vaultId, outcome),
        }
      : {}),
  };
}

/** Note-level frontmatter tags for the given paths (THE-309), so isDecisionChunk's tag rule can
 *  fire on the retrieved evidence — the semantic hit itself carries no tags. Scoped to the vault. */
export function noteTagsByPath(
  db: Database,
  vaultId: string,
  paths: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (paths.length === 0 || !tableExists(db, "notes")) return out;
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT path, tags FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
    .all(vaultId, ...paths) as Array<{ path: string; tags: string }>;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        out.set(
          r.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // malformed tags JSON — treat the note as untagged rather than failing the challenge.
    }
  }
  return out;
}

/** Open contradictions whose source or conflict note is in `paths` (THE-309), scoped to `vaultId`
 *  (THE-563) and re-authorized against the caller ACL (THE-564): a row is returned only if BOTH
 *  contributing sources remain readable — the opposite side of a matched pair may be outside the
 *  caller's set. Empty when the plane table is absent. */
export function openContradictionsForPaths(
  db: Database,
  vaultId: string,
  paths: string[],
  isReadable: (rel: string) => boolean,
): ContradictionContext[] {
  if (paths.length === 0 || !tableExists(db, "contradictions")) return [];
  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, source_path, conflict_path, judge_verdict, judge_rationale FROM contradictions
       WHERE status = 'open' AND vault_id = ? AND (source_path IN (${placeholders}) OR conflict_path IN (${placeholders}))`,
    )
    .all(vaultId, ...paths, ...paths) as Array<{
    id: string;
    source_path: string;
    conflict_path: string;
    judge_verdict: string;
    judge_rationale: string | null;
  }>;
  return rows
    .filter((r) => isReadable(r.source_path) && isReadable(r.conflict_path))
    .map((r) => ({
      id: r.id,
      source_path: r.source_path,
      conflict_path: r.conflict_path,
      judge_verdict: r.judge_verdict,
      judge_rationale: r.judge_rationale ?? "",
    }));
}
