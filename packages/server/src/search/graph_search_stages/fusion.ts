// THE-465 "scoreFusion" stage: THE-391 adaptive per-stream RRF weighting, the RRF/convex scoring
// functions, the POST-FUSION metadata-prior clamp, and the final fused sort. Moved verbatim out
// of graphSearchCore's step 5 — same rrfK default plumbing (caller-supplied), same convex alpha
// default (0.7), same metadata-prior clamp fraction default (DEFAULT_META_PRIOR_CLAMP), same
// tie-break order (score desc, then source rank, then stream rank). Not entered for
// fusionMode "score_merge" (that mode bypasses fusion scoring entirely — see graph_search.ts).

import type { Database } from "../../db/types";
import { querySpecificity } from "../adaptive_rrf";
import type { SemanticHit } from "../semantic";
import {
  type Candidate,
  DEFAULT_META_PRIOR_CLAMP,
  type FusionMode,
  type GraphSearchOptions,
} from "./types";

export interface FusionInput {
  db: Database;
  opts: GraphSearchOptions;
  candidates: Candidate[];
  seeds: SemanticHit[];
  expSimById: Map<string, number>;
  lexRankById: Map<string, number>;
  lexScoreById: Map<string, number>;
  sparseRankById: Map<string, number>;
  sparseScoreById: Map<string, number>;
  temporalRankById: Map<string, number>;
  rrfK: number;
  fusionMode: FusionMode;
}

export interface FusionResult {
  fused: Candidate[];
  scoreOfWithPrior: (c: Candidate) => number;
  isConvex: boolean;
}

export function fuseScores(input: FusionInput): FusionResult {
  const {
    db,
    opts,
    candidates,
    seeds,
    expSimById,
    lexRankById,
    lexScoreById,
    sparseRankById,
    sparseScoreById,
    temporalRankById,
    rrfK,
    fusionMode,
  } = input;

  // THE-391 adaptive RRF: tilt the per-stream weights by the query's lexical specificity — rare
  // terms trust the BM25/sparse ranks, common-vocabulary queries trust the dense seeds. Neutral
  // (all 1, exactly static RRF) when disabled, when the signal is unavailable, or at
  // specificity 0.5.
  let denseW = 1;
  let lexW = 1;
  let sparseW = 1;
  if (opts.adaptiveRrf?.enabled ?? false) {
    // gain clamped to [0,1] so weights stay within [0,2] — an over-unity gain would drive a
    // stream weight NEGATIVE and actively invert its ranking, never just reweight it.
    const gain = Math.min(1, Math.max(0, opts.adaptiveRrf?.gain ?? 0.5));
    const spec = querySpecificity(db, opts.vaultId, opts.query);
    if (spec !== null) {
      const tilt = gain * (2 * spec - 1);
      denseW = 1 - tilt;
      lexW = 1 + tilt;
      sparseW = 1 + tilt;
    }
  }
  // Expansion carries the SEMANTIC-side weight, same as the seeds: both are cosine evidence on
  // the lexical-vs-semantic axis, and weighting them apart would let the tilt reorder seeds vs
  // expansion — demoting the expansion stream that multi-hop targets ride (live-index eval:
  // recall@10 0.231 pinned-at-1 vs 0.282 carrying denseW, adaptive gain 0.5, nomic-768 n=10).
  const streamWeight: Record<Candidate["source"], number> = {
    seed: denseW,
    lexical: lexW,
    sparse: sparseW,
    expansion: denseW,
    // THE-221: the temporal stream sits outside the lexical-vs-semantic axis the adaptive tilt
    // reweights — date evidence is neither, so it fuses at neutral weight.
    temporal: 1,
  };
  // RRF fusion (THE-73): each candidate's base contribution is w/(k + its own stream rank), PLUS an
  // additive lexical contribution when it also appears in the BM25 stream — a chunk matched by two
  // streams outranks a single-stream hit (the point of hybrid). A lexical-only candidate already
  // carries its BM25 rank as streamRank, so its base term IS the lexical term (no double count).
  const rrf = (c: Candidate): number => {
    let s = streamWeight[c.source] / (rrfK + c.streamRank);
    if (c.source !== "lexical") {
      const lr = lexRankById.get(c.chunk_id);
      if (lr !== undefined) s += lexW / (rrfK + lr);
    }
    if (c.source !== "sparse") {
      const sr = sparseRankById.get(c.chunk_id);
      if (sr !== undefined) s += sparseW / (rrfK + sr);
    }
    if (c.source !== "temporal") {
      const tr = temporalRankById.get(c.chunk_id);
      if (tr !== undefined) s += 1 / (rrfK + tr);
    }
    return s;
  };
  // THE-398: convex-combination fusion — min-max normalize each stream's RAW scores over its own
  // per-query pool (seed cosine, expansion cos·decay, negated bm25, sparse dot) and fuse with one
  // alpha between the semantic and lexical sides. Presence in a stream a candidate is absent from
  // contributes 0. Everything downstream (diversification, gated rerank) is shared with graph_rrf.
  const isConvex = fusionMode === "convex";
  let scoreOf: (c: Candidate) => number = rrf;
  if (isConvex) {
    const alpha = Math.min(1, Math.max(0, opts.convex?.alpha ?? 0.7));
    const seedNorm = minMaxNorm(seeds.map((s) => [s.chunk_id, s.score] as const));
    const expNorm = minMaxNorm([...expSimById.entries()]);
    const lexNorm = minMaxNorm([...lexScoreById.entries()]);
    const sparseNorm = minMaxNorm([...sparseScoreById.entries()]);
    // THE-221/THE-398: the temporal stream sits OUTSIDE the lexical-vs-semantic alpha split (date
    // evidence is neither axis) — mirror RRF's unconditional temporal term so a temporal-only
    // candidate isn't scored 0 and sunk under convex fusion. Empty (hence a no-op) whenever the
    // temporal stream is off.
    const tempNorm = minMaxNorm(
      [...temporalRankById.entries()].map(([id, tr]) => [id, 1 / (rrfK + tr)] as const),
    );
    scoreOf = (c) =>
      alpha * ((seedNorm.get(c.chunk_id) ?? 0) + (expNorm.get(c.chunk_id) ?? 0)) +
      (1 - alpha) * ((lexNorm.get(c.chunk_id) ?? 0) + (sparseNorm.get(c.chunk_id) ?? 0)) +
      (tempNorm.get(c.chunk_id) ?? 0);
  }
  // Frontmatter metadata prior (authority boost), POST-FUSION and off by default. Adds a clamped
  // Σ(rule boost) to each candidate's fused score, composing ADDITIVELY with the base (rrf/convex)
  // score — which already carries the expansion decay. The clamp caps |boost| at a fraction of the
  // observed fused-score SPREAD, so the prior only tie-breaks: it can reorder near-neighbours but
  // never lifts a low-RRF note past a confident hit. Empty rules or disabled leaves scoreOf untouched
  // (exact no-op — byte-identical order).
  const mp = opts.metadataPrior;
  const priorRules = mp?.rules ?? [];
  let scoreOfWithPrior = scoreOf;
  if ((mp?.enabled ?? false) && priorRules.length > 0) {
    const fmByPath = loadFrontmatter(db, opts.vaultId, [...new Set(candidates.map((c) => c.path))]);
    const rawBoostById = new Map<string, number>();
    for (const c of candidates) {
      const fm = fmByPath.get(c.path);
      if (!fm) continue;
      let sum = 0;
      for (const r of priorRules) if (fm[r.field] === r.value) sum += r.boost;
      if (sum !== 0) rawBoostById.set(c.chunk_id, sum);
    }
    if (rawBoostById.size > 0) {
      // Spread of the BASE fused scores over this query's candidate pool — the yardstick the boost
      // must stay under to remain sub-dominant.
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const c of candidates) {
        const s = scoreOf(c);
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const spread = max - min;
      const clampFraction = mp?.clampFraction ?? DEFAULT_META_PRIOR_CLAMP;
      const boostById = new Map<string, number>();
      for (const [id, raw] of rawBoostById) {
        boostById.set(id, clampMetadataBoost(raw, spread, clampFraction));
      }
      scoreOfWithPrior = (c) => scoreOf(c) + (boostById.get(c.chunk_id) ?? 0);
    }
  }
  const sourceRank: Record<Candidate["source"], number> = {
    seed: 0,
    lexical: 1,
    sparse: 2,
    expansion: 3,
    temporal: 4,
  };
  const fused = [...candidates].sort((a, b) => {
    const d = scoreOfWithPrior(b) - scoreOfWithPrior(a);
    if (d !== 0) return d;
    if (a.source !== b.source) return sourceRank[a.source] - sourceRank[b.source];
    return a.streamRank - b.streamRank;
  });
  return { fused, scoreOfWithPrior, isConvex };
}

// THE-398: min-max normalize a stream's raw scores to [0,1] over its own per-query pool. A
// single-member (or constant-score) stream normalizes to 1 — presence in the stream is evidence.
function minMaxNorm(entries: Array<readonly [string, number]>): Map<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 0) return out;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [, v] of entries) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  for (const [id, v] of entries) out.set(id, max > min ? (v - min) / (max - min) : 1);
  return out;
}

/** Sub-dominance clamp for the metadata prior: bound |raw Σboost| to `clampFraction` of the fused
 *  score `spread`. clampFraction is itself clamped to [0,1] (a >1 fraction would let the prior
 *  dominate; <0 is meaningless). With clampFraction<1 the returned magnitude is strictly below the
 *  spread, so no candidate can move more than that in score — a bottom candidate boosted to the cap
 *  still lands below the un-boosted top candidate. Symmetric so a negative (penalty) rule is bounded
 *  the same way. Exported for the sub-dominance unit test. */
export function clampMetadataBoost(raw: number, spread: number, clampFraction: number): number {
  const frac = Math.min(1, Math.max(0, clampFraction));
  const cap = Math.max(0, spread) * frac;
  return Math.max(-cap, Math.min(raw, cap));
}

// Metadata prior input: parsed notes.frontmatter (JSON object) per note path, string-valued fields
// only (rules compare string === string). Missing notes table / column, or unparseable JSON, yields
// no entry for that path — the prior then contributes nothing for it (a silent no-op, never a throw).
function loadFrontmatter(
  db: Database,
  vaultId: string,
  paths: string[],
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (paths.length === 0) return out;
  const CHUNK = 500;
  try {
    for (let i = 0; i < paths.length; i += CHUNK) {
      const slice = paths.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT path, frontmatter FROM notes WHERE vault_id = ? AND path IN (${placeholders})`,
        )
        .all(vaultId, ...slice) as Array<{ path: string; frontmatter: string | null }>;
      for (const r of rows) {
        if (!r.frontmatter) continue;
        try {
          const parsed = JSON.parse(r.frontmatter) as Record<string, unknown>;
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") fields[k] = v;
          }
          out.set(r.path, fields);
        } catch {
          // Unparseable frontmatter — skip this note (contributes no boost).
        }
      }
    }
  } catch {
    // notes table / frontmatter column not present on this connection — prior no-ops.
    return new Map();
  }
  return out;
}
