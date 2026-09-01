// WP2 slice 1: the 11 output/result schema consts that used to sit at the top of
// knowledge-tools.ts, moved verbatim. See THE-417 Phase 1 (m7-tool-metadata-parity.test.ts pins
// the resulting tool metadata unchanged across this move).
//
// Exported from this leaf only as far as knowledge-tools.ts (the facade) needs them to build each
// tool's `outputSchema` — the facade itself re-exports none of these, so its own public surface
// (`rg '^export ' knowledge-tools.ts`) is unaffected by this file existing.
import { z } from "zod";
import { challengeOutputSchema } from "../../../plane/challenge";

// ---------------------------------------------------------------------------------------------
// THE-417 Phase 1: declared output contracts for m7.
//
// m7 is where the surface's shape inconsistency actually lives. THE-548 found three different
// "unavailable" returns across the tool surface; three of them are IN THIS FILE, and they are not
// the same shape as each other — only `{ vault, available: false, message }` is common. reflect
// adds mode/route/sources/answer, list_contradictions adds total/contradictions, and
// knowledge_challenge returns just the triple. Declaring each one is what makes that legible to a
// caller instead of something you learn by reading handlers.
//
// Written from the RETURN STATEMENTS, not from the types the data came from: several fields are
// renamed, derived, or conditionally spread on the way out, so a schema inferred from the source
// row/interface would be wrong. Conditional spreads (`...(cond ? { x } : {})`) omit the key
// entirely, which is `.optional()`, not `.nullable()`.
// ---------------------------------------------------------------------------------------------

/** Mirrors search/graph_search_stages/types.ts's GraphSearchResult. `content` is genuinely
 *  optional (omitted when the projection did not hydrate it), not nullable.
 *
 *  THE-630: `vault` is present ONLY on a federated vault_graph_search result (2+ target vaults) —
 *  absent on every single-vault result, from this tool or any other consumer of this schema, which
 *  is what keeps AC1's byte-identical-when-`vaults`-absent guarantee true at the per-result level
 *  too, not just the top-level response shape. */
export const GraphSearchResultSchema = z.object({
  chunk_id: z.string(),
  path: z.string(),
  content: z.string().optional(),
  // THE-628 (first PR): "summary" added — see graph_search.ts's ALL_SOURCES comment for why
  // CoverageEstimateSchema.arms below stays the 5-value taxonomy while this one widens.
  // THE-628 (second PR): "cluster_summary" added the same way — omitting it here would silently
  // strip a real (if dark-by-default) result value once retrieval.summaries.clusters.enabled.
  source: z.enum([
    "seed",
    "expansion",
    "lexical",
    "sparse",
    "temporal",
    "summary",
    "cluster_summary",
  ]),
  hop: z.number(),
  via_edge: z
    .object({ type: z.string(), source_path: z.string(), provenance: z.string().nullable() })
    .nullable(),
  root_seed: z.string().nullable(),
  rerank_score: z.number(),
  vault: z.string().optional(),
});

/** THE-631: mirrors search/graph_search_stages/types.ts's CoverageEstimate. Additive and
 *  reported-only — see estimateCoverage() in search/graph_search.ts for exactly what each field
 *  means; it never feeds back into ranking. Present only on the graph-fusion arm of a search tool
 *  (the lexical-route arm bypasses graphSearch entirely and has nothing to report), hence
 *  .optional() rather than .nullable() here too. */
export const CoverageEstimateSchema = z.object({
  arms: z.array(z.enum(["seed", "expansion", "lexical", "sparse", "temporal"])),
  armsContributed: z.number(),
  armsPossible: z.number(),
  expansionSkipped: z.boolean(),
  expansionTruncated: z.boolean(),
  requested: z.number(),
  returned: z.number(),
  underfilled: z.boolean(),
  /** THE-631 item 2 — distinct returned NOTES older than staleThresholdDays, by `notes.mtime`.
   *  staleUnknown counts returned notes with no `notes` row, whose age is unknown and which are
   *  never folded into staleReturned: absent is not fresh. staleThresholdDays is echoed so the
   *  count is interpretable without knowing the server's configuration. */
  staleReturned: z.number(),
  staleUnknown: z.number(),
  staleThresholdDays: z.number(),
  /** THE-631 item 1 / THE-733 — the query's top score placed in the VAULT'S OWN calibrated
   *  distribution. A discriminated union: an uncalibrated vault reports `available: false` with a
   *  reason rather than a number derived from a global constant, because "a confidence number
   *  computed from another vault's percentiles is worse than no confidence number." */
  confidence: z.union([
    z.object({
      available: z.literal(false),
      reason: z.enum(["not_calibrated", "not_enough_samples", "no_results"]),
    }),
    z.object({
      available: z.literal(true),
      percentile: z.number(),
      band: z.enum(["low", "moderate", "high"]),
      calibrated_at: z.number(),
      calibrated_n: z.number(),
      stale_calibration: z.boolean(),
    }),
  ]),
});

/** THE-646 item 2: one link in an answer's lineage. Every field that can be UNKNOWN says so with a
 *  named state rather than a blank — see experiential/lineage.ts for why each absence is distinct.
 *  `citation_score` is nullable and is ALWAYS null when `citation` is `not_stamped`: a score
 *  without a verdict reads as a verdict. */
export const LineageLinkSchema = z.object({
  chunk_id: z.string(),
  /** Null when the chunk no longer resolves — reported, never dropped. */
  path: z.string().nullable(),
  chunk: z.enum(["resolved", "deleted"]),
  retrieved_at: z.number(),
  surface_type: z.string(),
  query_text: z.string().nullable(),
  rank_in_results: z.number().nullable(),
  /** `not_stamped` is not a database value: the column is NULL. Naming it here keeps "never
   *  judged" from rendering as "judged and rejected". */
  citation: z.enum(["confirmed", "rejected", "candidate", "uncertain", "not_stamped"]),
  citation_score: z.number().nullable(),
  /** `session` is an identity; `time_window` is a guess that is usually right. Never conflate. */
  correlation: z.enum(["session", "time_window", "none"]),
  episode_id: z.string().nullable(),
});

export const LineageSummarySchema = z.object({
  retrievals: z.number(),
  deleted_chunks: z.number(),
  not_stamped: z.number(),
  not_cited: z.number(),
  cited: z.number(),
  exact_correlations: z.number(),
});

/** THE-646 item 2: `explain_answer`'s envelope. The `available: false` branch mirrors m8's
 *  `availableWith` shape — declared locally rather than imported so m7 does not take a dependency
 *  on m8's shared module (check:boundaries). */
export const ExplainAnswerOutput = z.union([
  z.object({ available: z.literal(false), message: z.string() }),
  z.object({
    available: z.literal(true),
    vault: z.string(),
    scope: z.enum(["session", "time_window"]),
    links: z.array(LineageLinkSchema),
    summary: LineageSummarySchema,
    /** Present when NOTHING in the chain is judge-backed, so a caller cannot read zero citations
     *  as evidence the sources went unused. Null once any row is stamped. */
    caveat: z.string().nullable(),
    /** THE-717: what the citation run log knows about this window. `recorded_runs: 0` means NO
     *  RECORD, which is weaker than "never ran" — the log does not extend backwards. */
    citation_pass: z.object({
      recorded_runs: z.number(),
      last_ran_at: z.number().nullable(),
      last_aborted: z.boolean(),
      last_unfinished: z.boolean(),
    }),
  }),
]);

/** The trimmed citation shape reflect returns (NOT a full GraphSearchResult). */
export const SourceRef = z.object({ chunk_id: z.string(), path: z.string(), score: z.number() });

export const ContradictionRow = z.object({
  id: z.string(),
  source_path: z.string(),
  conflict_path: z.string(),
  judge_verdict: z.string(),
  judge_rationale: z.string(),
});

/** vault_context. The prefetch path returns the SAME bundle plus two markers, so they are optional
 *  here rather than a separate union arm — a second arm would duplicate ~30 fields to add two. */
export const VaultContextOutput = z.object({
  vault: z.string(),
  route: z.array(z.string()),
  query_source: z.enum(["input", "next_session"]),
  signal: z.string().optional(),
  signal_hash: z.string().optional(),
  budget: z.object({
    requested: z.number(),
    chunk_budget: z.number(),
    packed_tokens: z.number(),
  }),
  stats: z.object({
    chunks_considered: z.number(),
    chunks_packed: z.number(),
    notes: z.number(),
    contradictions: z.number(),
    syntheses: z.number(),
    lessons: z.number(),
  }),
  notes: z.array(
    z.object({
      path: z.string(),
      chunks: z.array(
        z.object({
          chunk_id: z.string(),
          content: z.string().optional(),
          score: z.number(),
          source: z.string(),
          hop: z.number(),
        }),
      ),
    }),
  ),
  // `patterns` is JSON.parse'd with a fallback to the raw string, so its shape is genuinely not
  // known here. z.unknown() states that honestly rather than inventing a contract for it.
  syntheses: z.array(
    z.object({
      iso_year: z.number(),
      iso_week: z.number(),
      generated_at: z.number(),
      patterns: z.unknown(),
    }),
  ),
  contradictions: z.array(ContradictionRow),
  // THE-647 item 1: present only when `since` was given (diff mode). Captured BEFORE the diff
  // read ran, so a caller that echoes this back as `since` on its NEXT call never has a
  // concurrently-written row dropped — see context-watermark.ts's module doc.
  diff_since: z.string().optional(),
  lessons: z.array(
    z.object({
      chunk_id: z.string(),
      path: z.string(),
      excerpt: z.string(),
      via: z.enum(["engine", "lexical"]),
    }),
  ),
  // Present only with include_work; degrades to a marker object rather than an empty array, so a
  // caller can tell "no work" from "work plane unavailable".
  episodes: z
    .union([
      z.array(
        z.object({
          id: z.string(),
          ts: z.number(),
          tool: z.string().nullable(),
          status: z.string(),
          summary: z.string().nullable(),
        }),
      ),
      z.object({ work_unavailable: z.literal(true) }),
    ])
    .optional(),
  prefetched: z.literal(true).optional(),
  prefetch_generated_at: z.number().optional(),
});

/** reflect: three arms. `mode` in the degraded arm ECHOES the input rather than being normalised,
 *  which is why it is a plain string there and a literal in the other two. */
/** reflect. Encoded as ONE object with optionals rather than a discriminated union, because
 *  TypeScript unifies the handler's three branch returns into a single widened shape
 *  (`available: boolean`, absent fields as `?: undefined`) rather than preserving the union — so a
 *  union of literal-tagged arms cannot match the inferred return type.
 *
 *  What the three arms actually are, since the schema can no longer say it:
 *    degraded  { available: false, message, answer: null, sources }   — `mode` ECHOES the input here
 *    challenge { available: true,  model, challenge, sources }
 *    synthesis { available: true,  model, answer, sources, persisted? }
 *
 *  Every field name and type is still checked; only the correlation between them is not. */
export const ReflectOutput = z.object({
  vault: z.string(),
  mode: z.string(),
  route: z.array(z.string()),
  available: z.boolean(),
  message: z.string().optional(),
  answer: z.string().nullable().optional(),
  model: z.string().optional(),
  challenge: challengeOutputSchema.optional(),
  sources: z.array(SourceRef),
  persisted: z.object({ path: z.string() }).optional(),
});

/** vault_graph_search: `route` appears only on the lexical arm; hyde/variants_used are spread in
 *  conditionally. Kept as one object with optionals rather than a union, because the two arms
 *  differ only by which optional keys are present. */
/** THE-632: one pipeline stage's answer for the traced note. `score`/`rank` are OPTIONAL because
 *  stages that do not produce them omit them rather than reporting 0 — an invented zero reads as
 *  "scored terribly" when the truth is "not scored at this stage". */
export const RetrievalTraceStageSchema = z.object({
  stage: z.string(),
  present: z.boolean(),
  chunks_present: z.number(),
  candidates_in: z.number(),
  candidates_out: z.number(),
  score: z.number().optional(),
  rank: z.number().optional(),
  note: z.string().optional(),
});

/** THE-632: diagnose_retrieval's envelope. `returned` is the plain answer to the question asked;
 *  `dropped_at` names the FIRST stage where the note stopped being present, which is the actionable
 *  part — everything after it is downstream of the real cause. */
export const DiagnoseRetrievalOutput = z.object({
  vault: z.string(),
  query: z.string(),
  path: z.string(),
  returned: z.boolean(),
  /** null when the note was returned, or when it was never a candidate at all (in which case the
   *  first stage already reports present:false and there is no "drop" to locate). */
  dropped_at: z.string().nullable(),
  /** A plain-language reading of the trace. Never remediation advice — that needs counterfactual
   *  scoring and is deliberately out of v1 scope. */
  summary: z.string(),
  stages: z.array(RetrievalTraceStageSchema),
});

export const VaultGraphSearchOutput = z.object({
  vault: z.string(),
  mode_used: z.enum(["lexical-route", "graph"]),
  route: z.array(z.string()).optional(),
  query: z.string().optional(),
  hyde: z.literal(true).optional(),
  variants_used: z.number().optional(),
  // THE-926: count of variants whose graphSearch call swallowed a transient error (never 0/absent
  // when every variant succeeded) — see search/multi_query.ts's OnVariantOutcome.
  failed_variants: z.number().optional(),
  // THE-631: additive, reported-only — present on the graph arm, absent on lexical-route.
  coverage: CoverageEstimateSchema.optional(),
  // THE-630: present ONLY when `vaults` federated across more than one distinct vault (an absent
  // or single-vault-collapsing `vaults` input is a byte-identical no-op — AC1 — so these two fields
  // are absent then too, exactly like `variants_used` above for the THE-448 fan-out). `vault` /
  // `mode_used` / `route` / `coverage` above keep describing the PRIMARY vault only, unchanged in
  // meaning from before this ticket; `per_vault` is the per-leg breakdown across every target vault
  // (never a single fabricated cross-vault number — same principle THE-631 states for `coverage`).
  vaults_used: z.number().optional(),
  // THE-926: count of vault legs that swallowed a transient error (see federated_search.ts's
  // OnLegOutcome). Never 0/absent when every leg succeeded.
  failed_vaults: z.number().optional(),
  per_vault: z
    .record(
      z.string(),
      z.object({
        mode_used: z.enum(["lexical-route", "graph"]),
        coverage: CoverageEstimateSchema.optional(),
        // THE-926: this vault's own `failed_variants`, scoped to this one leg.
        failed_variants: z.number().optional(),
      }),
    )
    .optional(),
  results: z.array(GraphSearchResultSchema),
});

/** knowledge_search: `route` is present on the lexical arm and ABSENT on the graph arm — not null,
 *  not empty. Optional is the honest encoding. */
export const KnowledgeSearchOutput = z.object({
  vault: z.string(),
  mode_used: z.enum(["lexical-route", "graph"]),
  route: z.array(z.string()).optional(),
  // THE-631: additive, reported-only — present on the graph arm, absent on lexical-route.
  coverage: CoverageEstimateSchema.optional(),
  results: z.array(GraphSearchResultSchema),
});

export const KnowledgeCriticalOutput = z.object({
  vault: z.string(),
  count: z.number(),
  items: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      category: z.string().nullable(),
      source: z.string().nullable(),
      severity: z.literal("critical"),
    }),
  ),
});

/** knowledge_challenge: three arms, and the degraded one is only the shared triple — deliberately
 *  narrower than reflect's, which is exactly the inconsistency THE-548 surfaced. */
/** knowledge_challenge. Same widening reason as ReflectOutput. Its degraded arm is only
 *  `{ vault, available: false, message }` — deliberately NARROWER than reflect's, which is exactly
 *  the surface inconsistency THE-548 surfaced and this ticket is making legible. */
export const KnowledgeChallengeOutput = z.object({
  vault: z.string(),
  available: z.boolean(),
  message: z.string().optional(),
  evidence_count: z.number().optional(),
  contradiction_count: z.number().optional(),
  // null on the no-evidence arm, a full ChallengeOutput on success, absent when degraded.
  output: challengeOutputSchema.nullable().optional(),
  model: z.string().optional(),
});

export const ListContradictionsOutput = z.object({
  vault: z.string(),
  available: z.boolean(),
  message: z.string().optional(),
  total: z.number(),
  contradictions: z.array(ContradictionRow),
});
