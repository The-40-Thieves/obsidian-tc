---
title: Prometheus Metrics
description: The metrics catalog and the optional, auth-gated /metrics scrape endpoint.
---

{/* BEGIN GENERATED: metrics-catalog */}
reliquary-tc maintains a Prometheus catalog of **36 counters, 4 histograms, 19 gauges**. The recorder is always live so the `get_metrics` tool and the optional `/metrics` scrape endpoint share the same in-memory state. Every catalog name below is registered so `/metrics` is catalog-complete even before a metric has live traffic to report.

### Counters {#counters}

| Name | Labels | Help |
|---|---|---|
| `reliquary_tc_acl_denied_total` | `reason`, `scope_class`, `vault` | ACL/scope denials by vault, scope class, and reason. |
| `reliquary_tc_acl_walk_pruned_total` | `vault` | Paths the graph-walk ACL filter excluded from a walk that an unfiltered walk over the same seed frontier would have reached, by vault. Zero for an unrestricted caller by construction (nothing to prune); a non-zero, rising count for a restricted one is the filter's recall cost made visible, not an error. |
| `reliquary_tc_activation_recompute_chunks_total` | `vault` | Chunks whose cached_activation_score was recomputed by the periodic ACT-R activation job, by job name. Cumulative. A flat line while the scheduler reports the job running means chunk_retrievals has stopped growing, not that the job stalled. |
| `reliquary_tc_audit_write_failed_total` | `tool`, `vault` | Security-audit event writes that failed, by vault and tool. Audit is fail-open by design (a failed write must never break dispatch), so this counter is the only signal that the audit trail has gone lossy. |
| `reliquary_tc_auth_family_revocations_total` | `reason` | OAuth grant-family revocations by the bundled authorization server, by reason. authorization_code_reuse, refresh_token_reuse and refresh_token_foreign mean a presented credential was a replay (or minted under a replaced server secret) and its whole family was revoked on sight (RFC 9700 section 4.14): any growth is worth investigating, since one leaked credential is a one-request kill switch on the client's session. revoked_by_client (RFC 7009) and authorization_code_failed are the benign counterparts. |
| `reliquary_tc_auth_rejections_total` | `reason` | Refused tokens at the HTTP edge, by rejection reason. |
| `reliquary_tc_embed_batch_rejections_total` | `vault` | Embed requests the provider rejected for exceeding its context (HTTP 400/413), then bisected + retried, by vault. Each is an extra round-trip; a persistent count means embeddings.maxBatchTokens is too high. |
| `reliquary_tc_embedder_host_recycles_total` | `reason` | Embedder child processes the burst-end recycle policy drained, by reason (reconcile = a finished index pass that embedded chunks, budget = parent + child RSS over embeddings.memoryBudgetMb at a write-queue drain while the parent alone is under it). Cumulative. A crash-restart is not counted here. |
| `reliquary_tc_governor_truncations_total` | `tool`, `vault` | Response-byte governor truncations/refusals, by vault and tool. |
| `reliquary_tc_hitl_elicited_total` | `tool`, `vault` | HITL elicit confirmations required, by vault and tool. |
| `reliquary_tc_idempotency_cache_skipped_total` | `tool`, `vault` | Idempotency results skipped over the byte cap, by vault and tool. |
| `reliquary_tc_idempotency_hits_total` | `tool`, `vault` | Idempotency cache hits, by vault and tool. |
| `reliquary_tc_idempotency_release_failed_total` | `gate`, `tool`, `vault` | Idempotency claims left ORPHANED because the final release attempt on a pre-handler failure failed, by vault, tool and the rejection gate that led there (throttle \| hitl \| other). Release is best-effort so it never masks the error the caller must see, which also makes this counter its only signal. Counted at the LAST attempt, not at the gate: the gates get a retry in the outer catch, so a gate-site failure that retry then cleans up leaves no orphan and is deliberately not counted. When this does fire the claim survives, and a matching retry inside the reclaim window (idempotencyReclaimSeconds, default 60s) returns idempotency_in_flight; at or after that window claimOrReplay reclaims the row. The 24h idempotencyTtlSeconds is the later alternate expiry, not the blocking bound. |
| `reliquary_tc_index_frontmatter_failures_total` | `vault` | Notes skipped in a pass because their frontmatter failed to parse as YAML, by vault. Not swept as stale (the note was still walked) and retried automatically on the next index_vault pass once the note's YAML is fixed — see doctor's index.coverage check for which paths. |
| `reliquary_tc_index_stale_skipped_total` | `vault` | Notes an indexVault batch skipped because a concurrent write_note/watcher commit changed the path's chunks after the plan was computed, by vault. Not a failure — the skipped note is re-planned against current content on the next index_vault pass. |
| `reliquary_tc_index_write_failures_total` | `vault` | Notes skipped in a pass because the embed provider rejected them even at single-text size, by vault. Unlike the batch rejections above these are NOT retried within the pass, so the note is absent from the index until the next reconcile. |
| `reliquary_tc_ingest_dedup_skipped_total` | `vault` | Chunks whose embedding was reused from an identical-body sibling instead of recomputed, by vault. This is work AVOIDED, so a rise is good ONLY for the chunks it actually resolved — see reliquary_tc_ingest_dedup_unresolved_total for the subset that copied nothing; a fall in this counter means the dedup path stopped matching. |
| `reliquary_tc_ingest_dedup_unresolved_total` | `vault` | Chunks skipped for embedding by cross-path dedup whose source had no stored vector to copy, by vault. A rise is BAD — these chunks are FTS-only (no dense/sparse/colbert) until the owner note re-embeds successfully; it is the loss side of reliquary_tc_ingest_dedup_skipped_total, not work avoided. |
| `reliquary_tc_ingest_secrets_skipped_total` | `vault` | Chunks the secret gate refused to index, by vault. Non-zero is expected on a vault containing credentials; a SUDDEN rise means content that used to index no longer does. |
| `reliquary_tc_memory_defense_hits_total` | `pattern` | memoryDefense (GH #994) redact/block matches, by pattern id only — no vault, tool, or content — so an operator sees the policy firing without reading what was matched. |
| `reliquary_tc_memory_orphans_swept_total` | `class` | Memory rows deleted by the periodic orphan sweep, by class (dangling_relations, dangling_intervals, retired_entities, removed_vault_entities, removed_vault_relations, removed_vault_intervals). Cumulative. Only the two dangling_* classes are on by default; the other four move only when the operator sets their retention window. A dry run does not increment it. |
| `reliquary_tc_morgiana_emit_dropped_total` | `reason`, `vault` | MORGIANA events dropped, by vault and reason. |
| `reliquary_tc_morgiana_spool_files_pruned_total` | `reason` | Morgiana event spool day files deleted by the retention sweep, by reason (age = older than observability.retention.spoolRetentionDays, size = oldest files dropped to fit spoolMaxBytes). Cumulative. The current day's file is never deleted. |
| `reliquary_tc_output_schema_drift_total` | `tool`, `vault` | Handler payloads that did not match their advertised outputSchema, by vault and tool. In production this is WARN-only — the payload still ships — so a non-zero value is the only signal that a tool's declared contract has drifted from what it returns. In dev/CI the same condition is a hard internal_error. Any non-zero count names a tool whose schema or handler is wrong; there is no benign case. |
| `reliquary_tc_provenance_faults_total` | `kind`, `tool`, `vault` | Write-provenance recording faults, by vault, tool and kind. `omitted`: a committed write left NO record (recording is fail-open, so the write still succeeded). `head_untrusted`: the record was written but the chain head failed validation and was not re-signed. Any non-zero value means the provenance trail is incomplete or was tampered with; doctor reports the same events from event_log. Labels are vault id, tool name and the two-value kind, never a path or an error message. |
| `reliquary_tc_rate_limit_backend_outages_total` | `backend` | Shared rate-limit backend outages (sqlite or redis unreachable), by backend. Counted once per outage, not per request; the failure policy decides what calls do meanwhile. |
| `reliquary_tc_rate_limit_hits_total` | `scope_class`, `vault` | Rate-limit refusals, by vault and scope class. |
| `reliquary_tc_rerank_outcome_total` | `outcome`, `vault` | rerankWithScores decisions, by vault and outcome. executed is the only outcome where the reported ranking actually came from the reranker; every other value is the synthetic-descending-score fallback for a different reason — not_configured (no reranker injected), skipped_by_policy (gatedRerank's hardness gate did not fire), timed_out, malformed_response (the call returned but produced no usable hit), provider_error (the call rejected for any other reason), fallback_used (no more specific reason — e.g. an empty candidate set). |
| `reliquary_tc_retrieval_content_bytes_in_total` | `stage`, `vault` | Content bytes materialized entering a stage boundary, by vault and stage. Populated only at candidateAssembly (pre-dedup, across streams) and diversity/gatedRerank (pre-top-K-cut). Compare to the _out_ counter for the same stage: the gap is hydrated content that was never used. |
| `reliquary_tc_retrieval_content_bytes_out_total` | `stage`, `vault` | Content bytes surviving a stage boundary, by vault and stage. See the _in_ counter. |
| `reliquary_tc_retrieval_stage_candidates_in_total` | `stage`, `vault` | Candidates entering each graph-search stage, by vault and stage. Divide the _out_ counter by this for the stage's pass-through ratio: a stage sitting at 1.0 is no longer filtering anything while still costing its latency. |
| `reliquary_tc_retrieval_stage_candidates_out_total` | `stage`, `vault` | Candidates leaving each graph-search stage, by vault and stage. See the _in_ counter. |
| `reliquary_tc_sql_busy_total` | `reason`, `txn`, `vault` | Write transactions that failed on a busy database, by vault, transaction, and reason. reason=busy means contention outlived busy_timeout (5s) — the writers genuinely overlap that long. reason=snapshot is a BUG REPORT, not tuning: it can only be produced by a deferred BEGIN that read and then tried to write, a failure busy_timeout cannot retry, so any non-zero count names a write path still using BEGIN where it should use inWriteTransaction. |
| `reliquary_tc_tool_calls_total` | `status`, `tool`, `vault` | Tool calls by vault, tool, and terminal status. |
| `reliquary_tc_vec_fallback_total` | `reason`, `vault` | Searches that abandoned the vec0 KNN index for the exhaustive brute-force scan, by vault and reason. Results stay correct; the cost profile does not. reason=error is usually a dimension mismatch after an embedding-model change (the index no longer matches the query) and a persistent count means a real misconfiguration; reason=underfill means ACL-invisible chunks may be crowding out visible ones, so the over-fetch could not fill k visible hits. |
| `reliquary_tc_vec_rebuild_total` | `reason` | vec_chunks DROP+rebuild events, by reason. legacy_shape is a one-time pre-partition upgrade; fingerprint_changed means the embedding provider/model/dimensions, distance metric, or chunk/enrichment representation changed since the index was built; table_missing means vec_chunks was absent over active embeddings and was rebuilt from them. Every vault's dense index is cold until it re-embeds — any non-zero count outside a deliberate model migration is worth investigating. |

### Histograms {#histograms}

| Name | Labels | Buckets | Help |
|---|---|---|---|
| `reliquary_tc_response_bytes` | `tool`, `vault` | 1000, 10000, 100000, 1000000, 10000000 | Tool response size in bytes, by vault and tool. |
| `reliquary_tc_retrieval_stage_duration_seconds` | `stage`, `vault` | 0.0005, 0.002, 0.01, 0.05, 0.25, 1 | Wall time per named graph-search stage, by vault and stage. |
| `reliquary_tc_sql_lock_wait_seconds` | `txn`, `vault` | 0.001, 0.01, 0.1, 0.5, 1, 5, 10 | Seconds spent acquiring SQLite's write lock (BEGIN IMMEDIATE), by vault and transaction. Only writers contend under WAL, so a rising tail here is the direct evidence for splitting the shared database per vault. Failed acquisitions are observed too, and land just ABOVE busy_timeout (5s) rather than at it — count the 5..10s band to find transactions that waited out the timeout and then threw. |
| `reliquary_tc_tool_duration_seconds` | `tool`, `vault` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 | Tool execution wall time in seconds, by vault and tool. |

### Gauges {#gauges}

| Name | Labels | Help |
|---|---|---|
| `reliquary_tc_active_sessions` | `vault` | Active workspace sessions, by vault. |
| `reliquary_tc_auth_keys` | `state` | Auth registry signing keys by lifecycle state (active, retiring, retired). retiring counts only keys whose grace window is still open; an elapsed window counts as retired before the reaper persists it. active should be exactly 1 once the registry is initialised. |
| `reliquary_tc_background_embed_paused` | `vault` | 1 while the boot/promotion/periodic reconcile's embed pass is paused waiting for the server to go idle (indexing.backgroundEmbed mode "idle"), 0 otherwise. |
| `reliquary_tc_capture_queue_depth` | `vault` | Pending capture-queue items, by vault. |
| `reliquary_tc_elicit_tokens_pending` | `vault` | Unconsumed elicit tokens, by vault. |
| `reliquary_tc_http_construct_seconds` | `vault` | Seconds spent constructing the HTTP app/transport at boot, by subsystem. One sample per process. |
| `reliquary_tc_idempotency_cache_bytes` | `vault` | Idempotency cache size in bytes, by vault. |
| `reliquary_tc_index_active` | `vault` | Index operations currently executing, by vault. |
| `reliquary_tc_index_coalesced_total` | `vault` | Index writes avoided by per-(vault,path) coalescing — a pending op replaced by a newer one before it ran. Cumulative. A RISE IS GOOD (work not done); a flat line under a bursty writer means coalescing stopped working. |
| `reliquary_tc_index_queue_depth` | `vault` | Paths with index work outstanding on the in-process coordinator chain, by subsystem. NOT the durable capture queue (see reliquary_tc_capture_queue_depth). |
| `reliquary_tc_process_memory_bytes` | `kind` | Process memory in bytes, by kind: rss (resident set), heap_used (JS heap in use), external (memory bound to JS objects but allocated natively), array_buffers (ArrayBuffer and SharedArrayBuffer backing stores). A sustained rss above the host's budget is the signal, not one sample. |
| `reliquary_tc_query_cache_evictions_total` | `vault` | Entries dropped from the retrieval query cache because it was full (LRU), by cache name. Rising against a flat hit count means retrieval.cache.maxEntries is too small. Cumulative. |
| `reliquary_tc_query_cache_expirations_total` | `vault` | Entries found but past their TTL, by cache name — a miss that also proves the TTL is doing work, and distinguishes 'too small' from 'too short'. Cumulative. |
| `reliquary_tc_query_cache_hits_total` | `vault` | Retrieval query-cache hits, by cache name. Cumulative. |
| `reliquary_tc_query_cache_misses_total` | `vault` | Retrieval query-cache misses, by cache name. Cumulative. |
| `reliquary_tc_scheduler_consecutive_failures` | `vault` | Consecutive failures per job name — the exponent behind the scheduler's backoff. Non-zero means the job is currently backing off; it resets to 0 on the next success. |
| `reliquary_tc_scheduler_deferred_total` | `vault` | Due ticks deferred (not skipped) because the event-loop delay p99 exceeded eventLoopDeferMs, by job name. Cumulative. Stays 0 forever unless budget deferral is configured — a flat 0 does not mean deferral never mattered, it means it is off. |
| `reliquary_tc_scheduler_skipped_total` | `vault` | Due ticks skipped because the job's prior run was still in flight, by job name. Cumulative. Sustained growth means the job's interval is shorter than its runtime. |
| `reliquary_tc_vec_fingerprint_active` | `fingerprint`, `vault` | Always 1; the `fingerprint` label carries the embedding representation the vault's vector index was actually built under (provider/model/dimensions/metric/enrichment/chunker/schema). Lets a retrieval-quality change be correlated with a representation swap instead of guessed at. |
{/* END GENERATED: metrics-catalog */}

Labels are deliberately **low-cardinality** — `vault` and `scope_class`, never raw
tool arguments or per-caller hashes — so the series count stays bounded.

## The /metrics endpoint {#the-metrics-endpoint}

Disabled by default. When `observability.prometheus.enabled` is set, a small HTTP
listener serves `/metrics` on `prometheus.bind:port`. Authentication follows `auth.mode`, not the
bind address:

- **`auth.mode: jwt` or `oidc`** → a verified bearer that holds the **`admin:metrics`** scope and is
  not bound to a vault or persona is required on **every** bind, **loopback included**. A loopback
  bind cannot tell a local scraper from a caller that a Cloudflare Tunnel, Tailscale Serve, an SSH
  reverse forward or a reverse proxy relayed to `127.0.0.1`, so it is not trusted as "local";
- **`auth.mode: none`, loopback bind** → open, no token needed (the single-user local default);
- **`auth.mode: none`, non-loopback bind** → refused at startup.

The token is verified by the same verifier instance the MCP HTTP transport uses, built once at boot
(every key source: `jwtSecret`, `jwks`, `jwksFile`, `jwksUri`, registry keys; the same audience,
issuer, `algorithms` and `requireJti`; or the OIDC provider under `auth.mode: oidc`). A token the
MCP edge accepts is verified identically here.

On a loopback bind the `Host` header is also checked with the MCP route's DNS-rebinding guard
(`transports.http.enableDnsRebindingProtection`, on by default): a request whose `Host` is not
loopback, the bind host, or listed in `transports.http.allowedHosts` is refused with `403`, before
authentication. If a tunnel or reverse proxy fronts the listener, add the public host name it
forwards (for example `metrics.example.com`) to `transports.http.allowedHosts`, and give the
scraper behind it an `admin:metrics` token, exactly as for a direct remote scrape.

The responses (when authentication is required) are:

| request | status |
|---|---|
| `Host` not allowed (loopback bind) | `403`, before any token is read |
| no bearer, or a bearer that fails verification | `401` |
| verified, but no `admin:metrics` grant | `403`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="admin:metrics"` |
| verified with the scope, but bound to a vault (`vault` claim) or a persona | `403` |
| verified, scope held, unbound | `200` |

`admin:metrics` is the scope the `get_metrics` tool already requires, and it is matched the same
way: `*`, `admin:*` and `admin` grant it; `read:*` and other `admin:` scopes do not. Under
`auth.mode: oidc` the scope has to come out of your `claimMapping` / `scopeMap` like any other.

Every series on this endpoint is process-wide and is computed without a per-caller ACL (queue
depths, call counts and ACL-denial counts for every vault), so the scope is the authorization and
there is no per-vault filtering: a token bound to one vault is refused rather than shown a subset.
For a per-vault view use the `get_metrics` tool, which pins a vault-bound caller to its own vault.

**Breaking for existing scrapers under `jwt` / `oidc`.** Before this change any verified token
could scrape a non-loopback bind (including one minted with `--scopes ""`), and a loopback bind
needed no token at all. Mint a dedicated scrape token and update the scraper, loopback or not:

```sh
reliquary-tc token mint --sub prometheus --scopes admin:metrics
```

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
