// WP1.3: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. There are no refine/superRefine blocks in this
// span to place — all four schemas below are plain z.object() definitions.
import { z } from "zod";

/** THE-397: retrieval-fusion knobs (the first config-exposed retrieval section). */
export const RetrievalConfigSchema = z.object({
  /** RRF constant for graph_rrf fusion. Keep BELOW the stream pool size (~30): larger k lets
   *  overlapping low-rank noise outrank confident single-stream hits (measured: 10 beats 60 on
   *  every metric at n=32; 20 is indistinguishable from 60). */
  rrfK: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Reciprocal-rank-fusion constant for graph_rrf. Keep BELOW the stream pool size (~30): a larger k lets overlapping low-rank noise outrank confident single-stream hits.",
    ),
  /** THE-258: the deterministic class router (temporal auto-stream, lexical short-circuit
   *  that skips the embedding round-trip; standard falls through unchanged). DARK by
   *  default — flips only after the per-class + aggregate A/B passes the ship rule. */
  classRouter: z
    .boolean()
    .default(false)
    .describe(
      "Enable the deterministic query-class router: a temporal auto-stream and a lexical short-circuit that skips the embedding round-trip. Ships dark pending an A/B on the golden set.",
    ),
  /** Serve-path bge-m3 learned-sparse RRF stream. When on AND the embeddings provider emits the
   *  multi-vector heads (embedFull: bge-m3 or model-tier), each query is also encoded to its sparse
   *  weights and fused as the "sparse" RRF stream. OFF by default - opt-in, measured on the golden
   *  set before shipping on (a no-op without a multi-vector provider). */
  sparse: z
    .boolean()
    .default(false)
    .describe(
      "Fuse a bge-m3 learned-sparse stream into RRF at serve time. A no-op unless the embeddings provider emits the multi-vector heads (bge-m3 or model-tier).",
    ),
  /** Serve-path bge-m3 ColBERT late-interaction rerank of the fused top-K. When on AND the provider
   *  emits the multi-vector heads, the query ColBERT matrix reranks the top-K by maxSim. OFF by
   *  default - opt-in, measured on the golden set (a no-op without a multi-vector provider). */
  colbert: z
    .boolean()
    .default(false)
    .describe(
      "Rerank the fused top-K by bge-m3 ColBERT late-interaction maxSim. A no-op unless the provider emits the multi-vector heads.",
    ),
  /** THE-394/THE-591: gated cross-encoder rerank of the fused top-K (graph_rrf/convex). Reranks
   *  ONLY hard queries (seed-strength router silent AND a weak top-1 seed) through the model-tier
   *  BGE cross-encoder (bge-reranker-v2-m3) when configured, else the gateway /rerank passthrough.
   *  Until this flag existed the gate (rerank_stage.ts) was only reachable from the eval harness's
   *  `--gated-rerank` flag — OFF by default, and stays off pending a golden-set result (claim bar
   *  80%): the cheap cross-encoder path has never been proven to beat plain RRF in production. */
  gatedRerank: z
    .boolean()
    .default(false)
    .describe(
      "Gate a cross-encoder rerank of the fused top-K onto hard queries only (weak top-1 seed, router silent). A no-op without a configured reranker (model-tier BGE or the gateway /rerank passthrough).",
    ),
  /** THE-806: the hardness rule `gatedRerank` uses, and the ONLY way to reach it from config.
   *
   *  Until this existed, `hardZ`/`hardTop1` were `GraphSearchOptions` fields with no config
   *  surface, and the only non-test code that set either was `eval/run.ts`. Production sent
   *  `{ enabled: true }` and therefore ALWAYS took the absolute-cosine branch; the harness sent
   *  `{ enabled: true, hardZ: 1.0 }` and therefore ALWAYS took the z-margin branch. **The two arms
   *  ran different gates by construction**, so any golden-set result for `--gated-rerank` measured
   *  a code path production could not execute — the THE-699 shape.
   *
   *  Defaults reproduce today's production behaviour EXACTLY (`cosine` at 0.55, pool 20), so this
   *  block changes no ranking on its own. Flipping `mode` is a ranking change and owes the paired
   *  permutation gate at n=250 — THE-400's unmet acceptance (Z1 calibration per backbone, then the
   *  A/B) is what decides the default, not this schema. */
  gatedRerankHardness: z
    .object({
      /** `cosine` = `top1 < hardTop1` (absolute, model-specific — the 0.55 gate fired 0/32 on
       *  nomic). `zMargin` = `zMargin < hardZ` (distribution-relative, model-agnostic). */
      mode: z
        .enum(["cosine", "zMargin"])
        .default("cosine")
        .describe(
          "Which hardness rule gates the rerank: absolute top-1 cosine, or the model-agnostic z-margin. Default `cosine` preserves the shipped behaviour; `zMargin` is what THE-400 built and has never been the production default.",
        ),
      hardTop1: z
        .number()
        .min(0)
        .max(1)
        .default(0.55)
        .describe("Cosine mode: a query is hard when the top-1 seed cosine is below this."),
      hardZ: z
        .number()
        .default(1.0)
        .describe(
          "z-margin mode: a query is hard when the top-1 z-score over the seed-cosine pool is below this. 1.0 matches the eval harness's long-standing default.",
        ),
      pool: z
        .number()
        .int()
        .positive()
        .default(20)
        .describe("How many fused candidates the reranker sees on a hard query."),
    })
    .prefault({})
    .describe(
      "The hardness rule behind `gatedRerank`, and the only config path to it. Defaults reproduce the shipped behaviour exactly; changing `mode` is a ranking change that owes an eval gate.",
    ),
  /** Graph densification (graphify spec-donor port): derived edges added to vault_edges beyond the
   *  literal wikilink layer, to reach multi-hop targets whose bridge notes are not explicitly linked.
   *  All OFF by default and measured on the multi-hop golden set before any flip — the THE-135
   *  frontier-leaf virtual-hop hit an 80% bridge-recall ceiling and the champion is already past it,
   *  so densification ships dark unless it wins. See docs/plans/2026-07-13-graph-densification.md. */
  /** THE-393/THE-693: the capped graph-expansion stream — expand only from the strongest seeds,
   *  cap neighbours per seed, and drop high-degree hub nodes so a weak or high-degree seed cannot
   *  flood the fused ranking ("hub drift" / structural flooding). Index/dashboard/audit pages are
   *  exactly the high-degree offenders.
   *
   *  This existed as a GraphSearchOptions field for a long time with NO config surface at all: it
   *  was read by graph_expansion.ts but the only code that ever set it was eval/run.ts, so the
   *  defence was unreachable in production and `config validate` accepted
   *  `retrieval.graphStream.enabled` silently while it reached nothing (THE-693).
   *
   *  Measured on this vault at n=250: enabling the hard cap is NOT a quality win — 0 of 8 metrics
   *  significant after BH-FDR — but it is NON-INFERIOR on nDCG@10 (95% lower bound -0.002 vs a
   *  -0.015 floor) and removes ~22% of the expansion candidate pool, since 104 over-cap nodes
   *  (8.35% of the graph) generate 21.83% of expansion candidates. Off by default: that is a
   *  cost argument, and it is corpus-specific. */
  graphStream: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Enable the capped graph-expansion stream. Off by default: measured neutral on ranking quality (0 of 8 metrics significant at n=250) though non-inferior, so this is a cost lever rather than a quality one.",
        ),
      /** Expand only from the top-N seeds by score. */
      expansionSeeds: z
        .number()
        .int()
        .positive()
        .default(8)
        .describe("Expand only from the top-N seeds by score."),
      /** Max expansion candidates contributed by any one seed. */
      perSeedCap: z
        .number()
        .int()
        .positive()
        .default(3)
        .describe("Maximum expansion candidates any single seed may contribute."),
      /** Drop expansion candidates whose AUTHORED degree exceeds this. Counts literal edges only —
       *  counting derived edges let densification sabotage itself by inflating every degree. */
      hubDegreeCap: z
        .number()
        .int()
        .positive()
        .default(40)
        .describe(
          "Drop expansion candidates whose authored degree exceeds this, so index and dashboard pages cannot flood the fused ranking. Counts literal edges only — counting derived edges would let densification inflate every degree and suppress the bridges it exists to surface.",
        ),
    })
    .prefault({})
    .describe(
      "Capped graph-expansion stream: expand from the top seeds only, cap neighbours per seed, and drop high-degree hub nodes so index/dashboard pages cannot flood the fused ranking. Off by default — measured neutral on quality, but it removes ~22% of the expansion candidate pool.",
    ),
  densify: z
    .object({
      /** Emit shared-frontmatter-tag co-occurrence edges (edge_type shared_tag). */
      tagEdges: z
        .boolean()
        .default(false)
        .describe("Emit shared-frontmatter-tag co-occurrence edges (edge_type shared_tag)."),
      /** A tag on more than this many notes is a hub, not a signal — it emits no edges. */
      maxTagFanout: z
        .number()
        .int()
        .positive()
        .default(25)
        .describe(
          "A tag applied to more notes than this is treated as a hub rather than a signal and emits no edges.",
        ),
      /** Emit vec0 kNN semantic-neighbor edges (edge_type similar_to). Increment B. */
      knnEdges: z
        .boolean()
        .default(false)
        .describe("Emit vec0 kNN semantic-neighbour edges (edge_type similar_to)."),
      /** Neighbors per note for knnEdges. */
      knnK: z
        .number()
        .int()
        .positive()
        .default(8)
        .describe("Number of neighbours per note when knnEdges is enabled."),
      /** Drop knnEdges below this cosine similarity. 0 (default) keeps every neighbor the kNN returns.
       *  Exposed because the ablation tested a 0.80 floor that was not, until now, a selectable config. */
      knnMinSim: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
          "Drop kNN edges below this cosine similarity. 0 keeps every neighbour the kNN returns.",
        ),
      /** Let the graph walk traverse derived edges, down-weighted vs authored links. Increment C. */
      includeInWalk: z
        .boolean()
        .default(false)
        .describe(
          "Let the graph walk traverse derived edges, down-weighted against authored links.",
        ),
      /** Down-weight factor for expansion reached via a derived edge (annotate, not gate). */
      derivedWeight: z
        .number()
        .positive()
        .default(0.5)
        .describe(
          "Down-weight factor applied to expansion reached via a derived edge. Annotates the score rather than gating the edge.",
        ),
      /** Build LLM-inferred semantic edges (semantically_similar_to) via the local gateway.
       *  Batch-only (the densify-llm runner, not the inline index pass) — it sends note content to
       *  the model, local by default. OFF. */
      llmEdges: z
        .boolean()
        .default(false)
        .describe(
          "Build LLM-inferred semantic edges (semantically_similar_to) via the configured gateway. Batch-only, and it sends note content to the model — local by default.",
        ),
      /** Minimum discrete-rubric confidence to keep an LLM edge. */
      confidenceFloor: z
        .number()
        .min(0)
        .max(1)
        .default(0.55)
        .describe("Minimum discrete-rubric confidence required to keep an LLM-inferred edge."),
    })
    .prefault({})
    .describe(
      "Graph densification: derived edges added beyond the literal wikilink layer to reach multi-hop targets whose bridge notes are not explicitly linked. All off by default.",
    ),
  /** THE-391/THE-536: tilt the per-stream RRF weights by the query's lexical specificity — rare
   *  terms trust the BM25/sparse ranks, common-vocabulary queries trust the dense seeds. Neutral
   *  (static RRF) when disabled, when the specificity signal is unavailable, or at specificity
   *  0.5. Implemented and unit-tested (fusion.ts) and reachable from the eval harness
   *  (`--adaptive-rrf`) since THE-391, but had no config surface until now. OFF by default — no
   *  ranking change ships with this flag; it only makes an already-measured lever reachable. */
  adaptiveRrf: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe("Enable the adaptive per-stream RRF weighting tilt. Off by default."),
      gain: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Strength of the tilt, clamped to [0,1] so stream weights stay within [0,2] — an over-unity gain would drive a weight negative and invert its ranking rather than just reweight it.",
        ),
    })
    .prefault({})
    .describe(
      "Adaptive per-stream RRF weighting (THE-391): tilts dense vs lexical/sparse stream weight by per-query lexical specificity. Off by default.",
    ),
  /** THE-497: the in-process query-product cache. Keyed by the vault generation (THE-496) + the
   *  caller's ACL fingerprint + the query text + the full retrieval option set, so a hit is only
   *  ever the SAME caller re-asking the SAME question of an UNCHANGED vault under the SAME
   *  configuration. It is a latency optimisation with no intended effect on results.
   *
   *  Ships OFF. Not because the key is doubted — it has an adversarial cross-principal test and a
   *  structural gate that fails when a new retrieval option is not covered — but because "results
   *  are unchanged" is exactly the claim a cache can be wrong about, and a wrong hit is invisible
   *  where a wrong ranking is merely worse. Flip after a perf-gate run on a real vault. */
  cache: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Cache query encodings and graph-search results in process, keyed by vault generation + caller ACL fingerprint + query + retrieval config. A latency optimisation only; off by default.",
        ),
      maxEntries: z
        .number()
        .int()
        .positive()
        .default(64)
        .describe(
          "Maximum live entries per cache (results and query encodings are counted separately). Results carry chunk content, so this is the memory bound.",
        ),
      ttlSeconds: z
        .number()
        .positive()
        .default(60)
        .describe(
          "Entry lifetime. Bounds staleness from inputs the key cannot see: wall-clock recency decay, and derived state (densified edges, activation scores) written by jobs that do not bump the vault generation.",
        ),
    })
    .prefault({})
    .describe(
      "THE-497 in-process query-product cache. Off by default; a hit requires the same caller, query, vault generation and retrieval configuration.",
    ),
});

/** Metadata-prior (authority-boost) rule: add `boost` to the fused score of a result whose note
 *  frontmatter[field] === value. Ported from the retired KMS/vault-sync hardcoded prior
 *  (knowledge-mcp-server/migrations/009_vault_search_priority.sql, itself from
 *  vault-sync/sql/004_vault_search_priority.sql): additive boosts on top of the RRF hybrid score.
 *  `boost` may be negative (an archive-style penalty). */
export const MetadataPriorRuleSchema = z.object({
  field: z.string().min(1).describe("Frontmatter field name to test on a candidate note."),
  value: z.string().describe("Value that frontmatter[field] must equal for the boost to apply."),
  boost: z
    .number()
    .describe(
      "Amount added to the fused score on a match. May be negative, which makes the rule an archive-style penalty.",
    ),
});

/** Config-driven ranking overlays applied POST-FUSION in graph_search (tie-breaks, never overrides).
 *  All OFF by default and measured on the golden set before any flip. */
export const RankingConfigSchema = z.object({
  /** Frontmatter metadata prior (authority boost). When enabled, each result's fused score gains
   *  Σ(boost) over the rules whose note frontmatter[field]===value, then the list is re-sorted —
   *  composing ADDITIVELY with the expansion-stream decay. The total |Σboost| any single result can
   *  receive is clamped to `clampFraction` of the per-query fused-score spread, so the prior stays
   *  SUB-DOMINANT to the RRF signal (a tie-break, never an override — a low-RRF note cannot leapfrog
   *  a confident hit). OFF by default. */
  metadataPrior: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe("Apply the frontmatter authority-boost overlay after fusion."),
      rules: z
        .array(MetadataPriorRuleSchema)
        .default([])
        .describe("Field/value/boost rules summed for each result before the list is re-sorted."),
      /** Cap |Σboost| per result at this fraction of the observed fused-score spread (max−min over
       *  the per-query candidate pool). <1 guarantees sub-dominance: even a fully-boosted bottom
       *  result cannot overtake the top base-scored result. */
      clampFraction: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
          "Cap the absolute total boost per result at this fraction of the observed fused-score spread. Below 1 this guarantees the prior stays a tie-break: a fully boosted bottom result still cannot overtake the top base-scored one.",
        ),
    })
    .prefault({})
    .describe("Frontmatter metadata prior (authority boost) applied post-fusion in graph_search."),
});

/** THE-230: experiential-tier (membrane store, experiential.db) knobs. */
export const ExperientialConfigSchema = z.object({
  /** Append serve-path retrieval events (chunk id + rank + score + query text + surface) to
   *  chunk_retrievals in experiential.db — local-only telemetry that feeds the ACT-R activation
   *  recompute and flywheel usage stats. Eval-harness runs call the search cores directly and
   *  never log (THE-187 eval/serve hygiene). false keeps the experiential handle closed after
   *  boot provisioning (pre-THE-230 behavior). */
  logRetrievals: z
    .boolean()
    .default(true)
    .describe(
      "Append serve-path retrieval events (chunk id, rank, score, query text, surface) to experiential.db. Local-only telemetry feeding activation recompute and usage stats; eval runs never log.",
    ),
  /** THE-228: capture every dispatch outcome as an agent_episodes row (action axis: tool,
   *  status, duration, sizes, hashes, attribution — no payloads). Local-only work-memory in
   *  experiential.db; the sleep-time evaluator stamps retrieval-eligibility. */
  captureEpisodes: z
    .boolean()
    .default(true)
    .describe(
      "Record every dispatch outcome as an agent_episodes row — tool, status, duration, sizes, hashes, attribution. No payloads are stored.",
    ),
  /** THE-228 content axis: also persist the raw parsed args (secret-scanned + size-capped)
   *  on each episode.
   *
   *  ON under trusted-local as of 2026-08-07. The capture-posture decision this had been deferring
   *  to was taken rather than discovered: the poisoning defence shipped 2026-07-11, its layer-1
   *  scan runs on every capture, args are secret-scanned and size-capped before storage, and the
   *  deployment is single-principal. What the default was actually resting on was an owner, not a
   *  control.
   *
   *  `securityProfile: "hardened"` sets this back to false — retaining raw arguments is the
   *  opposite of least-privilege, and a posture named for restraint should not inherit a capture
   *  default from the permissive one. Same call as `sessions.traceContent`, decided together. */
  captureContent: z
    .boolean()
    .default(true)
    .describe(
      'Also persist each episode\'s raw parsed arguments, secret-scanned and size-capped, so work-memory carries what a call actually did rather than only that it happened. On under the trusted-local posture; `securityProfile: "hardened"` turns it off, as does setting it false explicitly.',
    ),
  /** THE-644 item 3: the ACT-R decay exponent, finally reachable from configuration.
   *
   *  `actrActivation` has always taken a `decay` and every layer below the wiring forwarded it —
   *  `recomputeActivation(edb, now, { decay })` and `registerActivationRecompute`'s `deps.decay`
   *  both existed. Nothing ever SUPPLIED one, so the only way to change it was the eval harness's
   *  `seed-activation.ts --decay`, which is a script and not a shipped surface. The knob existed
   *  and had no handle.
   *
   *  DIRECTION, measured against `actrActivation` rather than assumed, because a backwards preset
   *  is worse than none. Weight decays as `days ** -decay`, so HIGHER decay means FASTER
   *  forgetting. A 30-day-old retrieval is worth:
   *
   *      decay 0.3 -> 0.36    slow forgetting, long memory
   *      decay 0.5 -> 0.18    the ACT-R literature default, and ours
   *      decay 0.8 -> 0.066   fast forgetting, recency-dominated
   *
   *  PRESETS, as practices rather than numbers: a heavily-cited reference vault wants ~0.3, where
   *  a note that mattered a month ago still counts; a daily journal or worklog wants ~0.8, where
   *  last week is what matters. 0.5 is the default and the right answer when unsure.
   *
   *  Bounded (0, 2]: 0 would make activation time-invariant, which is not decay at all, and past
   *  ~2 a two-day-old hit is already worth a quarter of a one-day-old one — beyond that the
   *  parameter stops expressing a practice and starts expressing a bug. */
  activationDecay: z
    .number()
    .gt(0)
    .max(2)
    .default(0.5)
    .describe(
      "ACT-R decay exponent for the activation recompute. Weight falls as days ** -decay, so HIGHER means faster forgetting: ~0.3 for a reference vault where month-old notes still count, 0.5 (default, the ACT-R literature value), ~0.8 for a journal where last week is what matters.",
    ),
  /** THE-187/193: builds the cached_activation_score lookup (activationFor) and threads it to every
   *  M7 graphSearch call site. THE-424 Part A additionally sets opts.bubbleSafe there, so this one
   *  flag now governs BOTH halves — the lookup and the ACT-R bubble pass that consumes it. Before
   *  Part A the flag built the lookup and changed no ranking, which is the defect THE-535 raised;
   *  it now does what its name says.
   *
   *  Still ships FALSE. The A/B that decides whether the default should move is THE-424 Part B
   *  (ship rule: paired permutation surviving BH-FDR AND dNDCG >= 0.010).
   *
   *  Turning it on closes a feedback loop —
   *  chunk_retrievals -> recomputeActivation -> cached_activation_score -> ranking -> chunk_retrievals
   *  — which damps rather than amplifies because the bubble pass moves any item at most one
   *  position and the multiplier is bounded to [0.8, 1.2] at the default k. The full argument sits
   *  at the wiring site (tools/m7/knowledge/retrieval-runtime.ts), next to the code it constrains. */
  activationRerank: z
    .boolean()
    .default(false)
    .describe(
      "Apply the ACT-R cached-activation-score signal to graph search ranking: builds the lookup, threads it to every M7 graphSearch call, and enables the bounded bubble pass that composes it into the fused order (each item moves at most one position). Ships off; the A/B that would justify turning it on is THE-424 Part B.",
    ),
  /** THE-717: the scheduled citation pass. `inferCitations` had exactly one caller — the offline
   *  `obsidian-tc citation-infer` CLI — so every citation column was NULL on 105 of 105 live rows:
   *  correct code, complete tests, no scheduled caller. Same shape as gapSweep below, and named
   *  after the same lesson.
   *
   *  OFF BY DEFAULT, and it needs an input nothing in this package produces. The pass scores
   *  retrieved chunks against the ASSISTANT'S answer, which no MCP surface hands to a server, so
   *  `transcriptIndex` points at a JSONL file some out-of-tree producer maintains. Without that
   *  path there is nothing to run and the handler is not registered — a job that can never do work
   *  should not appear to be scheduled. */
  citationInfer: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Run the citation-inference pass on a schedule over a transcript index. Off by default: it needs transcriptIndex, an input no MCP surface can produce on its own.",
        ),
      transcriptIndex: z
        .string()
        .optional()
        .describe(
          "Path to a JSONL transcript index — one object per retrieval ({vault, surface_type, query, retrieved_at, transcript}), whose transcript is already filtered to text produced AFTER retrieved_at. Absent disables the scheduled pass entirely.",
        ),
      intervalHours: z
        .number()
        .positive()
        .max(8760)
        .default(6)
        .describe(
          "Hours between scheduled passes when enabled. Defaults to 6: the pass costs gateway judge calls, and a retrieval's citation status is not time-sensitive once stamped.",
        ),
    })
    .prefault({})
    .describe(
      "THE-717: scheduled citation-inference pass over a transcript index. Needs an out-of-tree producer for transcriptIndex — no MCP surface gives a server the assistant's answer.",
    ),
  /** THE-719: the scheduled coverage-gap sweep. `detectGaps` had exactly one caller — the offline
   *  `obsidian-tc gaps` CLI — so `gap_reports` held 0 rows and the THE-611 read tool had nothing to
   *  read: correct code, complete tests, no scheduled caller.
   *
   *  OFF BY DEFAULT, and that is a cost decision rather than caution. Each swept query costs one
   *  embedding call plus one graphSearch; THE-616 capped that loop's concurrency for exactly this
   *  reason. Putting it on the maintenance cadence would make every deployment pay gateway traffic
   *  it did not ask for, so the sweep names its own interval and defaults to weekly when enabled. */
  gapSweep: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Run the coverage-gap sweep on a schedule, persisting a gap_reports row the gap_report tool can read back. Off by default: each swept query costs an embedding call plus a search.",
        ),
      intervalHours: z
        .number()
        .positive()
        .max(8760)
        .default(168)
        .describe(
          "Hours between sweeps when enabled. Defaults to weekly — a coverage gap is a slow-moving property of the corpus, not something worth re-measuring hourly.",
        ),
      maxQueries: z
        .number()
        .int()
        .positive()
        .max(500)
        .default(50)
        .describe(
          "Upper bound on queries per sweep. The sweep draws the most recent DISTINCT logged queries from chunk_retrievals, so this caps both gateway cost and how far back a single pass reaches.",
        ),
    })
    .prefault({})
    .describe(
      "THE-719: scheduled coverage-gap sweep over recently logged queries. Advisory only — nothing auto-tunes retrieval config from its own gap measurements.",
    ),
});
