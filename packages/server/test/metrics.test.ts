import { describe, expect, it } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";

// The exact catalog: 14 counters, 2 histograms, 4 gauges (G2.4's 10 + THE-507's 4 ingest).
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
  "obsidian_tc_embed_batch_rejections_total",
  "obsidian_tc_index_write_failures_total",
];
const HISTOGRAMS = ["obsidian_tc_tool_duration_seconds", "obsidian_tc_response_bytes"];
const GAUGES = [
  "obsidian_tc_active_sessions",
  "obsidian_tc_capture_queue_depth",
  "obsidian_tc_elicit_tokens_pending",
  "obsidian_tc_idempotency_cache_bytes",
  // THE-507: retrieval-cache effectiveness. Gauges rather than counters because the cache owns
  // the cumulative numbers and the recorder only reads them — a Counter would require the cache
  // to call INTO the recorder, inverting the one-way dependency the composition root maintains.
  "obsidian_tc_query_cache_hits_total",
  "obsidian_tc_query_cache_misses_total",
  "obsidian_tc_query_cache_evictions_total",
  "obsidian_tc_query_cache_expirations_total",
];

describe("MetricsRecorder (G2.4 Prometheus catalog)", () => {
  it("registers the full catalog: 14 counters, 2 histograms, 8 gauges", async () => {
    const text = await new MetricsRecorder().metrics();
    for (const name of COUNTERS) expect(text).toContain(`# TYPE ${name} counter`);
    for (const name of HISTOGRAMS) expect(text).toContain(`# TYPE ${name} histogram`);
    for (const name of GAUGES) expect(text).toContain(`# TYPE ${name} gauge`);
    // Catalog is complete and exactly the spec'd size (no extra obsidian_tc_* metrics).
    const declared = [...text.matchAll(/^# TYPE (obsidian_tc_\w+) /gm)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(24);
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
