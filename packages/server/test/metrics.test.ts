import { describe, expect, it } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";

// The exact catalog. Stale comment fixed (THE-585): this was "14 counters, 2 histograms,
// 4 gauges" long after the lists below and the size assertion had moved past it — the comment
// was never the gate, the size assertion is. Now 21 counters, 4 histograms, 16 gauges.
const COUNTERS = [
  "obsidian_tc_tool_calls_total",
  "obsidian_tc_acl_denied_total",
  "obsidian_tc_hitl_elicited_total",
  "obsidian_tc_idempotency_hits_total",
  "obsidian_tc_idempotency_cache_skipped_total",
  "obsidian_tc_rate_limit_hits_total",
  "obsidian_tc_governor_truncations_total",
  "obsidian_tc_morgiana_emit_dropped_total",
  "obsidian_tc_audit_write_failed_total",
  "obsidian_tc_auth_rejections_total", // THE-520
  // THE-507 (folding in THE-489): ingest work counters. This list plus the size assertion below is
  // the "no unlisted obsidian_tc_* metric" gate — adding a metric without declaring it here fails.
  "obsidian_tc_ingest_secrets_skipped_total",
  "obsidian_tc_ingest_dedup_skipped_total",
  // THE-588: the unresolved (loss) side of dedup, split out of the reused counter above.
  "obsidian_tc_ingest_dedup_unresolved_total",
  "obsidian_tc_embed_batch_rejections_total",
  "obsidian_tc_index_write_failures_total",
  // THE-585 (#7, #8): vec0 -> brute-force degradation. Results stay correct; the cost profile
  // does not, and nothing reported it before.
  "obsidian_tc_vec_fallback_total",
  // THE-585 (#5): busy-class write-transaction failures. reason=snapshot is a bug report — see
  // the counter's help text and src/db/txn.ts.
  "obsidian_tc_sql_busy_total",
  // THE-417 Phase 2: the readable half of warn-mode. Any non-zero value names a tool whose
  // declared contract has drifted from what it returns; there is no benign case.
  "obsidian_tc_output_schema_drift_total",
  // THE-585 (#6): the retrieval funnel. Their RATIO per stage is the signal — a stage sitting at
  // 1.0 pass-through has stopped filtering while still costing its latency.
  "obsidian_tc_retrieval_stage_candidates_in_total",
  "obsidian_tc_retrieval_stage_candidates_out_total",
  // THE-585 (#12): content bytes hydrated at the boundaries that waste it — duplicate hydration
  // across streams (candidateAssembly) and the top-K cut (diversity/gatedRerank). Only those
  // stages populate StageMetric.bytesIn/bytesOut, so only they emit a series here.
  "obsidian_tc_retrieval_content_bytes_in_total",
  "obsidian_tc_retrieval_content_bytes_out_total",
];
const HISTOGRAMS = [
  "obsidian_tc_tool_duration_seconds",
  "obsidian_tc_response_bytes",
  // THE-585 (#5): the writer-vs-writer contention signal THE-467/468 turns on.
  "obsidian_tc_sql_lock_wait_seconds",
  // THE-585 (#6): `stage` is THE-465's closed 8-value StageName union, bounded by construction.
  "obsidian_tc_retrieval_stage_duration_seconds",
];
const GAUGES = [
  "obsidian_tc_active_sessions",
  "obsidian_tc_capture_queue_depth",
  "obsidian_tc_elicit_tokens_pending",
  "obsidian_tc_idempotency_cache_bytes",
  // THE-585 (#1): index-coordinator depth. Distinct from capture_queue_depth above — that one is
  // the durable table, these are in-process write work.
  "obsidian_tc_index_queue_depth",
  "obsidian_tc_index_active",
  // THE-585 Group A (#2, #9, #11, #13). All five are gauges READ from the subsystem that already
  // owns the number — a Counter would make the subsystem call into the recorder, inverting the
  // composition root's one-way dependency.
  "obsidian_tc_index_coalesced_total",
  "obsidian_tc_scheduler_skipped_total",
  "obsidian_tc_scheduler_consecutive_failures",
  // THE-585 (#9): due ticks deferred by budget deferral, distinct from skipped (in-flight) and
  // consecutiveFailures (threw). Inert (all-zero) unless eventLoopDeferMs is configured.
  "obsidian_tc_scheduler_deferred_total",
  "obsidian_tc_http_construct_seconds",
  "obsidian_tc_vec_fingerprint_active",
  // THE-507: retrieval-cache effectiveness. Gauges rather than counters because the cache owns
  // the cumulative numbers and the recorder only reads them — a Counter would require the cache
  // to call INTO the recorder, inverting the one-way dependency the composition root maintains.
  "obsidian_tc_query_cache_hits_total",
  "obsidian_tc_query_cache_misses_total",
  "obsidian_tc_query_cache_evictions_total",
  "obsidian_tc_query_cache_expirations_total",
];

describe("MetricsRecorder (G2.4 Prometheus catalog)", () => {
  it("registers the full catalog: 22 counters, 4 histograms, 16 gauges", async () => {
    const text = await new MetricsRecorder().metrics();
    for (const name of COUNTERS) expect(text).toContain(`# TYPE ${name} counter`);
    for (const name of HISTOGRAMS) expect(text).toContain(`# TYPE ${name} histogram`);
    for (const name of GAUGES) expect(text).toContain(`# TYPE ${name} gauge`);
    // Catalog is complete and exactly the spec'd size (no extra obsidian_tc_* metrics).
    const declared = [...text.matchAll(/^# TYPE (obsidian_tc_\w+) /gm)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(42);
  });

  it("records SQL lock waits into buckets, and busy failures by reason (THE-585 #5)", async () => {
    const r = new MetricsRecorder();
    r.observeSqlLockWait("main", "index_batch", 0.0004); // uncontended
    r.observeSqlLockWait("main", "index_batch", 0.75); // waited behind another writer
    // A REAL timed-out acquisition, not a tidy 5.0: a 5000ms busy_timeout measures ~5006ms, because
    // the sample spans the busy-handler loop plus call overhead. Using the exact boundary here is
    // what let a top bucket of 5 look correct while no production timeout could ever land in it.
    r.observeSqlLockWait("scheduler", "job_claim", 5.0061);
    r.incSqlBusy("scheduler", "job_claim", "busy");
    r.incSqlBusy("main", "index_deindex", "snapshot");
    const text = await r.metrics();

    // The fast sample is the denominator: without it no "fraction of writes that waited" exists.
    const bucket = (le: string, vault: string, txn: string): string =>
      `obsidian_tc_sql_lock_wait_seconds_bucket{le="${le}",vault="${vault}",txn="${txn}"}`;
    expect(text).toContain(`${bucket("0.001", "main", "index_batch")} 1`);
    expect(text).toContain(`${bucket("0.1", "main", "index_batch")} 1`); // 0.75 is NOT in here
    expect(text).toContain(`${bucket("1", "main", "index_batch")} 2`); // both samples by 1s
    expect(text).toContain(
      'obsidian_tc_sql_lock_wait_seconds_count{vault="main",txn="index_batch"} 2',
    );
    // A timed-out acquisition overshoots busy_timeout, so it must NOT be in the 5s bucket — and
    // must still be inside the histogram (the 10s bucket) rather than only in +Inf, which is what
    // makes "waited the whole timeout and then threw" countable.
    expect(text).toContain(`${bucket("0.5", "scheduler", "job_claim")} 0`);
    expect(text).toContain(`${bucket("5", "scheduler", "job_claim")} 0`);
    expect(text).toContain(`${bucket("10", "scheduler", "job_claim")} 1`);
    // Process-wide subsystems report a bounded subsystem name in `vault`, per the documented
    // precedent — the job queue claims across every vault and has no vault id of its own.
    expect(text).toContain(
      'obsidian_tc_sql_busy_total{vault="scheduler",txn="job_claim",reason="busy"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_sql_busy_total{vault="main",txn="index_deindex",reason="snapshot"} 1',
    );
  });

  it("records the retrieval funnel and stage duration by bounded stage label (THE-585 #6)", async () => {
    const r = new MetricsRecorder();
    // A realistic funnel: expansion widens, diversity narrows.
    r.observeRetrievalStage("main", {
      stage: "graphExpansion",
      candidatesIn: 30,
      candidatesOut: 84,
      durationMs: 12.5,
    });
    r.observeRetrievalStage("main", {
      stage: "diversity",
      candidatesIn: 84,
      candidatesOut: 10,
      durationMs: 0.4,
    });
    const text = await r.metrics();
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_candidates_in_total{vault="main",stage="graphExpansion"} 30',
    );
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_candidates_out_total{vault="main",stage="graphExpansion"} 84',
    );
    // The funnel must stay per-stage: collapsing these would make "which stage filters" unanswerable.
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_candidates_out_total{vault="main",stage="diversity"} 10',
    );
    // Durations are SECONDS in the exposition even though StageMetric carries milliseconds.
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_duration_seconds_sum{vault="main",stage="diversity"} 0.0004',
    );
    // 12.5ms must not land in a sub-millisecond bucket — the whole reason for custom buckets.
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_duration_seconds_bucket{le="0.002",vault="main",stage="graphExpansion"} 0',
    );
    expect(text).toContain(
      'obsidian_tc_retrieval_stage_duration_seconds_bucket{le="0.05",vault="main",stage="graphExpansion"} 1',
    );
  });

  it("emits the Group A subsystem gauges from their own accessors (THE-585 #2/#9/#11/#13)", async () => {
    const r = new MetricsRecorder({
      indexCoalesced: () => [{ vault: "coordinator", value: 17 }],
      schedulerSkipped: () => [
        { vault: "reconcile", value: 3 },
        { vault: "maintenance", value: 0 },
      ],
      schedulerConsecutiveFailures: () => [{ vault: "reconcile", value: 2 }],
      httpConstructSeconds: () => [{ vault: "http", value: 0.0142 }],
      vecFingerprint: () => [{ vault: "index", fingerprint: "ollama|bge-m3|1024|cosine|0|1|v3" }],
    });
    const text = await r.metrics();
    expect(text).toContain('obsidian_tc_index_coalesced_total{vault="coordinator"} 17');
    // A job at zero must still report a series — "no skips" and "job absent" are different facts.
    expect(text).toContain('obsidian_tc_scheduler_skipped_total{vault="maintenance"} 0');
    expect(text).toContain('obsidian_tc_scheduler_skipped_total{vault="reconcile"} 3');
    expect(text).toContain('obsidian_tc_scheduler_consecutive_failures{vault="reconcile"} 2');
    expect(text).toContain('obsidian_tc_http_construct_seconds{vault="http"} 0.0142');
    // An INFO metric: the value is always 1 and carries nothing; the LABEL is the datum.
    expect(text).toContain(
      'obsidian_tc_vec_fingerprint_active{vault="index",fingerprint="ollama|bge-m3|1024|cosine|0|1|v3"} 1',
    );
  });

  it("reports no http-construct series on a stdio-only server rather than a fake zero", async () => {
    // Reporting 0 would claim the transport was constructed instantly. It was never constructed.
    const text = await new MetricsRecorder({ httpConstructSeconds: () => [] }).metrics();
    expect(text).toContain("# TYPE obsidian_tc_http_construct_seconds gauge");
    expect(text).not.toMatch(/^obsidian_tc_http_construct_seconds\{/m);
  });

  it("counts vec fallbacks separately by reason (THE-585)", async () => {
    const r = new MetricsRecorder();
    r.incVecFallback("main", "error");
    r.incVecFallback("main", "error");
    r.incVecFallback("main", "underfill");
    const text = await r.metrics();
    // Separate series per reason: "vec0 threw" and "ACL crowding" have different causes and
    // different fixes, so collapsing them would report a number nobody can act on.
    expect(text).toContain('obsidian_tc_vec_fallback_total{vault="main",reason="error"} 2');
    expect(text).toContain('obsidian_tc_vec_fallback_total{vault="main",reason="underfill"} 1');
  });

  // THE-507: the gauge must reflect the CACHE's own counters, not a value the recorder invented.
  // Asserting only that the metric is registered would pass against a source that never fires —
  // the same measures-nothing-while-green shape the perf collectors refuse.
  it("reports query-cache effectiveness from the cache's own stats, by cache name", async () => {
    const stats = { results: { hits: 7, misses: 3, evictions: 2, expirations: 1 } };
    const r = new MetricsRecorder({
      queryCacheHits: () => [{ vault: "results", value: stats.results.hits }],
      queryCacheMisses: () => [{ vault: "results", value: stats.results.misses }],
      queryCacheEvictions: () => [{ vault: "results", value: stats.results.evictions }],
      queryCacheExpirations: () => [{ vault: "results", value: stats.results.expirations }],
    });
    let text = await r.metrics();
    expect(text).toContain('obsidian_tc_query_cache_hits_total{vault="results"} 7');
    expect(text).toContain('obsidian_tc_query_cache_misses_total{vault="results"} 3');
    expect(text).toContain('obsidian_tc_query_cache_evictions_total{vault="results"} 2');
    expect(text).toContain('obsidian_tc_query_cache_expirations_total{vault="results"} 1');

    // Re-scraped, it must track the cache rather than latch its first reading.
    stats.results.hits = 11;
    text = await r.metrics();
    expect(text).toContain('obsidian_tc_query_cache_hits_total{vault="results"} 11');
  });

  it("exposes recorded tool-call counters and histograms by label", async () => {
    const r = new MetricsRecorder();
    r.observeToolCall("main", "read_note", "ok", 0.012, 2048);
    r.observeToolCall("main", "read_note", "ok", 0.02, 4096);
    r.observeToolCall("main", "bulk_create_notes", "denied", 0.001, 60);
    const text = await r.metrics();
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="read_note",status="ok"} 2',
    );
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="main",tool="bulk_create_notes",status="denied"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_tool_duration_seconds_count{vault="main",tool="read_note"} 2',
    );
  });

  it("uses the G2.4 log-spaced response-byte buckets (1k/10k/100k/1M/10M)", async () => {
    const r = new MetricsRecorder();
    r.observeToolCall("main", "search_vault", "ok", 0.05, 5000);
    const text = await r.metrics();
    const bucketLines = text
      .split("\n")
      .filter((l) => l.startsWith("obsidian_tc_response_bytes_bucket"));
    const les = bucketLines.map((l) => l.match(/le="([^"]+)"/)?.[1]).filter(Boolean);
    // The small buckets are unambiguous; assert those exactly plus the implicit +Inf, and
    // pin the count (5 spec buckets + +Inf) so the bucket set is exactly the G2.4 catalog.
    expect(les, bucketLines.join("\n")).toContain("1000");
    expect(les).toContain("10000");
    expect(les).toContain("100000");
    expect(les).toContain("+Inf");
    expect(les.length).toBe(6);
  });

  it("counts ACL denials, governor truncations, rate-limit hits, and dropped events", async () => {
    const r = new MetricsRecorder();
    r.incAclDenied("main", "write", "scope_denied");
    r.incGovernorTruncation("main", "search_vault");
    r.incRateLimitHit("main", "bulk");
    r.incMorgianaDropped("main", "spool_write_failed");
    const text = await r.metrics();
    expect(text).toContain(
      'obsidian_tc_acl_denied_total{vault="main",scope_class="write",reason="scope_denied"} 1',
    );
    expect(text).toContain(
      'obsidian_tc_governor_truncations_total{vault="main",tool="search_vault"} 1',
    );
    expect(text).toContain('obsidian_tc_rate_limit_hits_total{vault="main",scope_class="bulk"} 1');
    expect(text).toContain(
      'obsidian_tc_morgiana_emit_dropped_total{vault="main",reason="spool_write_failed"} 1',
    );
  });

  it("reads gauges from injected per-vault sources at scrape time", async () => {
    let depth = 3;
    const r = new MetricsRecorder({
      captureQueueDepth: () => [{ vault: "main", value: depth }],
    });
    expect(await r.metrics()).toContain('obsidian_tc_capture_queue_depth{vault="main"} 3');
    depth = 7; // re-read live at the next scrape
    expect(await r.metrics()).toContain('obsidian_tc_capture_queue_depth{vault="main"} 7');
  });

  it("exposes the Prometheus text content type", () => {
    expect(new MetricsRecorder().contentType).toContain("text/plain");
  });
});
