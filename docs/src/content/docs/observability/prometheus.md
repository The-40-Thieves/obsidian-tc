---
title: Prometheus Metrics
description: The metrics catalog and the optional, auth-gated /metrics scrape endpoint.
---

<!-- BEGIN GENERATED: metrics-catalog -->
obsidian-tc maintains a Prometheus catalog of **26 counters, 4 histograms, 16 gauges**. The recorder is always live so the `get_metrics` tool and the optional `/metrics` scrape endpoint share the same in-memory state. Every catalog name below is registered so `/metrics` is catalog-complete even before a metric has live traffic to report.

### Counters

| Name | Labels | Help |
|---|---|---|
| `obsidian_tc_acl_denied_total` | `reason`, `scope_class`, `vault` | ACL/scope denials by vault, scope class, and reason. |
| `obsidian_tc_activation_recompute_chunks_total` | `vault` | Chunks whose cached_activation_score was recomputed by the periodic ACT-R activation job, by job name. Cumulative. A flat line while the scheduler reports the job running means chunk_retrievals has stopped growing, not that the job stalled. |
| `obsidian_tc_audit_write_failed_total` | `tool`, `vault` | Security-audit event writes that failed, by vault and tool. Audit is fail-open by design (a failed write must never break dispatch), so this counter is the only signal that the audit trail has gone lossy. |
| `obsidian_tc_auth_rejections_total` | `reason` | Refused tokens at the HTTP edge, by rejection reason. |
| `obsidian_tc_embed_batch_rejections_total` | `vault` | Embed requests the provider rejected for exceeding its context (HTTP 400/413), then bisected + retried, by vault. Each is an extra round-trip; a persistent count means embeddings.maxBatchTokens is too high. |
| `obsidian_tc_governor_truncations_total` | `tool`, `vault` | Response-byte governor truncations/refusals, by vault and tool. |
| `obsidian_tc_hitl_elicited_total` | `tool`, `vault` | HITL elicit confirmations required, by vault and tool. |
| `obsidian_tc_idempotency_cache_skipped_total` | `tool`, `vault` | Idempotency results skipped over the byte cap, by vault and tool. |
| `obsidian_tc_idempotency_hits_total` | `tool`, `vault` | Idempotency cache hits, by vault and tool. |
| `obsidian_tc_idempotency_release_failed_total` | `gate`, `tool`, `vault` | Idempotency claims that could not be RELEASED after a dispatch was rejected at the throttle or HITL gate, by vault, tool and gate. The release is best-effort so a failure never masks the rejection the caller must see — which also means this counter is its only signal. Non-zero has a concrete cost: the claim survives, and because an orphaned row is neither expired (idempotencyTtlSeconds, default 24h) nor reclaimable (idempotencyReclaimSeconds, default 60s) yet, the retry the rejection explicitly invited comes back as idempotency_in_flight instead. There is no benign value. |
| `obsidian_tc_index_write_failures_total` | `vault` | Notes skipped in a pass because the embed provider rejected them even at single-text size, by vault. Unlike the batch rejections above these are NOT retried within the pass, so the note is absent from the index until the next reconcile. |
| `obsidian_tc_ingest_dedup_skipped_total` | `vault` | Chunks whose embedding was reused from an identical-body sibling instead of recomputed, by vault. This is work AVOIDED, so a rise is good ONLY for the chunks it actually resolved — see obsidian_tc_ingest_dedup_unresolved_total for the subset that copied nothing; a fall in this counter means the dedup path stopped matching. |
| `obsidian_tc_ingest_dedup_unresolved_total` | `vault` | Chunks skipped for embedding by cross-path dedup whose source had no stored vector to copy, by vault. A rise is BAD — these chunks are FTS-only (no dense/sparse/colbert) until the owner note re-embeds successfully; it is the loss side of obsidian_tc_ingest_dedup_skipped_total, not work avoided. |
| `obsidian_tc_ingest_secrets_skipped_total` | `vault` | Chunks the secret gate refused to index, by vault. Non-zero is expected on a vault containing credentials; a SUDDEN rise means content that used to index no longer does. |
| `obsidian_tc_morgiana_emit_dropped_total` | `reason`, `vault` | MORGIANA events dropped, by vault and reason. |
| `obsidian_tc_output_schema_drift_total` | `tool`, `vault` | Handler payloads that did not match their advertised outputSchema, by vault and tool. In production this is WARN-only — the payload still ships — so a non-zero value is the only signal that a tool's declared contract has drifted from what it returns. In dev/CI the same condition is a hard internal_error. Any non-zero count names a tool whose schema or handler is wrong; there is no benign case. |
| `obsidian_tc_rate_limit_hits_total` | `scope_class`, `vault` | Rate-limit refusals, by vault and scope class. |
| `obsidian_tc_rerank_outcome_total` | `outcome`, `vault` | rerankWithScores decisions, by vault and outcome. executed is the only outcome where the reported ranking actually came from the reranker; every other value is the synthetic-descending-score fallback for a different reason — not_configured (no reranker injected), skipped_by_policy (gatedRerank's hardness gate did not fire), timed_out, malformed_response (the call returned but produced no usable hit), provider_error (the call rejected for any other reason), fallback_used (no more specific reason — e.g. an empty candidate set). |
| `obsidian_tc_retrieval_content_bytes_in_total` | `stage`, `vault` | Content bytes materialized entering a stage boundary, by vault and stage. Populated only at candidateAssembly (pre-dedup, across streams) and diversity/gatedRerank (pre-top-K-cut). Compare to the _out_ counter for the same stage: the gap is hydrated content that was never used. |
| `obsidian_tc_retrieval_content_bytes_out_total` | `stage`, `vault` | Content bytes surviving a stage boundary, by vault and stage. See the _in_ counter. |
| `obsidian_tc_retrieval_stage_candidates_in_total` | `stage`, `vault` | Candidates entering each graph-search stage, by vault and stage. Divide the _out_ counter by this for the stage's pass-through ratio: a stage sitting at 1.0 is no longer filtering anything while still costing its latency. |
| `obsidian_tc_retrieval_stage_candidates_out_total` | `stage`, `vault` | Candidates leaving each graph-search stage, by vault and stage. See the _in_ counter. |
| `obsidian_tc_sql_busy_total` | `reason`, `txn`, `vault` | Write transactions that failed on a busy database, by vault, transaction, and reason. reason=busy means contention outlived busy_timeout (5s) — the writers genuinely overlap that long. reason=snapshot is a BUG REPORT, not tuning: it can only be produced by a deferred BEGIN that read and then tried to write, a failure busy_timeout cannot retry, so any non-zero count names a write path still using BEGIN where it should use inWriteTransaction. |
| `obsidian_tc_tool_calls_total` | `status`, `tool`, `vault` | Tool calls by vault, tool, and terminal status. |
| `obsidian_tc_vec_fallback_total` | `reason`, `vault` | Searches that abandoned the vec0 KNN index for the exhaustive brute-force scan, by vault and reason. Results stay correct; the cost profile does not. reason=error is usually a dimension mismatch after an embedding-model change (the index no longer matches the query) and a persistent count means a real misconfiguration; reason=underfill means ACL-invisible chunks may be crowding out visible ones, so the over-fetch could not fill k visible hits. |
| `obsidian_tc_vec_rebuild_total` | `reason` | vec_chunks DROP+rebuild events, by reason. legacy_shape is a one-time pre-partition upgrade; fingerprint_changed means the embedding provider/model/dimensions, distance metric, or chunk/enrichment representation changed since the index was built. Either way every vault's dense index is cold until it re-embeds — any non-zero count outside a deliberate model migration is worth investigating. |

### Histograms

| Name | Labels | Buckets | Help |
|---|---|---|---|
| `obsidian_tc_response_bytes` | `tool`, `vault` | 1000, 10000, 100000, 1000000, 10000000 | Tool response size in bytes, by vault and tool. |
| `obsidian_tc_retrieval_stage_duration_seconds` | `stage`, `vault` | 0.0005, 0.002, 0.01, 0.05, 0.25, 1 | Wall time per named graph-search stage, by vault and stage. |
| `obsidian_tc_sql_lock_wait_seconds` | `txn`, `vault` | 0.001, 0.01, 0.1, 0.5, 1, 5, 10 | Seconds spent acquiring SQLite's write lock (BEGIN IMMEDIATE), by vault and transaction. Only writers contend under WAL, so a rising tail here is the direct evidence for splitting the shared database per vault. Failed acquisitions are observed too, and land just ABOVE busy_timeout (5s) rather than at it — count the 5..10s band to find transactions that waited out the timeout and then threw. |
| `obsidian_tc_tool_duration_seconds` | `tool`, `vault` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 | Tool execution wall time in seconds, by vault and tool. |

### Gauges

| Name | Labels | Help |
|---|---|---|
| `obsidian_tc_active_sessions` | `vault` | Active workspace sessions, by vault. |
| `obsidian_tc_capture_queue_depth` | `vault` | Pending capture-queue items, by vault. |
| `obsidian_tc_elicit_tokens_pending` | `vault` | Unconsumed elicit tokens, by vault. |
| `obsidian_tc_http_construct_seconds` | `vault` | Seconds spent constructing the HTTP app/transport at boot, by subsystem. One sample per process. |
| `obsidian_tc_idempotency_cache_bytes` | `vault` | Idempotency cache size in bytes, by vault. |
| `obsidian_tc_index_active` | `vault` | Index operations currently executing, by vault. |
| `obsidian_tc_index_coalesced_total` | `vault` | Index writes avoided by per-(vault,path) coalescing — a pending op replaced by a newer one before it ran. Cumulative. A RISE IS GOOD (work not done); a flat line under a bursty writer means coalescing stopped working. |
| `obsidian_tc_index_queue_depth` | `vault` | Paths with index work outstanding on the in-process coordinator chain, by subsystem. NOT the durable capture queue (see obsidian_tc_capture_queue_depth). |
| `obsidian_tc_query_cache_evictions_total` | `vault` | Entries dropped from the retrieval query cache because it was full (LRU), by cache name. Rising against a flat hit count means retrieval.cache.maxEntries is too small. Cumulative. |
| `obsidian_tc_query_cache_expirations_total` | `vault` | Entries found but past their TTL, by cache name — a miss that also proves the TTL is doing work, and distinguishes 'too small' from 'too short'. Cumulative. |
| `obsidian_tc_query_cache_hits_total` | `vault` | Retrieval query-cache hits, by cache name. Cumulative. |
| `obsidian_tc_query_cache_misses_total` | `vault` | Retrieval query-cache misses, by cache name. Cumulative. |
| `obsidian_tc_scheduler_consecutive_failures` | `vault` | Consecutive failures per job name — the exponent behind the scheduler's backoff. Non-zero means the job is currently backing off; it resets to 0 on the next success. |
| `obsidian_tc_scheduler_deferred_total` | `vault` | Due ticks deferred (not skipped) because the event-loop delay p99 exceeded eventLoopDeferMs, by job name. Cumulative. Stays 0 forever unless budget deferral is configured — a flat 0 does not mean deferral never mattered, it means it is off. |
| `obsidian_tc_scheduler_skipped_total` | `vault` | Due ticks skipped because the job's prior run was still in flight, by job name. Cumulative. Sustained growth means the job's interval is shorter than its runtime. |
| `obsidian_tc_vec_fingerprint_active` | `fingerprint`, `vault` | Always 1; the `fingerprint` label carries the embedding representation the vault's vector index was actually built under (provider/model/dimensions/metric/enrichment/chunker/schema). Lets a retrieval-quality change be correlated with a representation swap instead of guessed at. |
<!-- END GENERATED: metrics-catalog -->

Labels are deliberately **low-cardinality** — `vault` and `scope_class`, never raw
tool arguments or per-caller hashes — so the series count stays bounded.

## The /metrics endpoint

Disabled by default. When `observability.prometheus.enabled` is set, a small HTTP
listener serves `/metrics` on `prometheus.bind:port`. Its auth floor mirrors the
MCP HTTP transport:

- **loopback bind** → open;
- **non-loopback bind** → requires JWT;
- **non-loopback + `auth.mode: none`** → refused at startup.

```json
{
  "observability": {
    "prometheus": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 9464
    }
  }
}
```
