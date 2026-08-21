// Prometheus metric catalog (G2.4 §Prometheus — THE-211 / THE-183). The exact 8 counters,
// 2 histograms, and 4 gauges from the observability spec, on a PRIVATE prom-client Registry
// (never the global default registry, so multiple recorders — e.g. in tests — never collide).
// The recorder is always live: counters are cheap in-memory adds and back both `get_metrics`
// and the optional `/metrics` scrape endpoint, which stays disabled by default (G2.4 `:0`).
//
// Cardinality is bounded exactly as G2.4 mandates: labels use `scope_class` (a family like
// `read`/`write`/`bulk`), never full scope strings, and the caller hash is deliberately NOT a
// label — caller-dimension breakdowns belong in OTEL spans and MORGIANA events, whose
// cardinality budgets are looser than Prometheus'.
//
// Coverage note (honest, per spec): every catalog name is registered so `/metrics` is
// catalog-complete, but two counters have no V1 emission source — `idempotency_hits_total`
// and `idempotency_cache_skipped_total` (idempotency replay is forward-compat, THE-197) — and
// the `idempotency_cache_bytes` gauge likewise. They expose as registered-zero until that
// subsystem lands; this is documented rather than faked.
import { Counter, Gauge, Histogram, Registry } from "prom-client";
// Type-only: the label unions are DEFINED at the write-transaction seam that produces them, so a
// new transaction site cannot add a Prometheus series without widening the union there first.
import type { BusyReason, WriteTxnLabel } from "../db/txn";
import type { StageMetric } from "../search/graph_search_stages/instrumentation";
import type { RerankOutcome } from "../search/rerank";

/** Per-vault gauge sample sources, read lazily at scrape time (G2.4 gauges are per `vault`). */
export interface GaugeSources {
  activeSessions?: () => Array<{ vault: string; value: number }>;
  captureQueueDepth?: () => Array<{ vault: string; value: number }>;
  elicitTokensPending?: () => Array<{ vault: string; value: number }>;
  idempotencyCacheBytes?: () => Array<{ vault: string; value: number }>;
  /** THE-507: query-cache effectiveness (THE-497's cache). The `vault` label carries the CACHE
   *  name ("results" / "vectors") rather than a vault id — the cache is process-wide and keyed
   *  internally by vault, so it has no per-vault counts to report. Two bounded values.
   *
   *  These are cumulative counts exposed through the gauge seam rather than as Counters because
   *  the cache owns the numbers and the recorder only reads them; a Counter would need the cache
   *  to call INTO the recorder, which would invert the dependency the composition root exists to
   *  keep one-way. */
  /** THE-585 (#1): index-COORDINATOR depth — in-process write work waiting on the per-(vault,path)
   *  serialization chain. Deliberately NOT the same thing as `captureQueueDepth`, which is the
   *  durable capture_queue table; conflating them was called out in the ticket. Process-wide, so
   *  the `vault` label carries a bounded subsystem name (see observeSqlLockWait's note). */
  indexQueueDepth?: () => Array<{ vault: string; value: number }>;
  /** In-flight index operations, genuinely per vault (the coordinator tracks them that way). */
  indexActive?: () => Array<{ vault: string; value: number }>;
  /** THE-585 (#2): cumulative writes AVOIDED by the coordinator's per-(vault,path) coalescing.
   *  A rise is good — like the dedup counter, this is work not done. */
  indexCoalesced?: () => Array<{ vault: string; value: number }>;
  /** THE-585 (#9): scheduler health. `vault` carries the bounded JOB NAME (registered in code at
   *  startup, never request-derived), per the process-wide-subsystem precedent. */
  schedulerSkipped?: () => Array<{ vault: string; value: number }>;
  schedulerConsecutiveFailures?: () => Array<{ vault: string; value: number }>;
  /** THE-585 (#9): due ticks DEFERRED (not skipped) by budget deferral — inert (all-zero) unless
   *  `eventLoopDeferMs` is configured on the Scheduler; see JobState.deferred. */
  schedulerDeferred?: () => Array<{ vault: string; value: number }>;
  /** THE-585 (#11): seconds spent constructing the HTTP app/transport at boot. Measured once, so a
   *  gauge rather than a histogram — there is exactly one sample per process lifetime. */
  httpConstructSeconds?: () => Array<{ vault: string; value: number }>;
  /** THE-585 (#13): the ACTIVE embedding fingerprint per vault, as a labelled always-1 gauge —
   *  the standard Prometheus "info metric" shape. The value carries no information; the LABEL is
   *  the datum, so an operator can see at a glance which representation an index was built under
   *  and correlate a retrieval-quality change with a model swap. Bounded: one series per vault per
   *  active fingerprint, and a vault has exactly one active fingerprint at a time. */
  vecFingerprint?: () => Array<{ vault: string; fingerprint: string }>;
  queryCacheHits?: () => Array<{ vault: string; value: number }>;
  queryCacheMisses?: () => Array<{ vault: string; value: number }>;
  queryCacheEvictions?: () => Array<{ vault: string; value: number }>;
  queryCacheExpirations?: () => Array<{ vault: string; value: number }>;
}

/** Terminal call status for `obsidian_tc_tool_calls_total` (matches the OTEL status attribute). */
export type ToolCallStatus = "ok" | "denied" | "error";

// Log-spaced byte buckets from G2.4 (1k, 10k, 100k, 1M, 10M).
const RESPONSE_BYTE_BUCKETS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];

// THE-585 (#5): lock-wait buckets, in seconds. There is a bucket AT the configured `busy_timeout`
// (5 s) and another ABOVE it, and the second one is the point: a timed-out acquisition always
// measures slightly OVER the timeout — 5000 ms of busy_timeout was measured at 5006 ms, because
// the sample spans SQLite's busy-handler loop plus the call overhead around it. With 5 as the top
// bucket every timeout would fall into +Inf alone, and "waited the full timeout and then threw"
// would be indistinguishable from "waited a minute". The 5..10 band is where timeouts land.
const SQL_LOCK_WAIT_BUCKETS = [0.001, 0.01, 0.1, 0.5, 1, 5, 10];

// THE-585 (#6): retrieval stages are sub-millisecond to low-tens-of-ms individually, so the
// default prom-client buckets (which start at 5ms) would put almost every stage in the first
// bucket and report nothing useful. Log-spaced from 0.5ms.
const RETRIEVAL_STAGE_BUCKETS = [0.0005, 0.002, 0.01, 0.05, 0.25, 1];

export class MetricsRecorder {
  readonly registry: Registry;

  private readonly toolCalls: Counter<string>;
  private readonly aclDenied: Counter<string>;
  private readonly hitlElicited: Counter<string>;
  private readonly idempotencyHits: Counter<string>;
  private readonly idempotencyCacheSkipped: Counter<string>;
  private readonly rateLimitHits: Counter<string>;
  private readonly governorTruncations: Counter<string>;
  private readonly morgianaDropped: Counter<string>;
  private readonly authRejections: Counter<string>;
  private readonly auditWriteFailed: Counter<string>;
  // THE-667: the idempotency-claim RELEASE on a rejected dispatch. Sibling of auditWriteFailed
  // above, and for the same reason — the write is deliberately best-effort, so a failure has no
  // other signal.
  private readonly idempotencyReleaseFailed: Counter<string>;
  // THE-507 (folding in THE-489): ingest work counters. Additive to the [ingest]/[index] stderr
  // lines the indexer already writes — these make the same events queryable instead of grep-able.
  private readonly ingestSecretsSkipped: Counter<string>;
  private readonly ingestDedupSkipped: Counter<string>;
  private readonly ingestDedupUnresolved: Counter<string>;
  private readonly embedBatchRejections: Counter<string>;
  private readonly indexWriteFailures: Counter<string>;
  private readonly vecFallbacks: Counter<string>;
  private readonly sqlBusy: Counter<string>;
  private readonly outputSchemaDrift: Counter<string>;
  private readonly activationRecomputeChunks: Counter<string>;
  private readonly vecRebuild: Counter<string>;
  private readonly rerankOutcome: Counter<string>;
  private readonly retrievalStageCandidatesIn: Counter<string>;
  private readonly retrievalStageCandidatesOut: Counter<string>;
  private readonly retrievalContentBytesIn: Counter<string>;
  private readonly retrievalContentBytesOut: Counter<string>;
  // THE-891 item 3: the graph-walk ACL filter's (THE-695/THE-852) recall cost, made measurable.
  private readonly aclWalkPruned: Counter<string>;
  private readonly toolDuration: Histogram<string>;
  private readonly responseBytes: Histogram<string>;
  private readonly sqlLockWait: Histogram<string>;
  private readonly retrievalStageDuration: Histogram<string>;

  constructor(sources: GaugeSources = {}) {
    const registry = new Registry();
    this.registry = registry;
    const registers = [registry];

    this.toolCalls = new Counter({
      name: "obsidian_tc_tool_calls_total",
      help: "Tool calls by vault, tool, and terminal status.",
      labelNames: ["vault", "tool", "status"],
      registers,
    });
    this.aclDenied = new Counter({
      name: "obsidian_tc_acl_denied_total",
      help: "ACL/scope denials by vault, scope class, and reason.",
      labelNames: ["vault", "scope_class", "reason"],
      registers,
    });
    this.hitlElicited = new Counter({
      name: "obsidian_tc_hitl_elicited_total",
      help: "HITL elicit confirmations required, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.auditWriteFailed = new Counter({
      name: "obsidian_tc_audit_write_failed_total",
      help: "Security-audit event writes that failed, by vault and tool. Audit is fail-open by design (a failed write must never break dispatch), so this counter is the only signal that the audit trail has gone lossy.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.idempotencyReleaseFailed = new Counter({
      name: "obsidian_tc_idempotency_release_failed_total",
      help: "Idempotency claims left ORPHANED because the final release attempt on a pre-handler failure failed, by vault, tool and the rejection gate that led there (throttle | hitl | other). Release is best-effort so it never masks the error the caller must see, which also makes this counter its only signal. Counted at the LAST attempt, not at the gate: the gates get a retry in the outer catch, so a gate-site failure that retry then cleans up leaves no orphan and is deliberately not counted. When this does fire the claim survives, and a matching retry inside the reclaim window (idempotencyReclaimSeconds, default 60s) returns idempotency_in_flight; at or after that window claimOrReplay reclaims the row. The 24h idempotencyTtlSeconds is the later alternate expiry, not the blocking bound.",
      labelNames: ["vault", "tool", "gate"],
      registers,
    });
    this.ingestSecretsSkipped = new Counter({
      name: "obsidian_tc_ingest_secrets_skipped_total",
      help: "Chunks the secret gate refused to index, by vault. Non-zero is expected on a vault containing credentials; a SUDDEN rise means content that used to index no longer does.",
      labelNames: ["vault"],
      registers,
    });
    this.ingestDedupSkipped = new Counter({
      name: "obsidian_tc_ingest_dedup_skipped_total",
      help: "Chunks whose embedding was reused from an identical-body sibling instead of recomputed, by vault. This is work AVOIDED, so a rise is good ONLY for the chunks it actually resolved — see obsidian_tc_ingest_dedup_unresolved_total for the subset that copied nothing; a fall in this counter means the dedup path stopped matching.",
      labelNames: ["vault"],
      registers,
    });
    // THE-588: the LOSS side of dedup, split out of the reused counter above. A dedup-skipped chunk
    // whose owner had no stored vector to copy (e.g. quarantined this pass) is STORED but carries no
    // dense/sparse/colbert vector — FTS-only until the owner re-embeds. Unlike its sibling, a rise
    // here is BAD: it is retrieval coverage lost, not work avoided.
    this.ingestDedupUnresolved = new Counter({
      name: "obsidian_tc_ingest_dedup_unresolved_total",
      help: "Chunks skipped for embedding by cross-path dedup whose source had no stored vector to copy, by vault. A rise is BAD — these chunks are FTS-only (no dense/sparse/colbert) until the owner note re-embeds successfully; it is the loss side of obsidian_tc_ingest_dedup_skipped_total, not work avoided.",
      labelNames: ["vault"],
      registers,
    });
    this.embedBatchRejections = new Counter({
      name: "obsidian_tc_embed_batch_rejections_total",
      help: "Embed requests the provider rejected for exceeding its context (HTTP 400/413), then bisected + retried, by vault. Each is an extra round-trip; a persistent count means embeddings.maxBatchTokens is too high.",
      labelNames: ["vault"],
      registers,
    });
    this.indexWriteFailures = new Counter({
      name: "obsidian_tc_index_write_failures_total",
      help: "Notes skipped in a pass because the embed provider rejected them even at single-text size, by vault. Unlike the batch rejections above these are NOT retried within the pass, so the note is absent from the index until the next reconcile.",
      labelNames: ["vault"],
      registers,
    });
    this.vecFallbacks = new Counter({
      name: "obsidian_tc_vec_fallback_total",
      help: "Searches that abandoned the vec0 KNN index for the exhaustive brute-force scan, by vault and reason. Results stay correct; the cost profile does not. reason=error is usually a dimension mismatch after an embedding-model change (the index no longer matches the query) and a persistent count means a real misconfiguration; reason=underfill means ACL-invisible chunks may be crowding out visible ones, so the over-fetch could not fill k visible hits.",
      labelNames: ["vault", "reason"],
      registers,
    });
    // THE-612: ensureVecChunks DROPs and rebuilds vec_chunks — a full re-embed of every vault
    // sharing the table — whenever the stored representation fingerprint drifts or a legacy
    // pre-partition shape is detected. Rare (a deploy changed the embedding model, or a one-time
    // schema upgrade) and huge blast radius (dense retrieval goes cold for every vault until
    // re-embedded), and previously had no counter at all — no `vault` label because the event is
    // not scoped to one vault; see obsidian_tc_auth_rejections_total for the same precedent.
    this.vecRebuild = new Counter({
      name: "obsidian_tc_vec_rebuild_total",
      help: "vec_chunks DROP+rebuild events, by reason. legacy_shape is a one-time pre-partition upgrade; fingerprint_changed means the embedding provider/model/dimensions, distance metric, or chunk/enrichment representation changed since the index was built. Either way every vault's dense index is cold until it re-embeds — any non-zero count outside a deliberate model migration is worth investigating.",
      labelNames: ["reason"],
      registers,
    });
    // rerankWithScores' fallback returns the same shaped output whether the reranker was
    // never configured, timed out, errored, answered with garbage, or was deliberately skipped by
    // gatedRerank's policy gate — a reranker broken for a week looks identical to one that never
    // ran. `outcome` is the closed 7-value RerankOutcome union, so the label set is bounded by
    // construction like `stage` above.
    this.rerankOutcome = new Counter({
      name: "obsidian_tc_rerank_outcome_total",
      help: "rerankWithScores decisions, by vault and outcome. executed is the only outcome where the reported ranking actually came from the reranker; every other value is the synthetic-descending-score fallback for a different reason — not_configured (no reranker injected), skipped_by_policy (gatedRerank's hardness gate did not fire), timed_out, malformed_response (the call returned but produced no usable hit), provider_error (the call rejected for any other reason), fallback_used (no more specific reason — e.g. an empty candidate set).",
      labelNames: ["vault", "outcome"],
      registers,
    });
    // THE-417 Phase 2: the instrument that makes warn-mode runnable. Before this, a mismatch wrote
    // one stderr line among every other internal error and nothing accumulated it, so "let
    // warn-mode surface latent mismatches" had no way to be read. Labels are bounded exactly like
    // obsidian_tc_tool_calls_total's — vault id and tool name, never the payload or the Zod issues,
    // which would put note content into a label.
    this.outputSchemaDrift = new Counter({
      name: "obsidian_tc_output_schema_drift_total",
      help: "Handler payloads that did not match their advertised outputSchema, by vault and tool. In production this is WARN-only — the payload still ships — so a non-zero value is the only signal that a tool's declared contract has drifted from what it returns. In dev/CI the same condition is a hard internal_error. Any non-zero count names a tool whose schema or handler is wrong; there is no benign case.",
      labelNames: ["vault", "tool"],
      registers,
    });
    // THE-645 item 1: registerActivationRecompute's onRecompute stats were computed every tick
    // and discarded — nothing outside the process could see whether the periodic ACT-R recompute
    // was running, or how much work it was doing. `vault` carries the bounded job name
    // ("activation-recompute"), the same process-wide-subsystem precedent the scheduler gauges
    // use, since the recompute runs once over the whole experiential store rather than per vault.
    this.activationRecomputeChunks = new Counter({
      name: "obsidian_tc_activation_recompute_chunks_total",
      help: "Chunks whose cached_activation_score was recomputed by the periodic ACT-R activation job, by job name. Cumulative. A flat line while the scheduler reports the job running means chunk_retrievals has stopped growing, not that the job stalled.",
      labelNames: ["vault"],
      registers,
    });
    this.sqlBusy = new Counter({
      name: "obsidian_tc_sql_busy_total",
      help: "Write transactions that failed on a busy database, by vault, transaction, and reason. reason=busy means contention outlived busy_timeout (5s) — the writers genuinely overlap that long. reason=snapshot is a BUG REPORT, not tuning: it can only be produced by a deferred BEGIN that read and then tried to write, a failure busy_timeout cannot retry, so any non-zero count names a write path still using BEGIN where it should use inWriteTransaction.",
      labelNames: ["vault", "txn", "reason"],
      registers,
    });
    this.idempotencyHits = new Counter({
      name: "obsidian_tc_idempotency_hits_total",
      help: "Idempotency cache hits, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.idempotencyCacheSkipped = new Counter({
      name: "obsidian_tc_idempotency_cache_skipped_total",
      help: "Idempotency results skipped over the byte cap, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.rateLimitHits = new Counter({
      name: "obsidian_tc_rate_limit_hits_total",
      help: "Rate-limit refusals, by vault and scope class.",
      labelNames: ["vault", "scope_class"],
      registers,
    });
    this.governorTruncations = new Counter({
      name: "obsidian_tc_governor_truncations_total",
      help: "Response-byte governor truncations/refusals, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
    });
    this.authRejections = new Counter({
      name: "obsidian_tc_auth_rejections_total",
      // THE-520: labelled by REASON so an operator can alert on the difference between "tokens are
      // expiring" (rotation working) and "tokens exceed tokenTtlSeconds" (misconfiguration).
      help: "Refused tokens at the HTTP edge, by rejection reason.",
      labelNames: ["reason"],
      registers,
    });
    this.morgianaDropped = new Counter({
      name: "obsidian_tc_morgiana_emit_dropped_total",
      help: "MORGIANA events dropped, by vault and reason.",
      labelNames: ["vault", "reason"],
      registers,
    });

    this.toolDuration = new Histogram({
      name: "obsidian_tc_tool_duration_seconds",
      help: "Tool execution wall time in seconds, by vault and tool.",
      labelNames: ["vault", "tool"],
      registers,
      // G2.4: "Default (Prometheus client library defaults)." — no explicit buckets.
    });
    this.responseBytes = new Histogram({
      name: "obsidian_tc_response_bytes",
      help: "Tool response size in bytes, by vault and tool.",
      labelNames: ["vault", "tool"],
      buckets: RESPONSE_BYTE_BUCKETS,
      registers,
    });
    // THE-585 (#5): the signal THE-467/468 cannot be argued without — how long writers block each
    // other on ONE shared cache.db. Under WAL readers never block, so every sample here is
    // writer-vs-writer contention and nothing else.
    //
    // Observed on EVERY acquisition, including the uncontended ones that fall in the 1 ms bucket:
    // without those the histogram would have no denominator and "5% of index writes waited >100 ms"
    // could not be computed at all. The `txn` label is a closed union (see WriteTxnLabel) so an
    // operator can tell a reindex waiting on a live tool call from the reverse.
    // THE-585 (#6). `stage` is the closed StageName union from THE-465's instrumentation, so the
    // label set is bounded at 8 by construction — no cardinality work was needed.
    //
    // The two candidate counters are the point, more than the duration: their RATIO per stage is
    // the retrieval funnel. `candidates_out / candidates_in` says which stage is actually filtering,
    // and a stage whose ratio drifts to 1.0 has quietly stopped doing its job while still costing
    // its latency. Neither number answers that alone.
    this.retrievalStageDuration = new Histogram({
      name: "obsidian_tc_retrieval_stage_duration_seconds",
      help: "Wall time per named graph-search stage, by vault and stage.",
      labelNames: ["vault", "stage"],
      buckets: RETRIEVAL_STAGE_BUCKETS,
      registers,
    });
    this.retrievalStageCandidatesIn = new Counter({
      name: "obsidian_tc_retrieval_stage_candidates_in_total",
      help: "Candidates entering each graph-search stage, by vault and stage. Divide the _out_ counter by this for the stage's pass-through ratio: a stage sitting at 1.0 is no longer filtering anything while still costing its latency.",
      labelNames: ["vault", "stage"],
      registers,
    });
    this.retrievalStageCandidatesOut = new Counter({
      name: "obsidian_tc_retrieval_stage_candidates_out_total",
      help: "Candidates leaving each graph-search stage, by vault and stage. See the _in_ counter.",
      labelNames: ["vault", "stage"],
      registers,
    });
    // THE-585 (#12): content bytes hydrated at the two boundaries that waste it — duplicate
    // hydration across streams (candidateAssembly) and the top-K cut (diversity/gatedRerank).
    // Only those stages populate StageMetric.bytesIn/bytesOut (see observeRetrievalStage), so
    // only they get a series here; the other 5 stages never touch these counters at all. Bytes,
    // not characters (Buffer.byteLength) — this tracks actual I/O cost, which multi-byte UTF-8
    // content would understate if counted by character.
    this.retrievalContentBytesIn = new Counter({
      name: "obsidian_tc_retrieval_content_bytes_in_total",
      help: "Content bytes materialized entering a stage boundary, by vault and stage. Populated only at candidateAssembly (pre-dedup, across streams) and diversity/gatedRerank (pre-top-K-cut). Compare to the _out_ counter for the same stage: the gap is hydrated content that was never used.",
      labelNames: ["vault", "stage"],
      registers,
    });
    this.retrievalContentBytesOut = new Counter({
      name: "obsidian_tc_retrieval_content_bytes_out_total",
      help: "Content bytes surviving a stage boundary, by vault and stage. See the _in_ counter.",
      labelNames: ["vault", "stage"],
      registers,
    });
    // THE-891 item 3: the graph-walk ACL filter (THE-695/THE-852) has been unconditional since
    // v1.22.0 — fine for correctness, but its recall cost (readable notes reachable only through
    // an unreadable bridge) had no signal at all. Only ever non-zero for a RESTRICTED caller:
    // resolveAclWalkFilter's structural-no-op argument for an unrestricted one
    // (retrieval-runtime.ts) means this stays at zero for the common single-principal deployment,
    // which doubles as a live check of that argument rather than just a doc claim.
    this.aclWalkPruned = new Counter({
      name: "obsidian_tc_acl_walk_pruned_total",
      help: "Paths the graph-walk ACL filter excluded from a walk that an unfiltered walk over the same seed frontier would have reached, by vault. Zero for an unrestricted caller by construction (nothing to prune); a non-zero, rising count for a restricted one is the filter's recall cost made visible, not an error.",
      labelNames: ["vault"],
      registers,
    });
    this.sqlLockWait = new Histogram({
      name: "obsidian_tc_sql_lock_wait_seconds",
      help: "Seconds spent acquiring SQLite's write lock (BEGIN IMMEDIATE), by vault and transaction. Only writers contend under WAL, so a rising tail here is the direct evidence for splitting the shared database per vault. Failed acquisitions are observed too, and land just ABOVE busy_timeout (5s) rather than at it — count the 5..10s band to find transactions that waited out the timeout and then threw.",
      labelNames: ["vault", "txn"],
      buckets: SQL_LOCK_WAIT_BUCKETS,
      registers,
    });

    // Gauges read live per-vault state at scrape time via injected sources. Registered
    // unconditionally so the catalog is complete on /metrics even before a source exists.
    const gauge = (
      name: string,
      help: string,
      source?: () => Array<{ vault: string; value: number }>,
    ): void => {
      new Gauge({
        name,
        help,
        labelNames: ["vault"],
        registers,
        collect() {
          if (!source) return;
          this.reset();
          for (const s of source()) this.set({ vault: s.vault }, s.value);
        },
      });
    };
    gauge(
      "obsidian_tc_active_sessions",
      "Active workspace sessions, by vault.",
      sources.activeSessions,
    );
    gauge(
      "obsidian_tc_capture_queue_depth",
      "Pending capture-queue items, by vault.",
      sources.captureQueueDepth,
    );
    gauge(
      "obsidian_tc_elicit_tokens_pending",
      "Unconsumed elicit tokens, by vault.",
      sources.elicitTokensPending,
    );
    gauge(
      "obsidian_tc_idempotency_cache_bytes",
      "Idempotency cache size in bytes, by vault.",
      sources.idempotencyCacheBytes,
    );
    // THE-585 (#1): the index coordinator's own depth. `queued` is the number of paths with work
    // outstanding on the serialization chain; `active` is what is executing. A rising queue against
    // a flat active count is the signal that write concurrency is the bottleneck — the other half
    // of the THE-467/468 argument that obsidian_tc_sql_lock_wait_seconds started.
    gauge(
      "obsidian_tc_index_queue_depth",
      "Paths with index work outstanding on the in-process coordinator chain, by subsystem. NOT the durable capture queue (see obsidian_tc_capture_queue_depth).",
      sources.indexQueueDepth,
    );
    gauge(
      "obsidian_tc_index_active",
      "Index operations currently executing, by vault.",
      sources.indexActive,
    );
    // THE-585 (#2). Work AVOIDED, so a rise is good — the same reading as the dedup counter. A
    // bursty editor autosaving one note should drive this up; if it stops moving under that load,
    // coalescing has broken and every keystroke is being embedded.
    gauge(
      "obsidian_tc_index_coalesced_total",
      "Index writes avoided by per-(vault,path) coalescing — a pending op replaced by a newer one before it ran. Cumulative. A RISE IS GOOD (work not done); a flat line under a bursty writer means coalescing stopped working.",
      sources.indexCoalesced,
    );
    // THE-585 (#9). `vault` carries the bounded job NAME — registered in code at startup, never
    // request-derived. Skips and backoff are the scheduler's own numbers, read rather than pushed.
    gauge(
      "obsidian_tc_scheduler_skipped_total",
      "Due ticks skipped because the job's prior run was still in flight, by job name. Cumulative. Sustained growth means the job's interval is shorter than its runtime.",
      sources.schedulerSkipped,
    );
    gauge(
      "obsidian_tc_scheduler_consecutive_failures",
      "Consecutive failures per job name — the exponent behind the scheduler's backoff. Non-zero means the job is currently backing off; it resets to 0 on the next success.",
      sources.schedulerConsecutiveFailures,
    );
    gauge(
      "obsidian_tc_scheduler_deferred_total",
      "Due ticks deferred (not skipped) because the event-loop delay p99 exceeded eventLoopDeferMs, by job name. Cumulative. Stays 0 forever unless budget deferral is configured — a flat 0 does not mean deferral never mattered, it means it is off.",
      sources.schedulerDeferred,
    );
    // THE-585 (#11). Measured once at boot, so a gauge: a histogram over a single sample would
    // imply a distribution that does not exist.
    gauge(
      "obsidian_tc_http_construct_seconds",
      "Seconds spent constructing the HTTP app/transport at boot, by subsystem. One sample per process.",
      sources.httpConstructSeconds,
    );
    // THE-585 (#13): an INFO metric — value always 1, the label is the datum. The standard
    // Prometheus shape for "what configuration is this process running under". Registered
    // separately from gauge() because its source yields a label, not a value.
    new Gauge({
      name: "obsidian_tc_vec_fingerprint_active",
      help: "Always 1; the `fingerprint` label carries the embedding representation the vault's vector index was actually built under (provider/model/dimensions/metric/enrichment/chunker/schema). Lets a retrieval-quality change be correlated with a representation swap instead of guessed at.",
      labelNames: ["vault", "fingerprint"],
      registers,
      collect() {
        if (!sources.vecFingerprint) return;
        this.reset();
        for (const s of sources.vecFingerprint()) {
          this.set({ vault: s.vault, fingerprint: s.fingerprint }, 1);
        }
      },
    });
    // THE-507: retrieval-cache effectiveness. The `vault` label holds the cache name
    // ("results"/"vectors") — see GaugeSources. Hit rate is hits/(hits+misses); a rising
    // eviction count against a flat hit count means retrieval.cache.maxEntries is too small,
    // and expirations rising instead means the TTL is what is bounding reuse.
    gauge(
      "obsidian_tc_query_cache_hits_total",
      "Retrieval query-cache hits, by cache name. Cumulative.",
      sources.queryCacheHits,
    );
    gauge(
      "obsidian_tc_query_cache_misses_total",
      "Retrieval query-cache misses, by cache name. Cumulative.",
      sources.queryCacheMisses,
    );
    gauge(
      "obsidian_tc_query_cache_evictions_total",
      "Entries dropped from the retrieval query cache because it was full (LRU), by cache name. Rising against a flat hit count means retrieval.cache.maxEntries is too small. Cumulative.",
      sources.queryCacheEvictions,
    );
    gauge(
      "obsidian_tc_query_cache_expirations_total",
      "Entries found but past their TTL, by cache name — a miss that also proves the TTL is doing work, and distinguishes 'too small' from 'too short'. Cumulative.",
      sources.queryCacheExpirations,
    );
  }

  /** Record one terminal tool call: count + duration + response-size histograms. */
  observeToolCall(
    vault: string,
    tool: string,
    status: ToolCallStatus,
    durationSeconds: number,
    responseBytes: number,
  ): void {
    this.toolCalls.inc({ vault, tool, status });
    this.toolDuration.observe({ vault, tool }, durationSeconds);
    this.responseBytes.observe({ vault, tool }, responseBytes);
  }

  incAclDenied(vault: string, scopeClass: string, reason: string): void {
    this.aclDenied.inc({ vault, scope_class: scopeClass, reason });
  }
  /** THE-891 item 3: one call per completed graph-walk expansion that pruned at least one path;
   *  `n` is the count of distinct paths excluded. Guarded on n > 0 like the ingest counters above
   *  so a restricted caller whose walk never touched a bridge does not create a label series that
   *  never moves. */
  incAclWalkPruned(vault: string, n: number): void {
    if (n > 0) this.aclWalkPruned.inc({ vault }, n);
  }
  incHitlElicited(vault: string, tool: string): void {
    this.hitlElicited.inc({ vault, tool });
  }
  /** THE-507: ingest counters come from an indexing pass's AGGREGATE stats, not per event, so each
   *  takes the pass's count. Guarded on n > 0 so a clean pass does not create a label series that
   *  never moves. */
  incIngestSecretsSkipped(vault: string, n: number): void {
    if (n > 0) this.ingestSecretsSkipped.inc({ vault }, n);
  }
  incIngestDedupSkipped(vault: string, n: number): void {
    if (n > 0) this.ingestDedupSkipped.inc({ vault }, n);
  }
  /** THE-588: the unresolved (loss) side of dedup — see the counter's help text. */
  incIngestDedupUnresolved(vault: string, n: number): void {
    if (n > 0) this.ingestDedupUnresolved.inc({ vault }, n);
  }
  incEmbedBatchRejections(vault: string, n: number): void {
    if (n > 0) this.embedBatchRejections.inc({ vault }, n);
  }
  incIndexWriteFailures(vault: string, n: number): void {
    if (n > 0) this.indexWriteFailures.inc({ vault }, n);
  }
  /** THE-585 (#7, #8): one vec0 -> brute-force degradation. `reason` is a closed set of two, so the
   *  label stays bounded per the ticket's cardinality constraint. */
  incVecFallback(vault: string, reason: "error" | "underfill"): void {
    this.vecFallbacks.inc({ vault, reason });
  }
  /** THE-585 (#5): one write-lock acquisition. `vault` carries the vault id where the write
   *  transaction belongs to one, and a bounded SUBSYSTEM name where it does not — the scheduler's
   *  job queue is process-wide and claims across every vault, so it reports as "scheduler". Same
   *  precedent the query-cache gauges set. */
  observeSqlLockWait(vault: string, txn: WriteTxnLabel, seconds: number): void {
    this.sqlLockWait.observe({ vault, txn }, seconds);
  }
  /** THE-417 Phase 2: one output-schema mismatch. */
  incOutputSchemaDrift(vault: string, tool: string): void {
    this.outputSchemaDrift.inc({ vault, tool });
  }
  /** THE-645 item 1: one activation-recompute tick's worth of chunks. Guarded on n > 0 like the
   *  ingest counters above — a tick that recomputed nothing (no new retrievals since the last
   *  watermark) creates no series churn. */
  incActivationRecomputeChunks(vault: string, n: number): void {
    if (n > 0) this.activationRecomputeChunks.inc({ vault }, n);
  }
  /** THE-612: one vec_chunks DROP+rebuild event. */
  incVecRebuild(reason: "legacy_shape" | "fingerprint_changed"): void {
    this.vecRebuild.inc({ reason });
  }
  /** one rerankWithScores decision (see the counter's help text for the full outcome
   *  taxonomy). */
  incRerankOutcome(vault: string, outcome: RerankOutcome): void {
    this.rerankOutcome.inc({ vault, outcome });
  }
  incSqlBusy(vault: string, txn: WriteTxnLabel, reason: BusyReason): void {
    this.sqlBusy.inc({ vault, txn, reason });
  }
  /** THE-585 (#6): one completed retrieval stage. Takes the whole StageMetric rather than three
   *  loose numbers so a caller cannot pair a duration with the wrong stage's counts. */
  observeRetrievalStage(vault: string, metric: StageMetric): void {
    const stage = metric.stage;
    this.retrievalStageDuration.observe({ vault, stage }, metric.durationMs / 1000);
    this.retrievalStageCandidatesIn.inc({ vault, stage }, metric.candidatesIn);
    this.retrievalStageCandidatesOut.inc({ vault, stage }, metric.candidatesOut);
    // THE-585 (#12): optional, and only present at the stages that actually hydrate/discard
    // content (see StageMetric's doc comment) — every other stage leaves both undefined and
    // creates no series here.
    if (metric.bytesIn !== undefined)
      this.retrievalContentBytesIn.inc({ vault, stage }, metric.bytesIn);
    if (metric.bytesOut !== undefined)
      this.retrievalContentBytesOut.inc({ vault, stage }, metric.bytesOut);
  }
  incAuditWriteFailed(vault: string, tool: string): void {
    this.auditWriteFailed.inc({ vault, tool });
  }
  /** THE-667: `gate` names WHICH rejection path led to the orphaned claim — the sites behave
   *  identically but are reached under different conditions, and a counter that cannot tell them
   *  apart cannot point at the one that is failing. `other` is every non-gate pre-handler failure. */
  incIdempotencyReleaseFailed(
    vault: string,
    tool: string,
    gate: "throttle" | "hitl" | "other",
  ): void {
    this.idempotencyReleaseFailed.inc({ vault, tool, gate });
  }
  incIdempotencyHit(vault: string, tool: string): void {
    this.idempotencyHits.inc({ vault, tool });
  }
  incIdempotencyCacheSkipped(vault: string, tool: string): void {
    this.idempotencyCacheSkipped.inc({ vault, tool });
  }
  incRateLimitHit(vault: string, scopeClass: string): void {
    this.rateLimitHits.inc({ vault, scope_class: scopeClass });
  }
  incGovernorTruncation(vault: string, tool: string): void {
    this.governorTruncations.inc({ vault, tool });
  }
  incAuthRejection(reason: string): void {
    this.authRejections.inc({ reason });
  }
  incMorgianaDropped(vault: string, reason: string): void {
    this.morgianaDropped.inc({ vault, reason });
  }

  /** Prometheus text exposition (`text/plain; version=0.0.4`). */
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
  get contentType(): string {
    return this.registry.contentType;
  }
}
