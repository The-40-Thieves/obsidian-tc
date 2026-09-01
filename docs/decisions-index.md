# Decisions index

This project tracks day-to-day planning work in Linear, a private issue tracker — source comments
and CHANGELOG entries routinely cite a `THE-xxx` ticket id as shorthand for "the discussion that
produced this." Those ids are not resolvable outside the maintainer team, which would otherwise
leave every outside contributor who hits one at a dead end. This index closes that gap: for every
`THE-xxx` cited under `packages/*/src`, it resolves the ticket to the best PUBLIC summary this
repo already has — the CHANGELOG entry that shipped it, or the design/ADR/spec doc that discusses
it — so the repository stays self-contained without anyone needing tracker access.

This file is **generated** — do not hand-edit it. Regenerate with `bun run docs:decisions-index`;
`bun run docs:decisions-index:check` fails if the committed table has drifted from the source
tree, and runs as part of the docs drift gate in CI.

| Ticket | Summary | Where the substance lives | Referencing files |
|---|---|---|---:|
| THE-44 | Derive-don't-mutate access instrumentation + knowledge-health scorecard (THE-44, THE-46). | CHANGELOG.md (1.8.0) | 7 |
| THE-46 | Derive-don't-mutate access instrumentation + knowledge-health scorecard (THE-44, THE-46). | CHANGELOG.md (1.8.0) | 1 |
| THE-48 | `gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616, THE-644 item 1). | CHANGELOG.md (1.14.0) | 4 |
| THE-73 | _internal planning reference — see repo history_ | — | 12 |
| THE-101 | `session_bootstrap` tool (THE-101). | CHANGELOG.md (1.4.0) | 3 |
| THE-132 | _internal planning reference — see repo history_ | — | 3 |
| THE-134 | _internal planning reference — see repo history_ | — | 2 |
| THE-135 | Graph densification (experimental, off by default) | CHANGELOG.md (1.9.1) | 2 |
| THE-136 | Anticipatory context prefetch (THE-136). | CHANGELOG.md (1.7.0) | 7 |
| THE-160 | _internal planning reference — see repo history_ | — | 2 |
| THE-170 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 8 |
| THE-175 | Source-agnostic ambient-capture import format + Pensieve adapter, staged via `capture_queue` (#841, THE-175). | CHANGELOG.md (1.23.0) | 16 |
| THE-176 | _internal planning reference — see repo history_ | — | 1 |
| THE-178 | _internal planning reference — see repo history_ | — | 1 |
| THE-180 | _internal planning reference — see repo history_ | — | 9 |
| THE-181 | _internal planning reference — see repo history_ | — | 10 |
| THE-182 | _internal planning reference — see repo history_ | — | 7 |
| THE-183 | Metrics Registry | docs/design/metrics-registry.md | 4 |
| THE-184 | _internal planning reference — see repo history_ | — | 1 |
| THE-185 | _internal planning reference — see repo history_ | — | 1 |
| THE-186 | _internal planning reference — see repo history_ | — | 1 |
| THE-187 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 8 |
| THE-193 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 2 |
| THE-196 | Retrieval claims corrected to match the code (external claim audit). | CHANGELOG.md (1.3.5) | 1 |
| THE-197 | Idempotency observability wired (THE-197). | CHANGELOG.md (1.3.0) | 4 |
| THE-198 | _internal planning reference — see repo history_ | — | 3 |
| THE-202 | _internal planning reference — see repo history_ | — | 1 |
| THE-207 | Templater expansion for periodic notes (THE-207). | CHANGELOG.md (1.3.0) | 3 |
| THE-208 | _internal planning reference — see repo history_ | — | 3 |
| THE-209 | In-session tool-invocation tracing (THE-209). | CHANGELOG.md (1.3.0) | 5 |
| THE-210 | `resources/read` and `resources/list` are now rate-limited and audited | CHANGELOG.md (1.10.0) | 9 |
| THE-211 | Metrics Registry | docs/design/metrics-registry.md | 2 |
| THE-212 | _internal planning reference — see repo history_ | — | 2 |
| THE-213 | _internal planning reference — see repo history_ | — | 1 |
| THE-219 | Tool-surface facade / progressive disclosure (THE-219 consolidation). | CHANGELOG.md (1.3.0) | 11 |
| THE-221 | Conditional temporal retrieval stream, flag-gated (THE-221 Phase 1). | CHANGELOG.md (1.6.0) | 5 |
| THE-222 | A ticket-drift gate that can actually fail (#761, #760, THE-540). | CHANGELOG.md (1.21.0) | 13 |
| THE-227 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 6 |
| THE-228 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 12 |
| THE-229 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 8 |
| THE-230 | Experiential caller-partition is now an authorization boundary, not a default filter | CHANGELOG.md (1.11.0) | 13 |
| THE-231 | Proactive lesson surfacing in vault_context (THE-231). | CHANGELOG.md (1.7.0) | 4 |
| THE-232 | _internal planning reference — see repo history_ | — | 3 |
| THE-233 | Retrieval claims corrected to match the code (external claim audit). | CHANGELOG.md (1.3.5) | 26 |
| THE-235 | _internal planning reference — see repo history_ | — | 4 |
| THE-237 | _internal planning reference — see repo history_ | — | 2 |
| THE-238 | A sanctioned, poison-scanned path for agent-synthesised notes (#814, THE-639). | CHANGELOG.md (1.22.0) | 11 |
| THE-239 | Dependency-aware deletion + hash-chained forget audit (THE-239). | CHANGELOG.md (1.8.0) | 9 |
| THE-249 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 2 |
| THE-250 | Per-caller tool-visibility filtering (THE-250): | CHANGELOG.md (1.2.1) | 4 |
| THE-251 | Terse search projection (THE-251). | CHANGELOG.md (1.3.0) | 2 |
| THE-252 | _internal planning reference — see repo history_ | — | 2 |
| THE-255 | Headless VaultBackend, lean v1 (THE-255): | CHANGELOG.md (1.2.1) | 7 |
| THE-258 | _internal planning reference — see repo history_ | — | 5 |
| THE-266 | Zero-copy `Float32Array` cosine on the native brute-force path (THE-266). | CHANGELOG.md (1.3.0) | 2 |
| THE-267 | `generate_uri`'s `vault` input is renamed `vault_name` (THE-589). | CHANGELOG.md (1.12.0) | 8 |
| THE-268 | Fail-closed ACL defaults (THE-268). | CHANGELOG.md (1.3.0) | 4 |
| THE-269 | Unicode-normalization-insensitive folder ACL (THE-272). | CHANGELOG.md (1.3.0) | 2 |
| THE-270 | Bridge tools fail closed under a read whitelist (THE-270). | CHANGELOG.md (1.3.0) | 4 |
| THE-271 | DNS-rebinding / cross-origin protection on the HTTP transport (THE-271). | CHANGELOG.md (1.3.0) | 2 |
| THE-272 | Intermediate-directory symlink-swap TOCTOU closed (THE-272). | CHANGELOG.md (1.3.5) | 3 |
| THE-273 | SQLite per-connection baseline + prepared-statement cache (THE-273). | CHANGELOG.md (1.3.0) | 4 |
| THE-275 | Domain-verb facade mode (shipped under THE-275 — see correction). | CHANGELOG.md (1.3.0) | 3 |
| THE-277 | vec0 index: per-vault partition key + metadata aux columns (THE-277). | CHANGELOG.md (1.8.0) | 6 |
| THE-278 | Build hygiene (THE-278). | CHANGELOG.md (1.3.3) | 8 |
| THE-280 | Bases model realigned to shipped Obsidian 1.12 syntax, additive-with-deprecation (THE-280). | CHANGELOG.md (1.3.0) | 2 |
| THE-281 | Obsidian-fit fixes (THE-284). | CHANGELOG.md (1.3.0) | 2 |
| THE-282 | Companion installable-product hardening (THE-282). | CHANGELOG.md (1.3.0) | 7 |
| THE-284 | Obsidian-fit fixes (THE-284). | CHANGELOG.md (1.3.0) | 2 |
| THE-286 | Uniform symlink-canonical ACL enforcement (THE-286). | CHANGELOG.md (1.3.0) | 1 |
| THE-287 | The lexical and sparse arms filter by ACL at query time (THE-632, #644). | CHANGELOG.md (1.14.0) | 7 |
| THE-288 | Config keys `transports.stdio` + `throttle.enabled` are now honored (THE-288). | CHANGELOG.md (1.3.0) | 8 |
| THE-289 | Documented the companion trust boundary (THE-289). | CHANGELOG.md (1.3.0) | 2 |
| THE-291 | Index-on-write now covers every M1 note mutation (THE-291, part 1). | CHANGELOG.md (1.3.0) | 23 |
| THE-292 | Compare-and-swap for JSON-config edits (THE-292). | CHANGELOG.md (1.3.0) | 5 |
| THE-293 | Compute-abuse budgets (THE-293). | CHANGELOG.md (1.3.0) | 11 |
| THE-294 | Memoized per-request schema + capability-search work (THE-294, partial). | CHANGELOG.md (1.3.0) | 3 |
| THE-295 | Per-vault ACL (THE-295). | CHANGELOG.md (1.3.0) | 9 |
| THE-296 | Reconciled the retrieval-quality numbers | CHANGELOG.md (1.11.0) | 2 |
| THE-297 | `auth.jwksUri` — a key source that can rotate (THE-658, #556). | CHANGELOG.md (1.13.1) | 4 |
| THE-302 | `elicitTtlSeconds` now governs HITL token TTL (THE-302). | CHANGELOG.md (1.3.3) | 2 |
| THE-303 | Accepted-residuals section + release runbook. | CHANGELOG.md (1.3.3) | 2 |
| THE-308 | Cohere query embeddings use the query encoding (THE-308). | CHANGELOG.md (1.3.5) | 2 |
| THE-309 | `knowledge_challenge` gives the judge tags + open contradictions (THE-309). | CHANGELOG.md (1.3.5) | 2 |
| THE-310 | Namespaced the derived-cognition plane | CHANGELOG.md (1.11.0) | 6 |
| THE-316 | Cache the indexer reconcile-path statements | CHANGELOG.md (1.11.0) | 3 |
| THE-374 | _internal planning reference — see repo history_ | — | 7 |
| THE-375 | _internal planning reference — see repo history_ | — | 1 |
| THE-376 | _internal planning reference — see repo history_ | — | 3 |
| THE-378 | Obsidian Git + Remotely Save bridges (THE-378, THE-381). | CHANGELOG.md (1.8.0) | 3 |
| THE-379 | _internal planning reference — see repo history_ | — | 1 |
| THE-380 | _internal planning reference — see repo history_ | — | 1 |
| THE-381 | Obsidian Git + Remotely Save bridges (THE-378, THE-381). | CHANGELOG.md (1.8.0) | 2 |
| THE-383 | _internal planning reference — see repo history_ | — | 1 |
| THE-387 | _internal planning reference — see repo history_ | — | 6 |
| THE-388 | Configurable `bge-m3` embeddings provider (THE-395). | CHANGELOG.md (1.5.0) | 12 |
| THE-390 | Embed batches no longer overrun a small provider context, and a rejected request no longer aborts the whole reindex (THE-390). | CHANGELOG.md (1.5.0) | 7 |
| THE-391 | _internal planning reference — see repo history_ | — | 6 |
| THE-393 | _internal planning reference — see repo history_ | — | 7 |
| THE-394 | _internal planning reference — see repo history_ | — | 5 |
| THE-395 | Configurable `bge-m3` embeddings provider (THE-395). | CHANGELOG.md (1.5.0) | 3 |
| THE-397 | graph_rrf fusion constant k: 60 → 10 (THE-397), config-exposed as `retrieval.rrfK`. | CHANGELOG.md (1.5.0) | 3 |
| THE-398 | Convex-combination fusion mode, flag-gated (THE-398). | CHANGELOG.md (1.5.0) | 4 |
| THE-400 | Z-margin confidence signal (THE-400). | CHANGELOG.md (1.5.0) | 4 |
| THE-401 | Smooth expansion scoring, flag-gated (THE-401). | CHANGELOG.md (1.5.0) | 3 |
| THE-403 | _internal planning reference — see repo history_ | — | 1 |
| THE-405 | Asymmetric embedding prefixes, config-driven (THE-405). | CHANGELOG.md (1.5.0) | 4 |
| THE-406 | Conditional temporal retrieval stream, flag-gated (THE-221 Phase 1). | CHANGELOG.md (1.6.0) | 13 |
| THE-408 | `embeddings.chunkContext` now defaults ON (THE-408). | CHANGELOG.md (1.6.0) | 4 |
| THE-413 | At-most-once idempotency under post-effect faults | CHANGELOG.md (1.11.0) | 2 |
| THE-414 | Folder-ACL enforcement is now a dispatch-pipeline stage, not a per-handler convention | CHANGELOG.md (1.11.0) | 8 |
| THE-415 | Prompts run through governance | CHANGELOG.md (1.11.0) | 6 |
| THE-417 | Every registered tool declares an `outputSchema` | CHANGELOG.md (1.12.0) | 44 |
| THE-418 | _internal planning reference — see repo history_ | — | 1 |
| THE-420 | Citation stage-1 is ~24x faster (#669). | CHANGELOG.md (1.16.0) | 4 |
| THE-421 | THE-459 — Synthetic-vault perf harness + CI gates (design) | docs/superpowers/specs/2026-07-20-the-459-perf-harness-design.md | 1 |
| THE-424 | `indexing.chunkTokens` gives the chunk-size budget a config handle (#765, THE-424). | CHANGELOG.md (1.22.0) | 16 |
| THE-441 | Vendor / external-docs read surface (THE-444). | CHANGELOG.md (1.11.0) | 2 |
| THE-445 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 2 |
| THE-447 | _internal planning reference — see repo history_ | — | 1 |
| THE-448 | Multi-query fan-out | CHANGELOG.md (1.12.0) | 9 |
| THE-450 | _internal planning reference — see repo history_ | — | 5 |
| THE-451 | Graph Search — vault_graph_search tool | docs/design/graph-search.md | 3 |
| THE-452 | Graph analytics | CHANGELOG.md (1.12.0) | 3 |
| THE-453 | ACL: folder rules, glob matching, and the fingerprint cache key | docs/design/acl-folder-rules.md | 4 |
| THE-454 | _internal planning reference — see repo history_ | — | 5 |
| THE-455 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 7 |
| THE-456 | `jwksUri` is covered by the audience-binding gate (THE-658, #556). | CHANGELOG.md (1.13.1) | 6 |
| THE-457 | Retrieval: dense (vec0) index and brute-force fallback | docs/design/retrieval-dense-index.md | 10 |
| THE-458 | Periodic vault reconcile | CHANGELOG.md (1.12.0) | 11 |
| THE-459 | THE-459 — Synthetic-vault perf harness + CI gates (design) | docs/superpowers/specs/2026-07-20-the-459-perf-harness-design.md | 3 |
| THE-460 | Pluggable embedding and rerank provider slots (THE-677, #628, #631). | CHANGELOG.md (1.14.0) | 10 |
| THE-461 | Migration Manifest | docs/design/migration-manifest.md | 7 |
| THE-462 | The scheduler's backoff cap had become a global 5-minute ceiling on every background job (#687, THE-723). | CHANGELOG.md (1.18.0) | 10 |
| THE-463 | _internal planning reference — see repo history_ | — | 2 |
| THE-465 | Metrics Registry | docs/design/metrics-registry.md | 13 |
| THE-466 | Server Runtime — Composition Root | docs/design/server-runtime.md | 8 |
| THE-467 | Metrics Registry | docs/design/metrics-registry.md | 3 |
| THE-486 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 3 |
| THE-487 | _internal planning reference — see repo history_ | — | 1 |
| THE-488 | _internal planning reference — see repo history_ | — | 5 |
| THE-489 | _internal planning reference — see repo history_ | — | 2 |
| THE-490 | _internal planning reference — see repo history_ | — | 8 |
| THE-491 | _internal planning reference — see repo history_ | — | 7 |
| THE-496 | ACL: folder rules, glob matching, and the fingerprint cache key | docs/design/acl-folder-rules.md | 11 |
| THE-497 | Query-product cache | CHANGELOG.md (1.12.0) | 11 |
| THE-499 | _internal planning reference — see repo history_ | — | 3 |
| THE-500 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 2 |
| THE-501 | _internal planning reference — see repo history_ | — | 2 |
| THE-502 | _internal planning reference — see repo history_ | — | 2 |
| THE-504 | Citation inference | docs/design/experiential-citation-inference.md | 5 |
| THE-507 | SQL write-lock wait, vec fallbacks, coalesced writes, scheduler health, HTTP construct time, retrieval stage funnel, content-bytes, ingest counters, query-cache effectiveness, cold-start `boot.*` | CHANGELOG.md (1.12.0) | 7 |
| THE-509 | _internal planning reference — see repo history_ | — | 2 |
| THE-510 | Release and CI: draft-release no longer races itself on the plugin zip, and the release is verified whole (#695, THE-731); the quiet-host perf calibration is keyed by CPU architecture (#699, THE-510). | CHANGELOG.md (1.20.0) | 1 |
| THE-512 | Error catalog, generated config defaults, and an error-envelope gate (THE-470, #561). | CHANGELOG.md (1.14.0) | 1 |
| THE-513 | Idempotency and `vaultArg` declared on the tool surface | CHANGELOG.md (1.12.0) | 4 |
| THE-514 | `AbortSignal` threaded through the dispatch pipeline | CHANGELOG.md (1.12.0) | 12 |
| THE-515 | SQL write-lock wait, vec fallbacks, coalesced writes, scheduler health, HTTP construct time, retrieval stage funnel, content-bytes, ingest counters, query-cache effectiveness, cold-start `boot.*` | CHANGELOG.md (1.12.0) | 2 |
| THE-516 | _internal planning reference — see repo history_ | — | 6 |
| THE-517 | Background workloads run on the durable `JobQueue` | CHANGELOG.md (1.11.0) | 6 |
| THE-518 | Config provenance | CHANGELOG.md (1.12.0) | 5 |
| THE-520 | _internal planning reference — see repo history_ | — | 5 |
| THE-521 | _internal planning reference — see repo history_ | — | 9 |
| THE-522 | _internal planning reference — see repo history_ | — | 9 |
| THE-523 | _internal planning reference — see repo history_ | — | 6 |
| THE-526 | _internal planning reference — see repo history_ | — | 4 |
| THE-527 | _internal planning reference — see repo history_ | — | 4 |
| THE-530 | _internal planning reference — see repo history_ | — | 7 |
| THE-531 | _internal planning reference — see repo history_ | — | 7 |
| THE-532 | Densify directly instead of a full reindex per cell | CHANGELOG.md (1.12.0) | 2 |
| THE-533 | Forward vector scope closes the delta-kNN discovery gap | CHANGELOG.md (1.12.0) | 2 |
| THE-535 | `experiential.activationRerank` now applies a ranking change (#762, THE-424 Part A, THE-535). | CHANGELOG.md (1.21.0) | 3 |
| THE-536 | _internal planning reference — see repo history_ | — | 2 |
| THE-537 | `gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616, THE-644 item 1). | CHANGELOG.md (1.14.0) | 8 |
| THE-538 | Retrieval policy provenance | CHANGELOG.md (1.12.0) | 11 |
| THE-543 | All-source ACL on derived objects before return / model egress | CHANGELOG.md (1.11.0) | 5 |
| THE-545 | _internal planning reference — see repo history_ | — | 1 |
| THE-546 | _internal planning reference — see repo history_ | — | 1 |
| THE-548 | _internal planning reference — see repo history_ | — | 3 |
| THE-561 | Full 2026-07-28 conformance (#544): `server/discover`, SEP-2243 routing headers, SEP-2549 cache hints (THE-583). | CHANGELOG.md (1.13.0) | 2 |
| THE-562 | `SECURITY.md` supported-version table corrected and drift-gated | CHANGELOG.md (1.12.0) | 14 |
| THE-563 | Four introspection tools leaked cross-vault identifiers to a vault-bound HTTP caller (THE-924, #864). | CHANGELOG.md (1.23.4) | 12 |
| THE-564 | All-source ACL on derived objects before return / model egress | CHANGELOG.md (1.11.0) | 3 |
| THE-565 | _internal planning reference — see repo history_ | — | 4 |
| THE-567 | Per-path rule-scopes are now enforced | CHANGELOG.md (1.11.0) | 4 |
| THE-568 | `record_retrieval_feedback` was unreachable, and failed silently (#677, THE-718). | CHANGELOG.md (1.17.0) | 9 |
| THE-569 | Vault isolation `kind` is now a code-enforced property | CHANGELOG.md (1.11.0) | 3 |
| THE-571 | Jobs-table growth bounded | CHANGELOG.md (1.12.0) | 4 |
| THE-572 | No keyed handler duplicates user data on retry | CHANGELOG.md (1.11.0) | 16 |
| THE-573 | `add_observation`'s read + render + append share one write lock | CHANGELOG.md (1.12.0) | 3 |
| THE-577 | Tool-count gate no longer passes while stale | CHANGELOG.md (1.12.0) | 2 |
| THE-578 | Migration SQL embedded | CHANGELOG.md (1.12.0) | 3 |
| THE-579 | `vault_generation` bumped by derived-plane writers too | CHANGELOG.md (1.12.0) | 3 |
| THE-582 | Exact KNN ties broken by `chunk_id` | CHANGELOG.md (1.12.0) | 4 |
| THE-583 | MCP SDK v2 + the 2026-07-28 protocol revision, alongside 2025-11-25 (THE-583, #543). | CHANGELOG.md (1.13.0) | 18 |
| THE-585 | SQL write-lock wait, vec fallbacks, coalesced writes, scheduler health, HTTP construct time, retrieval stage funnel, content-bytes, ingest counters, query-cache effectiveness, cold-start `boot.*` | CHANGELOG.md (1.12.0) | 24 |
| THE-588 | Unresolved side of cross-path dedup counted | CHANGELOG.md (1.12.0) | 7 |
| THE-589 | `generate_uri`'s `vault` input is renamed `vault_name` (THE-589). | CHANGELOG.md (1.12.0) | 1 |
| THE-590 | `recordIngestStats` threaded through the MCP `index_vault` path | CHANGELOG.md (1.12.0) | 3 |
| THE-591 | Docs no longer describe deleted config keys as working | CHANGELOG.md (1.12.0) | 7 |
| THE-600 | `work_forget` writes the forget-log audit row | CHANGELOG.md (1.12.0) | 4 |
| THE-603 | `snapshots.enabled` now defaults to `true` (THE-648, #569). | CHANGELOG.md (1.14.0) | 7 |
| THE-605 | Context bundle export/import | docs/design/experiential-context-bundle.md | 5 |
| THE-606 | `bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown (THE-661, THE-606, THE-625, THE-614). | CHANGELOG.md (1.14.0) | 2 |
| THE-607 | `bun run map` and `check:boundaries` refuse to run against a stale `dist/` (THE-664, THE-607, THE-604). | CHANGELOG.md (1.14.0) | 1 |
| THE-609 | `forget` audit parity, including on a no-op (THE-609, #542). | CHANGELOG.md (1.13.0) | 1 |
| THE-610 | Session traces are pruned by age | CHANGELOG.md (1.12.0) | 7 |
| THE-611 | `gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616, THE-644 item 1). | CHANGELOG.md (1.14.0) | 8 |
| THE-612 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 5 |
| THE-613 | A judge that did not ANSWER is no longer counted as one that answered unparseably (#732, #734, THE-717, THE-613). | CHANGELOG.md (1.20.0) | 6 |
| THE-615 | Gateway retry with backoff, and a liveness probe (THE-615, THE-617, #566). | CHANGELOG.md (1.14.0) | 1 |
| THE-616 | `gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616, THE-644 item 1). | CHANGELOG.md (1.14.0) | 9 |
| THE-617 | Gateway retry with backoff, and a liveness probe (THE-615, THE-617, #566). | CHANGELOG.md (1.14.0) | 4 |
| THE-618 | The ACL predicates no longer recompile a glob per rule per path (THE-618, #638). | CHANGELOG.md (1.14.0) | 4 |
| THE-619 | The poison-scan capture path is bounded, and the secret patterns cover more token shapes (THE-619). | CHANGELOG.md (1.14.0) | 3 |
| THE-620 | QueryCache expiry sweep, `via_edge` deep copy, and two smaller correctness fixes (THE-626, THE-620, THE-622, #565). | CHANGELOG.md (1.14.0) | 1 |
| THE-621 | The stage-2 judge fan-out is bounded and the kill switch has a floor (#703, THE-621). | CHANGELOG.md (1.20.0) | 4 |
| THE-622 | QueryCache expiry sweep, `via_edge` deep copy, and two smaller correctness fixes (THE-626, THE-620, THE-622, #565). | CHANGELOG.md (1.14.0) | 2 |
| THE-625 | `job_runs` was empty while 128 jobs had completed (#685, THE-716). | CHANGELOG.md (1.17.1) | 3 |
| THE-626 | QueryCache expiry sweep, `via_edge` deep copy, and two smaller correctness fixes (THE-626, THE-620, THE-622, #565). | CHANGELOG.md (1.14.0) | 1 |
| THE-627 | Client software identity | CHANGELOG.md (1.12.0) | 9 |
| THE-628 | Note-level and cluster-level summary tiers, dark by default (#817, #818, THE-628). | CHANGELOG.md (1.22.0) | 19 |
| THE-629 | doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and the experiential charter is stated (#700, THE-715, THE-713). | CHANGELOG.md (1.20.0) | 2 |
| THE-630 | Federated multi-vault search with per-vault ACL (#809, THE-630). | CHANGELOG.md (1.22.0) | 9 |
| THE-631 | Per-vault score calibration, and the confidence it makes possible (#711, THE-733, THE-631 item 1). | CHANGELOG.md (1.20.0) | 12 |
| THE-632 | `diagnose_retrieval` — ask why an expected note was *not* returned (THE-632, #644). | CHANGELOG.md (1.14.0) | 16 |
| THE-633 | Five new tools (157 total). | CHANGELOG.md (1.17.0) | 9 |
| THE-634 | Proactive advisory surfacing, off by default (#779, #810, THE-634). | CHANGELOG.md (1.22.0) | 16 |
| THE-635 | Point-in-time `since`/`until` retrieval filter (#824, THE-635). | CHANGELOG.md (1.22.0) | 1 |
| THE-636 | Vendor-neutral export/import of the derived plane (#808, THE-636). | CHANGELOG.md (1.22.0) | 10 |
| THE-639 | A sanctioned, poison-scanned path for agent-synthesised notes (#814, THE-639). | CHANGELOG.md (1.22.0) | 7 |
| THE-641 | _internal planning reference — see repo history_ | — | 1 |
| THE-642 | `work_search` gains an opt-in `semantic` mode (#820, THE-642). | CHANGELOG.md (1.22.0) | 5 |
| THE-643 | Actionable quality data (#813, THE-643). | CHANGELOG.md (1.22.0) | 14 |
| THE-644 | `experiential.citationPreferences` folds retrieval-level citation outcomes into learned preferences (#836, THE-644). | CHANGELOG.md (1.23.0) | 14 |
| THE-645 | `get_index_status` reports in-flight `index_vault` progress (#807, THE-645 item 4). | CHANGELOG.md (1.22.0) | 21 |
| THE-646 | `explain_answer` — the retrieval → chunk → citation → episode lineage chain (#705, THE-646 item 2). | CHANGELOG.md (1.20.0) | 6 |
| THE-647 | Differential `vault_context` and persona scoping (#811, THE-647). | CHANGELOG.md (1.22.0) | 17 |
| THE-648 | `snapshots.enabled` now defaults to `true` (THE-648, #569). | CHANGELOG.md (1.14.0) | 7 |
| THE-649 | The server now watches each vault and reindexes notes changed outside it | CHANGELOG.md (1.12.0) | 5 |
| THE-650 | Source-agnostic highlight-import format + Readwise adapter, staged via `capture_queue` (#839, THE-650). | CHANGELOG.md (1.23.0) | 14 |
| THE-653 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 2 |
| THE-654 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 1 |
| THE-655 | Five new tools (157 total). | CHANGELOG.md (1.17.0) | 1 |
| THE-657 | The vault watcher is enabled on Windows (#715, THE-657). | CHANGELOG.md (1.20.0) | 2 |
| THE-658 | `auth.jwksUri` — a key source that can rotate (THE-658, #556). | CHANGELOG.md (1.13.1) | 8 |
| THE-659 | Enabling `observability.prometheus` no longer kills the MCP HTTP server under Bun (THE-659, #535). | CHANGELOG.md (1.12.1) | 3 |
| THE-661 | `bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown (THE-661, THE-606, THE-625, THE-614). | CHANGELOG.md (1.14.0) | 1 |
| THE-663 | The Windows standalone binary now builds at all (#654). | CHANGELOG.md (1.14.2) | 3 |
| THE-665 | Every durable job enqueue was broken under Bun, the production runtime (THE-665). | CHANGELOG.md (1.14.0) | 4 |
| THE-666 | The scheduler's durable-persistence failures have an error channel (THE-666). | CHANGELOG.md (1.14.0) | 3 |
| THE-667 | The idempotency-claim release has an error channel (THE-667, #641). | CHANGELOG.md (1.14.0) | 2 |
| THE-672 | Migration Manifest | docs/design/migration-manifest.md | 3 |
| THE-673 | Per-key preference scoping — human vs caller (#846, THE-891 item 6). | CHANGELOG.md (1.23.0) | 7 |
| THE-674 | An ACL predicate SQLite can see | docs/superpowers/specs/2026-08-02-the-694-695-acl-permitted-set-design.md | 1 |
| THE-675 | Citation inference | docs/design/experiential-citation-inference.md | 1 |
| THE-677 | Pluggable embedding and rerank provider slots (THE-677, #628, #631). | CHANGELOG.md (1.14.0) | 2 |
| THE-678 | A credential error names the config block that actually holds the key (THE-680, THE-678, #633). | CHANGELOG.md (1.14.0) | 1 |
| THE-679 | `doctor` pre-detects an unbuildable reranker, and names the declared one (THE-679, THE-681, #632). | CHANGELOG.md (1.14.0) | 5 |
| THE-680 | A credential error names the config block that actually holds the key (THE-680, THE-678, #633). | CHANGELOG.md (1.14.0) | 3 |
| THE-681 | `doctor` pre-detects an unbuildable reranker, and names the declared one (THE-679, THE-681, #632). | CHANGELOG.md (1.14.0) | 1 |
| THE-683 | `RepresentationManifest` has a production producer, and `embeddings.pooling` now moves the index identity (THE-683, #636). | CHANGELOG.md (1.14.0) | 9 |
| THE-687 | _internal planning reference — see repo history_ | — | 2 |
| THE-688 | `doctor --probe` — opt-in dense-embeddings liveness (THE-688, #643). | CHANGELOG.md (1.14.0) | 11 |
| THE-691 | The query router's rare-term signal no longer leaks term existence across the ACL (THE-691, #645). | CHANGELOG.md (1.14.0) | 1 |
| THE-692 | `--max-per-cluster` in the eval harness (THE-692, #646). | CHANGELOG.md (1.14.0) | 2 |
| THE-693 | `retrieval.graphStream` config surface (THE-693, #650). | CHANGELOG.md (1.14.0) | 4 |
| THE-694 | `obsidian_tc_acl_walk_pruned_total` — the graph-walk ACL filter's recall cost is now observable (THE-891 item 3, #847). | CHANGELOG.md (1.23.0) | 10 |
| THE-695 | `obsidian_tc_acl_walk_pruned_total` — the graph-walk ACL filter's recall cost is now observable (THE-891 item 3, #847). | CHANGELOG.md (1.23.0) | 9 |
| THE-696 | `notes_fts` integrity is checkable, and repairable (THE-696, #648). | CHANGELOG.md (1.14.0) | 5 |
| THE-697 | `obsidian-tc index` — the derived-state command that was missing (THE-697, #648). | CHANGELOG.md (1.14.0) | 4 |
| THE-698 | Scheduled episode evaluation (THE-698, #648). | CHANGELOG.md (1.14.0) | 6 |
| THE-699 | `--acl-allow` — the eval harness can finally vary ACL state (THE-699, #660). | CHANGELOG.md (1.15.0) | 2 |
| THE-700 | The plane re-ran its own completed once-per-period work on every tick (#687, THE-723). | CHANGELOG.md (1.18.0) | 3 |
| THE-701 | The episode-eligibility judge (THE-701, #661). | CHANGELOG.md (1.15.0) | 6 |
| THE-705 | A bundled `local` cross-encoder reranker — `gatedRerank` with no gateway and no external service (#806, THE-705). | CHANGELOG.md (1.22.0) | 9 |
| THE-707 | THE-707 — experiential-tier benchmark applicability assessment (no adapter built). | CHANGELOG.md (1.23.0) | 1 |
| THE-709 | Consolidation jobs get a per-attempt gateway timeout (THE-709). | CHANGELOG.md (1.16.0) | 3 |
| THE-710 | Five deployment-bias leaks from the THE-891 product-lens audit, corrected (#843, THE-710's recorded-lesson pattern: "single-user is not single-vault"). | CHANGELOG.md (1.23.0) | 7 |
| THE-711 | Sparse weights are stored PACKED, not as JSONB (#727, then #729, THE-711). | CHANGELOG.md (1.20.0) | 8 |
| THE-713 | doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and the experiential charter is stated (#700, THE-715, THE-713). | CHANGELOG.md (1.20.0) | 1 |
| THE-714 | `record_retrieval_feedback` was unreachable, and failed silently (#677, THE-718). | CHANGELOG.md (1.17.0) | 6 |
| THE-715 | A nameless job spec is refused at registration (#701, THE-715 item 3). | CHANGELOG.md (1.20.0) | 4 |
| THE-716 | `job_runs` was empty while 128 jobs had completed (#685, THE-716). | CHANGELOG.md (1.17.1) | 5 |
| THE-717 | `experiential.citationPreferences` folds retrieval-level citation outcomes into learned preferences (#836, THE-644). | CHANGELOG.md (1.23.0) | 24 |
| THE-718 | `chunk_retrievals.outcome` is RETIRED (#731, THE-718). | CHANGELOG.md (1.20.0) | 15 |
| THE-719 | The coverage-gap sweep can be scheduled (#675, THE-719). | CHANGELOG.md (1.17.0) | 7 |
| THE-720 | Liveness reporting: three new `doctor --probe` checks. | CHANGELOG.md (1.17.0) | 9 |
| THE-721 | Experiential Reflection — Evaluator & Preference Extraction | docs/design/experiential-reflection.md | 1 |
| THE-722 | `audit.kbHealth` — a reader for the 302 audit reports nothing could read (#684, THE-722). | CHANGELOG.md (1.17.1) | 4 |
| THE-723 | The scheduler's backoff cap had become a global 5-minute ceiling on every background job (#687, THE-723). | CHANGELOG.md (1.18.0) | 3 |
| THE-725 | `client-features.ts`'s `logging/setLevel` comment now matches what the SDK actually does under legacy (#835, THE-862). | CHANGELOG.md (1.23.0) | 2 |
| THE-726 | The task-verdict producer for `agent_episodes.task_result` (#804, THE-726). | CHANGELOG.md (1.22.0) | 23 |
| THE-727 | Operation-aware authorization (#697, THE-727). | CHANGELOG.md (1.20.0) | 3 |
| THE-730 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 1 |
| THE-732 | _internal planning reference — see repo history_ | — | 1 |
| THE-733 | Per-vault score calibration, and the confidence it makes possible (#711, THE-733, THE-631 item 1). | CHANGELOG.md (1.20.0) | 11 |
| THE-735 | _internal planning reference — see repo history_ | — | 1 |
| THE-736 | `rerun` — re-run a recorded session against current vault state (#722, #721, #720, THE-645 item 3, THE-736, THE-737). | CHANGELOG.md (1.20.0) | 12 |
| THE-737 | `rerun` — re-run a recorded session against current vault state (#722, #721, #720, THE-645 item 3, THE-736, THE-737). | CHANGELOG.md (1.20.0) | 12 |
| THE-738 | Rerun hygiene: WAL staging, audit attribution, policy refusals, exit codes (#730, THE-738, THE-739, THE-740, THE-742). | CHANGELOG.md (1.20.0) | 3 |
| THE-739 | Rerun hygiene: WAL staging, audit attribution, policy refusals, exit codes (#730, THE-738, THE-739, THE-740, THE-742). | CHANGELOG.md (1.20.0) | 1 |
| THE-740 | Rerun hygiene: WAL staging, audit attribution, policy refusals, exit codes (#730, THE-738, THE-739, THE-740, THE-742). | CHANGELOG.md (1.20.0) | 1 |
| THE-741 | `rerun` reports `served_from_cache` for an idempotent replay instead of spurious divergence (#828, THE-741). | CHANGELOG.md (1.22.0) | 4 |
| THE-742 | Rerun hygiene: WAL staging, audit attribution, policy refusals, exit codes (#730, THE-738, THE-739, THE-740, THE-742). | CHANGELOG.md (1.20.0) | 2 |
| THE-743 | `ToolAnnotations.idempotentHint` (#733, THE-743). | CHANGELOG.md (1.20.0) | 2 |
| THE-744 | An invocation that plans zero passes now records that it ran (#733, THE-744). | CHANGELOG.md (1.20.0) | 6 |
| THE-745 | `busy_timeout` is installed before any pragma that can contend (#723, THE-745). | CHANGELOG.md (1.20.0) | 4 |
| THE-746 | Per-decision eligibility reasons (#733, THE-746). | CHANGELOG.md (1.20.0) | 5 |
| THE-747 | `reflect --max-judged` outlived the judge it capped (#724, THE-747). | CHANGELOG.md (1.20.0) | 2 |
| THE-748 | _internal planning reference — see repo history_ | — | 1 |
| THE-749 | `/makemd/spaces` no longer silently degrades to an empty list (#837, THE-860). | CHANGELOG.md (1.23.0) | 1 |
| THE-750 | Read-only consumers refuse a stale `chunk_fts` instead of silently mis-joining it (#755, THE-750). | CHANGELOG.md (1.21.0) | 4 |
| THE-752 | A writer for `agent_episodes.summary` — Tier 0, deterministic (#819, THE-752). | CHANGELOG.md (1.22.0) | 4 |
| THE-804 | The coverage-gap sweep scopes its query source per vault (#776, THE-804). | CHANGELOG.md (1.22.0) | 2 |
| THE-805 | _internal planning reference — see repo history_ | — | 1 |
| THE-806 | The eval harness's `--gated-rerank` flag now builds the SAME reranker and hardness gate production would (#812, THE-806 step 2). | CHANGELOG.md (1.22.0) | 5 |
| THE-822 | `plane.enabled: false` now also stops the per-index-write contradiction path (#788, THE-822). | CHANGELOG.md (1.22.0) | 3 |
| THE-823 | The MCP error `content[0].text` block now names the offending field, not just the error code (#784, #789, THE-823). | CHANGELOG.md (1.22.0) | 7 |
| THE-824 | `obsidian-tc elicit` — a way to satisfy the confirmation gate (#796, THE-826). | CHANGELOG.md (1.22.0) | 18 |
| THE-825 | `plane.enabled` now defaults to `false` (was `true`) — ambient sleep-time consolidation is opt-in (#797, THE-825, GH #786). | CHANGELOG.md (1.22.0) | 9 |
| THE-826 | `obsidian-tc elicit` — a way to satisfy the confirmation gate (#796, THE-826). | CHANGELOG.md (1.22.0) | 5 |
| THE-832 | A root `gateway` config block (`baseUrl`/`token`) (#792, THE-832). | CHANGELOG.md (1.22.0) | 3 |
| THE-833 | Memory entities get a lifecycle — retire, rename, unlink, delete (#795, THE-833). | CHANGELOG.md (1.22.0) | 8 |
| THE-837 | The `ollama` embeddings built-in is deprecated (THE-837), and still fully functional. | CHANGELOG.md (1.22.0) | 8 |
| THE-838 | The task-verdict producer for `agent_episodes.task_result` (#804, THE-726). | CHANGELOG.md (1.22.0) | 2 |
| THE-839 | `episode_type` is a structural value, not a rendered literal (#802, THE-839). | CHANGELOG.md (1.22.0) | 10 |
| THE-852 | `obsidian_tc_acl_walk_pruned_total` — the graph-walk ACL filter's recall cost is now observable (THE-891 item 3, #847). | CHANGELOG.md (1.23.0) | 10 |
| THE-853 | The adaptive-RRF IDF path is ACL-partitioned, closing a cross-ACL term-presence oracle (#830, THE-853). | CHANGELOG.md (1.22.0) | 9 |
| THE-854 | Superseded `cluster_summary` rows are garbage-collected (#829, THE-854). | CHANGELOG.md (1.22.0) | 2 |
| THE-855 | Source-agnostic highlight-import format + Readwise adapter, staged via `capture_queue` (#839, THE-650). | CHANGELOG.md (1.23.0) | 9 |
| THE-858 | Captured content is poison-scanned at enqueue, and at commit (#823, #827, THE-855, THE-858). | CHANGELOG.md (1.22.0) | 1 |
| THE-860 | `/makemd/spaces` no longer silently degrades to an empty list (#837, THE-860). | CHANGELOG.md (1.23.0) | 1 |
| THE-861 | Client identity now reaches `tools/call` handlers (#834, THE-861). | CHANGELOG.md (1.23.0) | 2 |
| THE-862 | `client-features.ts`'s `logging/setLevel` comment now matches what the SDK actually does under legacy (#835, THE-862). | CHANGELOG.md (1.23.0) | 2 |
| THE-891 | THE-891 item 2 (#845) — the capture mitigation profile every accepted local-persistence precedent ships (bounded retention + first-run notice + location guard), `experiential.captureContent` stays on (behavior change: retention). | CHANGELOG.md (1.23.0) | 34 |
| THE-906 | The boot ready line, `doctor`, the capability profile and `server_health` could all report `native=on` / "native acceleration module loaded" while actually running the pure-JS fallback (THE-906, #858). | CHANGELOG.md (1.23.2) | 4 |
| THE-922 | The fetch cause was preserved only at `doFetch`, so a TLS-untrusted companion still misdirected every other transport (THE-923, #865). | CHANGELOG.md (1.23.4) | 4 |
| THE-923 | The fetch cause was preserved only at `doFetch`, so a TLS-untrusted companion still misdirected every other transport (THE-923, #865). | CHANGELOG.md (1.23.4) | 7 |
| THE-924 | Four introspection tools leaked cross-vault identifiers to a vault-bound HTTP caller (THE-924, #864). | CHANGELOG.md (1.23.4) | 3 |
| THE-925 | A note edit during a full `index_vault` reconcile could silently revert that note's index to stale content (THE-925, #866). | CHANGELOG.md (1.23.4) | 5 |
| THE-926 | Retrieval fan-out silently swallowed a deliberate index-integrity refusal, and a valid search regex could be rejected as a ReDoS (THE-926, #867). | CHANGELOG.md (1.23.4) | 10 |

342 distinct ticket(s) across 481 source file(s) under
`packages/*/src`; 275 resolved to a public summary, 67
fall back to the internal-reference placeholder above.
