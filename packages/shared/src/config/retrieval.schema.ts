// WP1.3: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — was Zod-only until THE-1078; see below.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. THE-1078 added the first superRefine in this
// file, on citationInfer.judge — a same-object cross-field check (provider/model/threshold), not
// a cross-domain read, so it stays here rather than moving to config.schema.ts's own superRefine.
// It also added the first non-Zod import, `isLoopbackHost` from `../net-host` — a dependency-free
// leaf util (same category as Zod itself, not a schema module), reused rather than reimplemented
// for citationInfer.judge.baseUrl's https-unless-loopback check. THE-1084 review round 1 replaced
// this file's own hand-rolled `://`-requiring regex parser with `classifyJudgeBaseUrl` (also
// `../net-host`) after that regex rejected a WHATWG-valid-but-non-canonical URL
// ("http:evil.example/path") as unparseable, and the refine below treated "unparseable" as "not
// remote http" — see classifyJudgeBaseUrl's own doc comment. The doctor warning
// (doctor/citation-judge.ts) and the runtime builder (experiential/citation-judge.ts) now call the
// SAME function, so all three can never classify one baseUrl three different ways again.
import { z } from "zod";
import { classifyJudgeBaseUrl } from "../net-host";

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
          "Which hardness rule gates the rerank: absolute top-1 cosine, or the model-agnostic z-margin. Default `cosine` preserves the shipped behaviour; `zMargin` is a model-agnostic alternative that has never been the production default.",
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
      "Adaptive per-stream RRF weighting: tilts dense vs lexical/sparse stream weight by per-query lexical specificity. Off by default.",
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
      "In-process query-product cache. Off by default; a hit requires the same caller, query, vault generation and retrieval configuration.",
    ),
  /** THE-628 (first PR): note-level (leaf) summary tier for global/thematic queries a chunk-only
   *  index has no answer for ("what are the main themes in my vault"). A summary is generated per
   *  note at index time (gateway `extract` role), embedded, and stored in `note_summaries` keyed on
   *  the SAME content_hash that gates re-embedding — an unchanged note is never re-summarized.
   *  Surfaced as a `source: "summary"` candidate stream in assembleCandidates, ACL-filtered exactly
   *  like a chunk (a summary whose source note the caller cannot read is excluded).
   *
   *  DARK by default (`enabled: false`): this ships the MECHANISM only. The ticket's mandatory
   *  pre-registered global-query eval (a new golden slice + comprehensiveness/diversity win-rate —
   *  the canonical n=250 golden set has zero global queries and cannot detect this feature's
   *  effect) is a separate, later deliverable that gates flipping this to true. Flag OFF means
   *  index-time summarization makes ZERO gateway calls and the candidate stream is never populated
   *  — byte-identical to today on both the index and retrieval paths. */
  summaries: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Generate + retrieve note-level summaries. Off ships the mechanism dark: zero gateway calls at index time, no summary candidates at retrieval time. Gated on a pre-registered global-query eval, not built here.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Gateway model alias override for the extract-role summarization call. Omitted -> the gateway's configured extract-role model (see gateway.models.extract).",
        ),
      maxConcurrency: z
        .number()
        .int()
        .positive()
        .default(12)
        .describe(
          "In-flight extract() calls during a summarization pass, so a large first index does not fan out one request per note unbounded. 8-16 is the recommended range (research brief).",
        ),
      /** THE-628 (second PR): the cluster-level (tier-2) summary tier — RAPTOR-style, over tier-1's
       *  note_summaries embeddings (kmeans, search/cluster.ts). Generated by the OFFLINE
       *  `obsidian-tc cluster` cadence, NOT per-write (search/indexing/summarize-clusters.ts).
       *  Surfaced as a `source: "cluster_summary"` candidate stream, gated by this SEPARATE
       *  `clusters.enabled` flag rather than reusing the note-level `enabled` above — deliberately,
       *  because a cluster summary spans MULTIPLE notes with potentially DIFFERENT ACL, a strictly
       *  broader leak surface than a single-note summary (see search/cluster-summaries.ts's
       *  searchClusterSummaries for the mixed-ACL filter this flag governs). DARK by default
       *  (`enabled: false`): the SAME mandatory pre-registered global-query eval that gates the
       *  note-level flag gates this one — a separate, later deliverable, not built here. */
      clusters: z
        .object({
          enabled: z
            .boolean()
            .default(false)
            .describe(
              "Generate + retrieve cluster-level (tier-2/RAPTOR) summaries. Off ships the mechanism dark: zero gateway/embed calls at the offline cluster pass, no cluster_summary candidates at retrieval time. Gated on the SAME pre-registered global-query eval as the note-level tier.",
            ),
          maxConcurrency: z
            .number()
            .int()
            .positive()
            .default(12)
            .describe(
              "In-flight extract() calls across clusters during a cluster-summary pass. Same 8-16 recommended range as the note-level tier.",
            ),
        })
        .prefault({})
        .describe(
          "Cluster-level (tier-2) summary tier (mechanism only, dark by default). Independent enable flag from the note-level tier above — see this block's comment.",
        ),
    })
    .prefault({})
    .describe(
      "Note-level summary tier (mechanism only, dark by default). See the block comment for the eval gate this is built ahead of.",
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
  /** THE-1099 (GH #964 part 2): let `record_retrieval_feedback` — and only it, enumerated by name
   *  in mcp/visibility.ts's READ_ONLY_DERIVED_TELEMETRY_EXEMPT_TOOLS — bypass the `acl.readOnly`
   *  kill switch and `toolVisibility.requireReadOnly` hiding. Its writes land in
   *  `chunk_retrievals` in experiential.db, the derived-cognition plane (SECURITY.md; THE-563/564),
   *  never in authored vault content, so a caller that must keep the vault itself read-only can
   *  still close the retrieval-feedback loop the server's own instructions ask for.
   *
   *  Default false: nothing changes for an existing config. Requires `logRetrievals: true` as
   *  well — with it false there are no `chunk_retrievals` rows for feedback to update, so the
   *  exemption is inert and the tool stays hidden/blocked exactly as before. `write:workspace`
   *  stays required for scoped-JWT callers either way; this setting relaxes the read-only
   *  POLICIES, not authorization. */
  allowFeedbackInReadOnly: z
    .boolean()
    .default(false)
    .describe(
      "Exempt record_retrieval_feedback (only) from acl.readOnly and toolVisibility.requireReadOnly, because its writes are derived telemetry in experiential.db, never authored vault content. Default false. Needs logRetrievals: true as well — otherwise there is nothing for it to update and the exemption is inert. The write:workspace scope requirement is unchanged.",
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
   *  THE-891 item 2 (researched): ON-by-default local persistence with no egress is an accepted
   *  norm for a developer tool, not something that needs its own justification — VS Code's Local
   *  History, JetBrains' Local History, and Go's telemetry-in-local-mode all default to capturing
   *  locally without asking first. What separates that accepted class from the scandal class (a
   *  tool that turned out to be phoning captured content home, or capturing indefinitely with no
   *  visible off switch) is never the on/off default — it is three structural properties every
   *  precedent in the accepted class ships together:
   *
   *    1. Bounded retention on the captured content itself, not just "the feature can be turned
   *       off" — `captureRetentionDays` (default 30) below; the maintenance sweep redacts
   *       `args_json` on episodes past the window rather than leaving it to accumulate forever.
   *    2. A visible notice stating what is captured, where it lives, and how to turn it off —
   *       the one-time boot line in runtime/capture-first-run-notice.ts.
   *    3. A guard against the content silently leaving the machine through a channel the operator
   *       did not choose — doctor's `experiential.capture-location` check, which warns when
   *       cacheDir (where this content actually lives) resolves inside a vault root a sync client
   *       (iCloud Drive, Dropbox, Syncthing) might be watching.
   *
   *  Egress — sending captured content anywhere over the network — is what would need an opt-in
   *  gate; nothing in this codebase does that. `captureContent` only ever writes to a local
   *  SQLite file the poisoning defence's layer-1 scan already runs against on every capture
   *  (shipped 2026-07-11) and that is secret-scanned and size-capped before storage.
   *
   *  `securityProfile: "hardened"` sets this back to false anyway — retaining raw arguments is
   *  still the opposite of least-privilege, and a posture named for restraint should not inherit
   *  a capture default from the permissive one, mitigations or not. Same call as
   *  `sessions.traceContent`, decided together. */
  captureContent: z
    .boolean()
    .default(true)
    .describe(
      'Also persist each episode\'s raw parsed arguments, secret-scanned and size-capped, so work-memory carries what a call actually did rather than only that it happened. On under the trusted-local posture, paired with bounded retention (captureRetentionDays), a one-time boot notice, and a doctor check against vault-adjacent storage — the mitigation set every accepted local-persistence precedent (VS Code/JetBrains Local History, Go local-mode telemetry) ships together. `securityProfile: "hardened"` turns it off, as does setting it false explicitly.',
    ),
  /** THE-891 item 1: bounded retention on the raw content `captureContent` writes.
   *
   *  Redaction, not deletion: the maintenance sweep sets `args_json` (and nothing else — the
   *  episode row, its action-axis columns, and eligibility/trust stay intact) to NULL on every
   *  episode older than this window, live or dead. Counters, corpus size, and episode history all
   *  survive; only the raw tool-call arguments age out. This is deliberately narrower than
   *  `maintenance.episodesRetentionDays`, which governs whether the ROW itself is ever deleted (and
   *  only for already-dead rows) — that is a work-memory retention question, this is a
   *  storage-limitation question about the CONTENT axis specifically, EDPB Art. 5(1)(e)'s "kept no
   *  longer than necessary" principle applied to a field rather than a record: how long a captured
   *  argument stays useful for "what did this call actually do" is a much shorter horizon than how
   *  long the fact that a call happened stays useful.
   *
   *  0 disables the sweep entirely (unlimited retention) — an explicit power-user opt-out, not a
   *  degraded state; the same vocabulary `securityProfile`'s other numeric floors use for "off". */
  captureRetentionDays: z
    .number()
    .int()
    .min(0)
    .default(30)
    .describe(
      "Days a captured episode's raw args_json is kept before the maintenance sweep redacts it to NULL. The episode ROW is never deleted by this — only the content axis ages out, matching agent_episodes' action-axis history staying complete. 0 disables the sweep (unlimited retention). Independent of maintenance.episodesRetentionDays, which governs row deletion for already-dead episodes only.",
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
      "Apply the ACT-R cached-activation-score signal to graph search ranking: builds the lookup, threads it to every M7 graphSearch call, and enables the bounded bubble pass that composes it into the fused order (each item moves at most one position). Ships off; the A/B that would justify turning it on has not shipped.",
    ),
  /** THE-644: fold the RETRIEVAL-level citation verdict (`chunk_retrievals.citation_state` /
   *  `cited_in_response`) into the deterministic `preferred.search_mode` counter alongside the
   *  existing episode-level `task_result` evidence — so a search-family tool whose results are
   *  actually CITED strengthens the same key an episode-level success already strengthens, and one
   *  whose results are retrieved but REJECTED weakens it. `feedback` (the ticket's original target)
   *  has zero producers; `citation_state` does not — THE-717's citation-inference pass stamps it on
   *  a live minority of rows once `citationInfer.enabled` is on.
   *
   *  RANKING-ADJACENT, so OFF BY DEFAULT like `activationRerank` above: `preferred.search_mode`
   *  values feed back into how future searches are chosen, so widening what writes it changes a
   *  learned signal without a pre-registered eval showing the new evidence source helps. Flipping
   *  this on with `citationInfer` never enabled is a legal but inert combination — no row ever
   *  carries a citation verdict, so the extra evidence source finds nothing and behaviour stays
   *  byte-identical to off. */
  citationPreferences: z
    .boolean()
    .default(false)
    .describe(
      "Fold chunk_retrievals citation verdicts (citation_state / cited_in_response) into the deterministic preferred.search_mode preference counter, alongside episode task_result evidence: a search-family tool whose retrievals are CONFIRMED cited strengthens the key, one whose retrievals are REJECTED weakens it. Off by default — ranking-adjacent, needs a pre-registered eval before defaulting on. Needs citationInfer.enabled (or another citation_state producer) to have any effect.",
    ),
  /** THE-726: `work_result` (the operator's first-person task-verdict tool) had exactly one caller —
   *  itself. Measured on the live store 14 days after deploy: 2 stamped rows (the smoke test)
   *  against 620 unstamped tool rows, 128 of them post-deploy. The derived-verdict pass (CLI
   *  `reflect` and the scheduled reflect tick) closes that gap by inferring a verdict from a closed
   *  session's tool-call log — always ON, always written, because it is real evidence for
   *  `extractPreferences` regardless of this flag.
   *
   *  This flag governs ONE thing: whether a DERIVED `-1` holds an episode out of promotion the same
   *  way an OPERATOR `-1` unconditionally does (reflect.ts's `partitionPending`). OFF by default,
   *  matching `activationRerank`/`citationPreferences` above — a structural inference (retries, a
   *  terminal error, an absent browse) is a different kind of evidence than a first-person
   *  judgement, and widening what silently withholds retrieval needs the same pre-registered review
   *  those flags require before defaulting on. With the flag off, a derived `-1` is written and
   *  feeds the preference extractor exactly like any other verdict; it just does not hold.
   *
   *  DEPENDENCY (owner-settled, THE-726 review round 1): this axis, and the derivation it gates,
   *  act only on sessions that EXIST and END. `session_id` attaches to a captured episode only when
   *  a session is open — over HTTP that needs `sessions.autoOpen` (default false) or an explicit
   *  `start_session`/`end_session` pair, and an implicit session opened that way is only ever closed
   *  by the maintenance sweep's `closeStaleImplicitSessions`. On plain stdio with no session concept
   *  in play, this flag has nothing to act on and the derivation is inert by design, not broken.
   *  Measured on the live Cave deployment (2026-09-03): 15 sessions since 2026-08-20, 13 implicit,
   *  12 already closed by the stale-session sweep, and 44 ended sessions carrying 249 derivable
   *  unstamped tool rows today — the trigger fires on that deployment's actual traffic shape. */
  derivedVerdictHold: z
    .boolean()
    .default(false)
    .describe(
      "Let a DERIVED task verdict (-1, inferred from a closed session's tool-call log — retries, a terminal error, no browse after search) hold an episode out of promotion the same way an OPERATOR work_result(-1) unconditionally does. Off by default: a derived -1 is still written and still feeds preferred.search_mode evidence, it just does not hold. The derivation itself always runs; this flag only governs whether its -1 verdicts gate retrieval. Dependency: the derivation acts only on sessions that exist and end (HTTP with sessions.autoOpen, or explicit start_session/end_session) — on stdio with no session concept in play it is inert by design.",
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
      /** THE-1078: opt-in judge PROVIDER for the stage-2 citation verdict, alongside the existing
       *  gateway chat judge (roles.judge). Absent -> exactly today's behaviour: the gateway's
       *  `judge` role when configured, or stage-1-only mode when it is not.
       *
       *  `typesafe` (EXPERIMENTAL) is a separate, opt-in judge PROVIDER over TypeSafe Jev's Noul
       *  question type (see gateway/typesafe.ts and experiential/citation-judge.ts) — a different
       *  service from the gateway's own `judge` role, selected here rather than by pointing the
       *  gateway role at a different model, because TypeSafe's request/response shape is not the
       *  chat-completions shape roles.judge speaks. `model` must be a PINNED, versioned id: Noul
       *  thresholds are tuned per model version, so a floating `-latest`/`-preview` alias could
       *  silently move the decision boundary underneath a threshold picked for a specific version.
       *  `threshold` has deliberately no default — a boundary tuned for one deployment's tolerance
       *  for false positives is not a safe default for another's, and TypeSafe's own customer
       *  agreement bars publishing the benchmark numbers that would justify picking one here. */
      judge: z
        .object({
          provider: z
            .enum(["gateway", "typesafe"])
            .default("gateway")
            .describe(
              'Which service answers the citation stage-2 verdict. "gateway" (default) reuses the existing gateway `judge` role, unchanged. "typesafe" (EXPERIMENTAL) calls TypeSafe Jev\'s Noul question instead of the gateway — a separate, opt-in judge provider for citation inference only.',
            ),
          model: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Required when provider is "typesafe": a PINNED, versioned TypeSafe model id (e.g. "jev-1.13.0"). Rejected at config-load if it ends in "-latest" or "-preview" — Noul thresholds are tuned per model version, and a floating alias would silently change the decision boundary under a fixed threshold.',
            ),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Required when provider is \"typesafe\": the Noul score (0..1) at or above which a chunk is judged cited. No default — TypeSafe thresholds are tuned per model version and per deployment's tolerance for false positives, and TypeSafe's customer agreement bars publishing the benchmark numbers that would justify picking one here.",
            ),
          apiKey: z
            .string()
            .optional()
            .describe(
              "TypeSafe API key. Secret — never logged or returned by a tool. An inline apiKey wins over apiKeyEnv.",
            ),
          apiKeyEnv: z
            .string()
            .min(1)
            .default("TYPESAFE_API_KEY")
            .describe(
              "Environment variable holding the TypeSafe API key, consulted when apiKey is not set inline.",
            ),
          baseUrl: z
            .string()
            .url()
            // The https-unless-loopback rule lives in the object-level superRefine below, not
            // here: it needs to see the sibling `allowPlainHttp` field, which a per-field .refine
            // on this string cannot reach.
            .default("https://api.typesafe.ai")
            .describe(
              "TypeSafe API base URL. Must be https:// unless the host is loopback (a local test/dev endpoint) or allowPlainHttp is set — this URL carries the bearer key and vault-derived text.",
            ),
          allowPlainHttp: z
            .boolean()
            .default(false)
            .describe(
              "Widen the https-unless-loopback rule on judge.baseUrl to allow ANY http:// host, not just loopback. Intended ONLY for a gateway reachable over a host-local docker network or an encrypted overlay (e.g. Tailscale) — such as the Cave LiteLLM gateway's pass-through endpoint (`http://litellm:4000/typesafe` inside the compose network) — never a plain internet path. The bearer key and vault-derived text still travel in clear over whatever link the URL names; this flag only asserts the operator has judged that link safe, it does not make the traffic safe.",
            ),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Per-attempt request timeout in ms for the TypeSafe client. Defaults to the client's own 60s.",
            ),
        })
        .superRefine((c, ctx) => {
          // This URL carries the bearer key (Authorization header) and vault-derived
          // source/response text in every request body — a plain `http://` endpoint would send
          // both in cleartext. Loopback stays allowed unencrypted for a local test/dev double,
          // the same carve-out `isLoopbackHost` already draws for the HTTP transport bind;
          // `allowPlainHttp` is a further, explicit opt-in for any other http:// host — and ONLY
          // http://, never any other non-https scheme (classifyJudgeBaseUrl's own doc comment).
          const cls = classifyJudgeBaseUrl(c.baseUrl);
          if (cls === "invalid") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["baseUrl"],
              message:
                'judge.baseUrl must be a canonical "scheme://host" URL with scheme https or http — either it could not be parsed that way, or its scheme is neither (e.g. ftp:/file:). allowPlainHttp only ever widens http:// on a non-loopback host, never any other scheme.',
            });
          } else if (cls === "http-remote" && !c.allowPlainHttp) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["baseUrl"],
              message:
                "judge.baseUrl must use https:// — this URL carries the bearer key and vault-derived source/response text — unless the host is loopback (localhost/127.0.0.1/[::1]) for a local test or dev endpoint, or judge.allowPlainHttp is explicitly set to opt into a trusted plain-http path (e.g. a host-local gateway or an encrypted overlay).",
            });
          }
          // Scoped to provider "typesafe" ONLY: the gateway's own `judge` role is free to name
          // any model string it likes (that is the gateway's contract, not this block's), so this
          // predicate must not reject a `model` set here while `provider` stays "gateway".
          if (c.provider === "typesafe") {
            if (!c.model) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["model"],
                message:
                  'judge.model is required when judge.provider is "typesafe" — pin a versioned model id (e.g. "jev-1.13.0").',
              });
              // POSITIVE predicate, not a blacklist: a bare `endsWith("-latest"/"-preview")`
              // check let an equally floating "jev" or "totally-unversioned" straight through.
              // Require a dotted numeric version suffix instead ("-1.13.0" or "-1.13") — that
              // rejects "jev", "jev-latest" and "jev-preview" alike, and any other unversioned or
              // alias-versioned spelling, without needing to name every alias TypeSafe might ship.
            } else if (!/-\d+\.\d+(?:\.\d+)?$/.test(c.model)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["model"],
                message: `judge.model "${c.model}" is not a pinned, versioned id — it must end in a dotted numeric version such as "-1.13.0" or "-1.13" (e.g. "jev-1.13.0"); a floating alias like "-latest"/"-preview" (or no version at all) can silently move the decision boundary underneath a fixed threshold.`,
              });
            }
            if (c.threshold === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["threshold"],
                message:
                  'judge.threshold is required when judge.provider is "typesafe" (0..1) — no default exists; Noul thresholds are tuned per model version and per deployment.',
              });
            }
          }
        })
        .optional()
        .describe(
          "Opt-in judge provider for the citation-inference stage-2 verdict. Absent -> today's behaviour unchanged (the gateway `judge` role when configured, or stage-1-only mode).",
        ),
    })
    .prefault({})
    .describe(
      "Scheduled citation-inference pass over a transcript index. Needs an out-of-tree producer for transcriptIndex — no MCP surface gives a server the assistant's answer.",
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
      "Scheduled coverage-gap sweep over recently logged queries. Advisory only — nothing auto-tunes retrieval config from its own gap measurements.",
    ),
  /** THE-634: the scheduled proactive-advisory sweep — the caller `scoreAgainstGoals` +
   *  `selectAdvisories` (PR #779, `experiential/advisory.ts` + `experiential/advisory-policy.ts`)
   *  never had. Same shape as citationInfer/gapSweep above and the same lesson: correct code,
   *  complete tests, no scheduled caller means `chunk_retrievals` never gets an advisory row and
   *  nothing is ever surfaced. PR #779 itself deferred this block for exactly that reason — a first
   *  draft declared it and `check-config-threading` refused it as unread.
   *
   *  OFF BY DEFAULT, and unlike gapSweep/citationInfer this is not (only) a cost decision — it is a
   *  precision one. The ticket's own words: "A proactive system that is wrong 30% of the time is
   *  worse than no proactive system, because users learn to dismiss it and then miss the 70%." This
   *  repo has already measured two plausible retrieval ideas to null (THE-532) and negative
   *  (THE-448, -0.047 nDCG@10); a proactivity heuristic with no eval has a SOFTER evidentiary basis
   *  than either. Ship dark, measure, then decide. */
  proactive: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Run the scheduled proactive-advisory sweep: score recent vault activity (changed notes, open contradictions, recent syntheses) against open goals and surface the top candidates to connected sessions. Off by default — see the block-level comment for why this is a precision decision, not only a cost one.",
        ),
      minScore: z
        .number()
        .min(0)
        .max(1)
        .default(0.6)
        .describe(
          "Below this goal-similarity score, a candidate is not worth interrupting for. Precision over recall — the ticket's phrase, not a paraphrase.",
        ),
      topK: z
        .number()
        .int()
        .positive()
        .max(10)
        .default(2)
        .describe(
          'Hard cap on advisories surfaced per sweep, per session. The ticket: "Surface the top 1-2 items, never a digest."',
        ),
      maxPerSession: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(5)
        .describe(
          "Hard cap on advisories a single session may receive in total before dismissal decay reduces it further.",
        ),
      dismissalPenalty: z
        .number()
        .min(0)
        .max(100)
        .default(1)
        .describe(
          "Budget removed per dismissal (a -1 stamped through record_retrieval_feedback on an advisory row). At 1, five dismissals exhaust a maxPerSession of five.",
        ),
    })
    .prefault({})
    .describe(
      "Scheduled proactive-advisory sweep over goal-anchored candidates (vault-watcher note changes, open contradictions, recent syntheses). Publishes into subscriptions/listen for modern-era (2026-07-28) sessions only; legacy-era sessions — the LiteLLM-fronted production majority — receive no delivery attempt, by design. See docs/MCP-COMPATIBILITY.md.",
    ),
});
export type ExperientialConfig = z.infer<typeof ExperientialConfigSchema>;

/** THE-1099 (GH #964 part 2): the ONE place `allowFeedbackInReadOnly && logRetrievals` is
 *  computed — every consumer (server-runtime.ts's `toolVisibility.allowReadOnlyDerivedTelemetry`
 *  wiring, boot-notices.ts's boot-line) calls this rather than restating the AND, so the two can
 *  never read different answers to "is the exemption live right now". `logRetrievals` is required
 *  because with it false there are no `chunk_retrievals` rows for `record_retrieval_feedback` to
 *  update — the exemption would be live but inert, which is a confusing thing for a boot line or
 *  a dispatch decision to imply. */
export function isFeedbackExemptFromReadOnly(
  experiential: Pick<ExperientialConfig, "allowFeedbackInReadOnly" | "logRetrievals">,
): boolean {
  return experiential.allowFeedbackInReadOnly && experiential.logRetrievals;
}
