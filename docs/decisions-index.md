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
| THE-48 | Knowledge-gap detector (THE-48). | CHANGELOG.md (1.8.0) | 4 |
| THE-73 | _internal planning reference — see repo history_ | — | 12 |
| THE-101 | `session_bootstrap` tool (THE-101). | CHANGELOG.md (1.4.0) | 3 |
| THE-132 | _internal planning reference — see repo history_ | — | 3 |
| THE-134 | _internal planning reference — see repo history_ | — | 2 |
| THE-135 | _internal planning reference — see repo history_ | — | 2 |
| THE-136 | Anticipatory context prefetch (THE-136). | CHANGELOG.md (1.7.0) | 7 |
| THE-160 | _internal planning reference — see repo history_ | — | 2 |
| THE-170 | _internal planning reference — see repo history_ | — | 8 |
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
| THE-187 | _internal planning reference — see repo history_ | — | 8 |
| THE-193 | _internal planning reference — see repo history_ | — | 2 |
| THE-196 | _internal planning reference — see repo history_ | — | 1 |
| THE-197 | Idempotency observability wired (THE-197). | CHANGELOG.md (1.3.0) | 4 |
| THE-198 | _internal planning reference — see repo history_ | — | 3 |
| THE-202 | _internal planning reference — see repo history_ | — | 1 |
| THE-207 | Templater expansion for periodic notes (THE-207). | CHANGELOG.md (1.3.0) | 3 |
| THE-208 | _internal planning reference — see repo history_ | — | 3 |
| THE-209 | In-session tool-invocation tracing (THE-209). | CHANGELOG.md (1.3.0) | 5 |
| THE-210 | Dispatch-wide rate limiting (THE-210) | CHANGELOG.md (1.0.1) | 9 |
| THE-211 | Metrics Registry | docs/design/metrics-registry.md | 2 |
| THE-212 | _internal planning reference — see repo history_ | — | 2 |
| THE-213 | _internal planning reference — see repo history_ | — | 1 |
| THE-219 | Tool-visibility scoping (THE-219): | CHANGELOG.md (1.2.1) | 11 |
| THE-221 | Conditional temporal retrieval stream, flag-gated (THE-221 Phase 1). | CHANGELOG.md (1.6.0) | 5 |
| THE-222 | `reflect` — the third verb, as one callable operation (THE-222). | CHANGELOG.md (1.7.0) | 13 |
| THE-227 | The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan). | CHANGELOG.md (1.6.0) | 6 |
| THE-228 | Citation inference | docs/design/experiential-citation-inference.md | 12 |
| THE-229 | _internal planning reference — see repo history_ | — | 8 |
| THE-230 | _internal planning reference — see repo history_ | — | 13 |
| THE-231 | Proactive lesson surfacing in vault_context (THE-231). | CHANGELOG.md (1.7.0) | 4 |
| THE-232 | _internal planning reference — see repo history_ | — | 3 |
| THE-233 | _internal planning reference — see repo history_ | — | 27 |
| THE-235 | _internal planning reference — see repo history_ | — | 4 |
| THE-237 | _internal planning reference — see repo history_ | — | 2 |
| THE-238 | Session Re-run (THE-645 item 3) — Design | docs/superpowers/specs/2026-08-05-the-645-item-3-session-rerun-design.md | 11 |
| THE-239 | Dependency-aware deletion + hash-chained forget audit (THE-239). | CHANGELOG.md (1.8.0) | 9 |
| THE-249 | _internal planning reference — see repo history_ | — | 2 |
| THE-250 | Per-caller tool-visibility filtering (THE-250): | CHANGELOG.md (1.2.1) | 4 |
| THE-251 | Terse search projection (THE-251). | CHANGELOG.md (1.3.0) | 2 |
| THE-252 | _internal planning reference — see repo history_ | — | 2 |
| THE-255 | Headless VaultBackend, lean v1 (THE-255): | CHANGELOG.md (1.2.1) | 7 |
| THE-258 | _internal planning reference — see repo history_ | — | 5 |
| THE-266 | Zero-copy `Float32Array` cosine on the native brute-force path (THE-266). | CHANGELOG.md (1.3.0) | 2 |
| THE-267 | HTTP tokens are now bound to a single vault (THE-267). | CHANGELOG.md (1.3.0) | 8 |
| THE-268 | Fail-closed ACL defaults (THE-268). | CHANGELOG.md (1.3.0) | 4 |
| THE-269 | Folder ACL checks are canonicalized through symlinks (THE-269). | CHANGELOG.md (1.3.0) | 2 |
| THE-270 | Bridge tools fail closed under a read whitelist (THE-270). | CHANGELOG.md (1.3.0) | 4 |
| THE-271 | DNS-rebinding / cross-origin protection on the HTTP transport (THE-271). | CHANGELOG.md (1.3.0) | 2 |
| THE-272 | Unicode-normalization-insensitive folder ACL (THE-272). | CHANGELOG.md (1.3.0) | 4 |
| THE-273 | SQLite per-connection baseline + prepared-statement cache (THE-273). | CHANGELOG.md (1.3.0) | 4 |
| THE-275 | Domain-verb facade mode (shipped under THE-275 — see correction). | CHANGELOG.md (1.3.0) | 3 |
| THE-277 | Parallelized the contradiction sweep (THE-277). | CHANGELOG.md (1.3.0) | 6 |
| THE-278 | Repo docs reconciled with reality (THE-278). | CHANGELOG.md (1.3.0) | 8 |
| THE-280 | Bases model realigned to shipped Obsidian 1.12 syntax, additive-with-deprecation (THE-280). | CHANGELOG.md (1.3.0) | 2 |
| THE-281 | Obsidian Bases expression DSL subset evaluator (THE-281). | CHANGELOG.md (1.3.0) | 2 |
| THE-282 | Companion installable-product hardening (THE-282). | CHANGELOG.md (1.3.0) | 7 |
| THE-284 | Obsidian-fit fixes (THE-284). | CHANGELOG.md (1.3.0) | 2 |
| THE-286 | Uniform symlink-canonical ACL enforcement (THE-286). | CHANGELOG.md (1.3.0) | 1 |
| THE-287 | Semantic search no longer crowds out ACL-visible hits (THE-287). | CHANGELOG.md (1.3.0) | 7 |
| THE-288 | `server_health` surfaces search-index degradation (THE-288). | CHANGELOG.md (1.3.0) | 8 |
| THE-289 | `execute_template` honors `overwrite` — no more silent clobber (THE-289). | CHANGELOG.md (1.3.0) | 2 |
| THE-291 | Metadata tools read the notes table (THE-291, part 3B-ii). | CHANGELOG.md (1.3.0) | 23 |
| THE-292 | Periodic cache.db maintenance sweep (THE-292). | CHANGELOG.md (1.3.0) | 5 |
| THE-293 | Compute-abuse budgets (THE-293). | CHANGELOG.md (1.3.0) | 11 |
| THE-294 | Dropped one payload serialization per tool call (THE-294). | CHANGELOG.md (1.3.0) | 3 |
| THE-295 | Per-vault ACL (THE-295). | CHANGELOG.md (1.3.0) | 9 |
| THE-296 | SleepTime plane scheduler wired (THE-296). | CHANGELOG.md (1.3.0) | 2 |
| THE-297 | Asymmetric JWT verification — RS256/ES256/EdDSA + JWKS + kid rotation (THE-297). | CHANGELOG.md (1.3.0) | 4 |
| THE-302 | `elicitTtlSeconds` now governs HITL token TTL (THE-302). | CHANGELOG.md (1.3.3) | 2 |
| THE-303 | _internal planning reference — see repo history_ | — | 2 |
| THE-308 | Cohere query embeddings use the query encoding (THE-308). | CHANGELOG.md (1.3.5) | 2 |
| THE-309 | `knowledge_challenge` gives the judge tags + open contradictions (THE-309). | CHANGELOG.md (1.3.5) | 2 |
| THE-310 | Multi-vault GraphRAG edge isolation (THE-310). | CHANGELOG.md (1.3.5) | 6 |
| THE-316 | _internal planning reference — see repo history_ | — | 3 |
| THE-374 | _internal planning reference — see repo history_ | — | 7 |
| THE-375 | _internal planning reference — see repo history_ | — | 1 |
| THE-376 | _internal planning reference — see repo history_ | — | 3 |
| THE-378 | Obsidian Git + Remotely Save bridges (THE-378, THE-381). | CHANGELOG.md (1.8.0) | 3 |
| THE-379 | _internal planning reference — see repo history_ | — | 1 |
| THE-380 | _internal planning reference — see repo history_ | — | 1 |
| THE-381 | Obsidian Git + Remotely Save bridges (THE-378, THE-381). | CHANGELOG.md (1.8.0) | 2 |
| THE-383 | _internal planning reference — see repo history_ | — | 1 |
| THE-387 | _internal planning reference — see repo history_ | — | 6 |
| THE-388 | _internal planning reference — see repo history_ | — | 12 |
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
| THE-406 | Contextual chunk enrichment, flag-gated (THE-406). | CHANGELOG.md (1.5.0) | 13 |
| THE-408 | chunk_fts divergence-rebuild is enrichment-aware (THE-408). | CHANGELOG.md (1.6.0) | 4 |
| THE-413 | Durable Idempotency Claim State-Machine (THE-562 #13 / THE-413 residual) — Design | docs/superpowers/specs/2026-07-24-the-562-13-idempotency-durable-claim-design.md | 2 |
| THE-414 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 8 |
| THE-415 | MCP registry: caller context and tool-definition types | docs/design/mcp-registry-context-types.md | 6 |
| THE-417 | `vault_context`: prewarm cache, differential mode, write-through | docs/design/knowledge-vault-context-tool.md | 44 |
| THE-418 | _internal planning reference — see repo history_ | — | 1 |
| THE-420 | Citation inference | docs/design/experiential-citation-inference.md | 4 |
| THE-421 | THE-459 — Synthetic-vault perf harness + CI gates (design) | docs/superpowers/specs/2026-07-20-the-459-perf-harness-design.md | 1 |
| THE-424 | `experiential.activationRerank` now applies a ranking change (#762, THE-424 Part A, THE-535). | CHANGELOG.md (1.21.0) | 16 |
| THE-441 | _internal planning reference — see repo history_ | — | 2 |
| THE-445 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 2 |
| THE-447 | _internal planning reference — see repo history_ | — | 1 |
| THE-448 | Graph Search — vault_graph_search tool | docs/design/graph-search.md | 9 |
| THE-450 | _internal planning reference — see repo history_ | — | 5 |
| THE-451 | Graph Search — vault_graph_search tool | docs/design/graph-search.md | 3 |
| THE-452 | _internal planning reference — see repo history_ | — | 3 |
| THE-453 | ACL: folder rules, glob matching, and the fingerprint cache key | docs/design/acl-folder-rules.md | 4 |
| THE-454 | _internal planning reference — see repo history_ | — | 5 |
| THE-455 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 7 |
| THE-456 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 6 |
| THE-457 | Retrieval: dense (vec0) index and brute-force fallback | docs/design/retrieval-dense-index.md | 10 |
| THE-458 | THE-458 remainders closed | CHANGELOG.md (1.12.0) | 11 |
| THE-459 | THE-459 — Synthetic-vault perf harness + CI gates (design) | docs/superpowers/specs/2026-07-20-the-459-perf-harness-design.md | 3 |
| THE-460 | Retrieval: dense (vec0) index and brute-force fallback | docs/design/retrieval-dense-index.md | 10 |
| THE-461 | Migration Manifest | docs/design/migration-manifest.md | 7 |
| THE-462 | Wire the durable JobQueue to its workloads — THE-562 #14 (THE-517) | docs/superpowers/specs/2026-07-24-the-562-14-durable-job-queue-wiring-design.md | 10 |
| THE-463 | _internal planning reference — see repo history_ | — | 2 |
| THE-465 | Metrics Registry | docs/design/metrics-registry.md | 13 |
| THE-466 | Server Runtime — Composition Root | docs/design/server-runtime.md | 8 |
| THE-467 | Metrics Registry | docs/design/metrics-registry.md | 4 |
| THE-486 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 3 |
| THE-487 | _internal planning reference — see repo history_ | — | 1 |
| THE-488 | _internal planning reference — see repo history_ | — | 5 |
| THE-489 | _internal planning reference — see repo history_ | — | 2 |
| THE-490 | _internal planning reference — see repo history_ | — | 8 |
| THE-491 | _internal planning reference — see repo history_ | — | 7 |
| THE-496 | ACL: folder rules, glob matching, and the fingerprint cache key | docs/design/acl-folder-rules.md | 11 |
| THE-497 | Metrics Registry | docs/design/metrics-registry.md | 11 |
| THE-499 | _internal planning reference — see repo history_ | — | 3 |
| THE-500 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 2 |
| THE-501 | _internal planning reference — see repo history_ | — | 2 |
| THE-502 | _internal planning reference — see repo history_ | — | 2 |
| THE-504 | Citation inference | docs/design/experiential-citation-inference.md | 5 |
| THE-507 | Metrics Registry | docs/design/metrics-registry.md | 7 |
| THE-509 | _internal planning reference — see repo history_ | — | 2 |
| THE-510 | Contributor tooling and an MCP client compatibility matrix (THE-624, THE-510, #567). | CHANGELOG.md (1.14.0) | 1 |
| THE-512 | _internal planning reference — see repo history_ | — | 1 |
| THE-513 | MCP registry: caller context and tool-definition types | docs/design/mcp-registry-context-types.md | 4 |
| THE-514 | _internal planning reference — see repo history_ | — | 12 |
| THE-515 | _internal planning reference — see repo history_ | — | 2 |
| THE-516 | _internal planning reference — see repo history_ | — | 6 |
| THE-517 | Wire the durable JobQueue to its workloads — THE-562 #14 (THE-517) | docs/superpowers/specs/2026-07-24-the-562-14-durable-job-queue-wiring-design.md | 6 |
| THE-518 | _internal planning reference — see repo history_ | — | 5 |
| THE-520 | _internal planning reference — see repo history_ | — | 5 |
| THE-521 | _internal planning reference — see repo history_ | — | 9 |
| THE-522 | _internal planning reference — see repo history_ | — | 9 |
| THE-523 | _internal planning reference — see repo history_ | — | 6 |
| THE-526 | _internal planning reference — see repo history_ | — | 4 |
| THE-527 | _internal planning reference — see repo history_ | — | 4 |
| THE-530 | _internal planning reference — see repo history_ | — | 7 |
| THE-531 | _internal planning reference — see repo history_ | — | 7 |
| THE-532 | _internal planning reference — see repo history_ | — | 2 |
| THE-533 | Search Indexing & Query Cache | docs/design/search-indexing-and-cache.md | 2 |
| THE-535 | `experiential.activationRerank` now applies a ranking change (#762, THE-424 Part A, THE-535). | CHANGELOG.md (1.21.0) | 3 |
| THE-536 | _internal planning reference — see repo history_ | — | 2 |
| THE-537 | _internal planning reference — see repo history_ | — | 8 |
| THE-538 | _internal planning reference — see repo history_ | — | 11 |
| THE-543 | `vault_context`: prewarm cache, differential mode, write-through | docs/design/knowledge-vault-context-tool.md | 5 |
| THE-545 | _internal planning reference — see repo history_ | — | 1 |
| THE-546 | _internal planning reference — see repo history_ | — | 1 |
| THE-548 | _internal planning reference — see repo history_ | — | 3 |
| THE-561 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 2 |
| THE-562 | Experiential Reflection — Evaluator & Preference Extraction | docs/design/experiential-reflection.md | 14 |
| THE-563 | Graph Search — vault_graph_search tool | docs/design/graph-search.md | 12 |
| THE-564 | Derived-cognition plane isolation — THE-563 / THE-564 (+ audit #9, P1.6 deep-half) | docs/superpowers/specs/2026-07-24-the-563-564-derived-plane-isolation-design.md | 3 |
| THE-565 | _internal planning reference — see repo history_ | — | 4 |
| THE-567 | _internal planning reference — see repo history_ | — | 4 |
| THE-568 | _internal planning reference — see repo history_ | — | 9 |
| THE-569 | Reverse vault-kind gate: mutation of a docs/system vault is now refused (THE-569, closing the P1.5 boundary above) | CHANGELOG.md (1.11.0) | 3 |
| THE-571 | _internal planning reference — see repo history_ | — | 4 |
| THE-572 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 16 |
| THE-573 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 3 |
| THE-577 | MCP registry: caller context and tool-definition types | docs/design/mcp-registry-context-types.md | 2 |
| THE-578 | _internal planning reference — see repo history_ | — | 3 |
| THE-579 | _internal planning reference — see repo history_ | — | 3 |
| THE-582 | Retrieval: dense (vec0) index and brute-force fallback | docs/design/retrieval-dense-index.md | 4 |
| THE-583 | Request bodies are parsed once, not twice (THE-583, #553). | CHANGELOG.md (1.13.0) | 18 |
| THE-585 | Metrics Registry | docs/design/metrics-registry.md | 24 |
| THE-588 | _internal planning reference — see repo history_ | — | 7 |
| THE-589 | `generate_uri`'s `vault` input is renamed `vault_name` (THE-589). | CHANGELOG.md (1.12.0) | 1 |
| THE-590 | _internal planning reference — see repo history_ | — | 3 |
| THE-591 | _internal planning reference — see repo history_ | — | 7 |
| THE-600 | _internal planning reference — see repo history_ | — | 4 |
| THE-603 | _internal planning reference — see repo history_ | — | 7 |
| THE-605 | Context bundle export/import | docs/design/experiential-context-bundle.md | 5 |
| THE-606 | `bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown (THE-661, THE-606, THE-625, THE-614). | CHANGELOG.md (1.14.0) | 2 |
| THE-607 | `bun run map` and `check:boundaries` refuse to run against a stale `dist/` (THE-664, THE-607, THE-604). | CHANGELOG.md (1.14.0) | 1 |
| THE-609 | `forget` audit parity, including on a no-op (THE-609, #542). | CHANGELOG.md (1.13.0) | 1 |
| THE-610 | Vault filesystem watcher | docs/design/vault-watcher.md | 7 |
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
| THE-625 | `bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown (THE-661, THE-606, THE-625, THE-614). | CHANGELOG.md (1.14.0) | 3 |
| THE-626 | QueryCache expiry sweep, `via_edge` deep copy, and two smaller correctness fixes (THE-626, THE-620, THE-622, #565). | CHANGELOG.md (1.14.0) | 1 |
| THE-627 | _internal planning reference — see repo history_ | — | 9 |
| THE-628 | Note-level and cluster-level summary tiers, dark by default (#817, #818, THE-628). | CHANGELOG.md (1.22.0) | 19 |
| THE-629 | doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and the experiential charter is stated (#700, THE-715, THE-713). | CHANGELOG.md (1.20.0) | 2 |
| THE-630 | Federated multi-vault search with per-vault ACL (#809, THE-630). | CHANGELOG.md (1.22.0) | 9 |
| THE-631 | The episode amendment chain is exposed, and `graphSearch` reports coverage (THE-655, THE-631). | CHANGELOG.md (1.14.0) | 12 |
| THE-632 | The lexical and sparse arms filter by ACL at query time (THE-632, #644). | CHANGELOG.md (1.14.0) | 16 |
| THE-633 | Runtime: durable job-queue wiring | docs/design/runtime-job-wiring.md | 9 |
| THE-634 | Proactive advisory surfacing, off by default (#779, #810, THE-634). | CHANGELOG.md (1.22.0) | 16 |
| THE-635 | Point-in-time `since`/`until` retrieval filter (#824, THE-635). | CHANGELOG.md (1.22.0) | 8 |
| THE-636 | Vendor-neutral export/import of the derived plane (#808, THE-636). | CHANGELOG.md (1.22.0) | 10 |
| THE-639 | A sanctioned, poison-scanned path for agent-synthesised notes (#814, THE-639). | CHANGELOG.md (1.22.0) | 7 |
| THE-641 | _internal planning reference — see repo history_ | — | 1 |
| THE-642 | `work_search` gains an opt-in `semantic` mode (#820, THE-642). | CHANGELOG.md (1.22.0) | 5 |
| THE-643 | Scheduled `note_quality` recompute (THE-643, THE-625 items 1-3). | CHANGELOG.md (1.14.0) | 14 |
| THE-644 | `gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616, THE-644 item 1). | CHANGELOG.md (1.14.0) | 14 |
| THE-645 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 21 |
| THE-646 | `explain_answer` — the retrieval → chunk → citation → episode lineage chain (#705, THE-646 item 2). | CHANGELOG.md (1.20.0) | 6 |
| THE-647 | Differential `vault_context` and persona scoping (#811, THE-647). | CHANGELOG.md (1.22.0) | 17 |
| THE-648 | `snapshots.enabled` now defaults to `true` (THE-648, #569). | CHANGELOG.md (1.14.0) | 7 |
| THE-649 | Vault filesystem watcher | docs/design/vault-watcher.md | 5 |
| THE-650 | Source-agnostic highlight-import format + Readwise adapter, staged via `capture_queue` (#839, THE-650). | CHANGELOG.md (1.23.0) | 14 |
| THE-653 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 2 |
| THE-654 | Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645, THE-612, #563). | CHANGELOG.md (1.14.0) | 1 |
| THE-655 | The episode amendment chain is exposed, and `graphSearch` reports coverage (THE-655, THE-631). | CHANGELOG.md (1.14.0) | 1 |
| THE-657 | The vault watcher is enabled on Windows (#715, THE-657). | CHANGELOG.md (1.20.0) | 2 |
| THE-658 | `obsidian-tc token mint` — reproducible, auditable bearer tokens (THE-658, #539). | CHANGELOG.md (1.13.0) | 8 |
| THE-659 | Enabling `observability.prometheus` no longer kills the MCP HTTP server under Bun (THE-659, #535). | CHANGELOG.md (1.12.1) | 3 |
| THE-661 | `bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown (THE-661, THE-606, THE-625, THE-614). | CHANGELOG.md (1.14.0) | 1 |
| THE-663 | `vec0` is embedded in `--compile` release binaries (THE-663, #568). | CHANGELOG.md (1.14.0) | 3 |
| THE-665 | Every durable job enqueue was broken under Bun, the production runtime (THE-665). | CHANGELOG.md (1.14.0) | 4 |
| THE-666 | The scheduler's durable-persistence failures have an error channel (THE-666). | CHANGELOG.md (1.14.0) | 3 |
| THE-667 | The idempotency-claim release has an error channel (THE-667, #641). | CHANGELOG.md (1.14.0) | 2 |
| THE-672 | Migration Manifest | docs/design/migration-manifest.md | 3 |
| THE-673 | Preference counters are now deterministic over typed evidence (#805, THE-673). | CHANGELOG.md (1.22.0) | 7 |
| THE-674 | An ACL predicate SQLite can see | docs/superpowers/specs/2026-08-02-the-694-695-acl-permitted-set-design.md | 1 |
| THE-675 | Citation inference | docs/design/experiential-citation-inference.md | 1 |
| THE-677 | Pluggable embedding and rerank provider slots (THE-677, #628, #631). | CHANGELOG.md (1.14.0) | 2 |
| THE-678 | A credential error names the config block that actually holds the key (THE-680, THE-678, #633). | CHANGELOG.md (1.14.0) | 1 |
| THE-679 | `doctor` pre-detects an unbuildable reranker, and names the declared one (THE-679, THE-681, #632). | CHANGELOG.md (1.14.0) | 6 |
| THE-680 | A credential error names the config block that actually holds the key (THE-680, THE-678, #633). | CHANGELOG.md (1.14.0) | 3 |
| THE-681 | `doctor` pre-detects an unbuildable reranker, and names the declared one (THE-679, THE-681, #632). | CHANGELOG.md (1.14.0) | 1 |
| THE-683 | `RepresentationManifest` has a production producer, and `embeddings.pooling` now moves the index identity (THE-683, #636). | CHANGELOG.md (1.14.0) | 9 |
| THE-687 | _internal planning reference — see repo history_ | — | 2 |
| THE-688 | `doctor` says "configured", not "ready", for the dense retrieval head (THE-688, #642). | CHANGELOG.md (1.14.0) | 11 |
| THE-691 | The query router's rare-term signal no longer leaks term existence across the ACL (THE-691, #645). | CHANGELOG.md (1.14.0) | 1 |
| THE-692 | `--max-per-cluster` in the eval harness (THE-692, #646). | CHANGELOG.md (1.14.0) | 2 |
| THE-693 | `retrieval.graphStream` config surface (THE-693, #650). | CHANGELOG.md (1.14.0) | 4 |
| THE-694 | The router's timing oracle is closed, and BM25 no longer leaks its result length (THE-694, THE-695, #649). | CHANGELOG.md (1.14.0) | 10 |
| THE-695 | The router's timing oracle is closed, and BM25 no longer leaks its result length (THE-694, THE-695, #649). | CHANGELOG.md (1.14.0) | 9 |
| THE-696 | `notes_fts` integrity is checkable, and repairable (THE-696, #648). | CHANGELOG.md (1.14.0) | 6 |
| THE-697 | Bun's 10-second default request timeout no longer kills long MCP calls (THE-697, #648). | CHANGELOG.md (1.14.0) | 4 |
| THE-698 | Scheduled episode evaluation (THE-698, #648). | CHANGELOG.md (1.14.0) | 7 |
| THE-699 | `--acl-allow` — the eval harness can finally vary ACL state (THE-699, #660). | CHANGELOG.md (1.15.0) | 2 |
| THE-700 | Every scheduled consolidation pass died on a serverless cold start, and one failure cost the whole period (THE-700, #659). | CHANGELOG.md (1.15.0) | 3 |
| THE-701 | The episode-eligibility judge (THE-701, #661). | CHANGELOG.md (1.15.0) | 7 |
| THE-705 | A bundled `local` cross-encoder reranker — `gatedRerank` with no gateway and no external service (#806, THE-705). | CHANGELOG.md (1.22.0) | 9 |
| THE-707 | THE-707 — experiential-tier benchmark applicability assessment (no adapter built). | CHANGELOG.md (1.23.0) | 1 |
| THE-709 | Consolidation jobs get a per-attempt gateway timeout (THE-709). | CHANGELOG.md (1.16.0) | 3 |
| THE-710 | `preference_profile` / `preference_deltas` are namespaced by vault (#675, THE-710). | CHANGELOG.md (1.17.0) | 7 |
| THE-711 | `chunk_fts` is contentless, keyed on the chunks rowid (#728, THE-711). | CHANGELOG.md (1.20.0) | 8 |
| THE-713 | doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and the experiential charter is stated (#700, THE-715, THE-713). | CHANGELOG.md (1.20.0) | 1 |
| THE-714 | Migration Manifest | docs/design/migration-manifest.md | 6 |
| THE-715 | doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and the experiential charter is stated (#700, THE-715, THE-713). | CHANGELOG.md (1.20.0) | 4 |
| THE-716 | `job_runs` was empty while 128 jobs had completed (#685, THE-716). | CHANGELOG.md (1.17.1) | 5 |
| THE-717 | A judge that did not ANSWER is no longer counted as one that answered unparseably (#732, #734, THE-717, THE-613). | CHANGELOG.md (1.20.0) | 25 |
| THE-718 | `record_retrieval_feedback` says when to call it (#678, THE-718). | CHANGELOG.md (1.17.0) | 16 |
| THE-719 | The coverage-gap sweep can be scheduled (#675, THE-719). | CHANGELOG.md (1.17.0) | 7 |
| THE-720 | CLI Doctor | docs/design/cli-doctor.md | 10 |
| THE-721 | Experiential Reflection — Evaluator & Preference Extraction | docs/design/experiential-reflection.md | 1 |
| THE-722 | `check:table-readers` — a CI gate for write-only tables (#683, THE-722). | CHANGELOG.md (1.17.1) | 5 |
| THE-723 | The plane re-ran its own completed once-per-period work on every tick (#687, THE-723). | CHANGELOG.md (1.18.0) | 3 |
| THE-725 | MCP Dispatch & Transport | docs/design/mcp-dispatch-and-transport.md | 2 |
| THE-726 | The HTTP transport can now carry a workspace session, and optionally opens one itself (#691, #692, #693, THE-726). | CHANGELOG.md (1.19.0) | 31 |
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
| THE-745 | `busy_timeout` is installed before any pragma that can contend (#723, THE-745). | CHANGELOG.md (1.20.0) | 5 |
| THE-746 | Per-decision eligibility reasons (#733, THE-746). | CHANGELOG.md (1.20.0) | 5 |
| THE-747 | `reflect --max-judged` outlived the judge it capped (#724, THE-747). | CHANGELOG.md (1.20.0) | 2 |
| THE-748 | _internal planning reference — see repo history_ | — | 1 |
| THE-749 | _internal planning reference — see repo history_ | — | 1 |
| THE-750 | Read-only consumers refuse a stale `chunk_fts` instead of silently mis-joining it (#755, THE-750). | CHANGELOG.md (1.21.0) | 4 |
| THE-752 | A writer for `agent_episodes.summary` — Tier 0, deterministic (#819, THE-752). | CHANGELOG.md (1.22.0) | 4 |
| THE-804 | The coverage-gap sweep scopes its query source per vault (#776, THE-804). | CHANGELOG.md (1.22.0) | 2 |
| THE-805 | _internal planning reference — see repo history_ | — | 1 |
| THE-806 | The eval harness's `--gated-rerank` flag now builds the SAME reranker and hardness gate production would (#812, THE-806 step 2). | CHANGELOG.md (1.22.0) | 5 |
| THE-822 | `plane.enabled: false` now also stops the per-index-write contradiction path (#788, THE-822). | CHANGELOG.md (1.22.0) | 3 |
| THE-823 | The three facade triad schemas (`find_capability`, `describe_capability`, `call_capability`) now reject an unrecognized envelope key instead of silently dropping it (#784, #789, THE-823). | CHANGELOG.md (1.22.0) | 7 |
| THE-824 | The 16 conditionally-gated tools now advertise their confirmation gate (#790, THE-824). | CHANGELOG.md (1.22.0) | 18 |
| THE-825 | `plane.enabled` now defaults to `false` (was `true`) — ambient sleep-time consolidation is opt-in (#797, THE-825, GH #786). | CHANGELOG.md (1.22.0) | 9 |
| THE-826 | `obsidian-tc elicit` — a way to satisfy the confirmation gate (#796, THE-826). | CHANGELOG.md (1.22.0) | 5 |
| THE-832 | A root `gateway` config block (`baseUrl`/`token`) (#792, THE-832). | CHANGELOG.md (1.22.0) | 3 |
| THE-833 | Memory entities get a lifecycle — retire, rename, unlink, delete (#795, THE-833). | CHANGELOG.md (1.22.0) | 8 |
| THE-837 | The shared embedding transport no longer names any vendor (THE-837). | CHANGELOG.md (1.22.0) | 8 |
| THE-838 | `end_session` now refuses to end a session belonging to another principal (#803, THE-838). | CHANGELOG.md (1.22.0) | 3 |
| THE-839 | `episode_type` is a structural value, not a rendered literal (#802, THE-839). | CHANGELOG.md (1.22.0) | 10 |
| THE-852 | The graph-walk ACL filter is now wired into every M7 surface and defaults on (#815, THE-852). | CHANGELOG.md (1.22.0) | 10 |
| THE-853 | The adaptive-RRF IDF path is ACL-partitioned, closing a cross-ACL term-presence oracle (#830, THE-853). | CHANGELOG.md (1.22.0) | 9 |
| THE-854 | Superseded `cluster_summary` rows are garbage-collected (#829, THE-854). | CHANGELOG.md (1.22.0) | 2 |
| THE-855 | Captured content is poison-scanned at enqueue, and at commit (#823, #827, THE-855, THE-858). | CHANGELOG.md (1.22.0) | 9 |
| THE-858 | Captured content is poison-scanned at enqueue, and at commit (#823, #827, THE-855, THE-858). | CHANGELOG.md (1.22.0) | 1 |
| THE-860 | `/makemd/spaces` no longer silently degrades to an empty list (#837, THE-860). | CHANGELOG.md (1.23.0) | 1 |
| THE-861 | Client identity now reaches `tools/call` handlers (#834, THE-861). | CHANGELOG.md (1.23.0) | 2 |
| THE-862 | `client-features.ts`'s `logging/setLevel` comment now matches what the SDK actually does under legacy (#835, THE-862). | CHANGELOG.md (1.23.0) | 2 |
| THE-891 | Per-key preference scoping — human vs caller (#846, THE-891 item 6). | CHANGELOG.md (1.23.0) | 34 |
| THE-906 | The boot ready line, `doctor`, the capability profile and `server_health` could all report `native=on` / "native acceleration module loaded" while actually running the pure-JS fallback (THE-906, #858). | CHANGELOG.md (1.23.2) | 4 |
| THE-922 | A TLS trust failure was reported as "reload the plugin inside Obsidian" — the bridge transport discarded `e.cause`, collapsing every fetch failure into one indistinguishable state (THE-922, #861). | CHANGELOG.md (1.23.3) | 4 |
| THE-923 | The fetch cause was preserved only at `doFetch`, so a TLS-untrusted companion still misdirected every other transport (THE-923, #865). | CHANGELOG.md (1.23.4) | 7 |
| THE-924 | Four introspection tools leaked cross-vault identifiers to a vault-bound HTTP caller (THE-924, #864). | CHANGELOG.md (1.23.4) | 3 |
| THE-925 | A note edit during a full `index_vault` reconcile could silently revert that note's index to stale content (THE-925, #866). | CHANGELOG.md (1.23.4) | 5 |
| THE-926 | Retrieval fan-out silently swallowed a deliberate index-integrity refusal, and a valid search regex could be rejected as a ReDoS (THE-926, #867). | CHANGELOG.md (1.23.4) | 10 |
| THE-932 | A point-in-time (`as_of`) retrieval query no longer reads chunk content it discards (#874, THE-932). | CHANGELOG.md (1.23.6) | 1 |
| THE-934 | `egress.excludePaths` withholds vault-relative folders from every gateway and embedding call the server makes, plus `obsidian-tc consolidate --once [--dry-run]` (#886, THE-934; issue #880). | CHANGELOG.md (1.25.0) | 60 |
| THE-935 | `db.busyTimeoutMs` reachable from config (#902, THE-935; issue #878). | CHANGELOG.md (1.27.0) | 13 |
| THE-936 | `call_capability` now echoes the envelope keys it received on validation failure (#901, THE-936; issue #876). | CHANGELOG.md (1.27.0) | 1 |
| THE-937 | Catalog discovery on the triad facade (#884, THE-937; issue #877). | CHANGELOG.md (1.25.0) | 5 |
| THE-939 | `doctor` warns on sync-service conflict copies in the install directory (#900, THE-939; issue #881). | CHANGELOG.md (1.27.0) | 5 |
| THE-943 | Companion plugin renamed to TC Bridge (#888, THE-943). | CHANGELOG.md (1.26.0) | 2 |
| THE-944 | Local reranker reachable without a source checkout (#891, THE-944). | CHANGELOG.md (1.26.0) | 10 |

350 distinct ticket(s) across 493 source file(s) under
`packages/*/src`; 250 resolved to a public summary, 100
fall back to the internal-reference placeholder above.
