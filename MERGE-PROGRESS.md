# MERGE-PROGRESS.md — THE-233 Converged Engine Thin Merge

> **Single source of truth.** A cold agent resumes from this file alone. Update it per unit.
> Owner: orchestrator (Claude). Legacy stays LIVE and UNTOUCHED — this file performs no teardown.

---

## 0. Resume contract

If you are picking this up cold:
1. Read §1 (locked inputs + corrections), §2 (governing-doc reconciliation + **tripwire**), §3 (DAG).
2. Read §6 (unit ledger) for current state and the next actionable unit.
3. The move-map (§5), export manifest (§7), and eval gate (§8) are the working specs.
4. Honor §2's tripwire and §11's NO-TEARDOWN guard absolutely.
5. Run every unit through the self-gate (§9) before marking green; commit + push per unit.

**Status @ last update (2026-06-26):** Batch 1 **GREEN** — W-SCHEMA (`the-233/schema` @ 18df47f)
and W-GATEWAY-CLIENT (`the-233/gateway-client` @ 8fecea1) shipped, self-gate green, pushed.
Repo-hygiene fixes on `main`: ARCHITECTURE.md scope note (4b679b0) + the KMS-path bug in
`~/.claude/CLAUDE.md` (the only place it lived — the repo was clean). Two isolated worktrees exist
at `E:\Projects\obtc-the233-schema` and `E:\Projects\obtc-the233-gateway`.
**STOPPED after Batch 1 per instruction** — did NOT start Slice 2/3/4. Next actionable (see §6):
W-AUTH and W-INGEST are secret-free; W-RETRIEVAL/W-PLANE build on these two units; W-MIGRATE
still needs **E3**. **Open question to the user: Escalation E7 (KMS port branch).**

---

## 1. Locked inputs (from brief) + verified corrections

| Item | Value |
|---|---|
| TARGET (substrate) | `E:\Projects\obsidian-tc` — bun workspace monorepo, `main` @ `fd58807`, packages/{native,plugin,server,shared} |
| LEGACY (source) | `E:\Projects\knowledge-mcp-server` — **CORRECTED** from brief/CLAUDE.md's `E:\knowledge-mcp-server` (off by one dir). On branch `fix/npm-audit-2026-06-12`. Express/npm/Postgres+Supabase. |
| Substrate decision | SQLite + sqlite-vec ONLY. Postgres/Supabase = read-from for EXPORT only. No dual `StorageBackend` trait — the existing synchronous `packages/server/src/db/types.ts` seam is the whole story. |
| Inference | All GENERATIVE calls via self-hosted **LiteLLM** gateway, roles `extract`/`synthesize`/`judge`. NO provider SDKs in the tree. |
| State | Episode/engram/feedback/contradiction/synthesis state: EXPORT and KEEP (load into obsidian-tc SQLite). Experiential tier = **separate physical SQLite store** (membrane). |
| Workers | The 2 Cloudflare workers (synthesis, audit) COLLAPSE into obsidian-tc's in-process sleep-time plane. |
| Teardown | NONE. See §11. |
| Linear | **THE-233** "Converged monorepo migration (phase 1): fold knowledge-mcp-server intelligence onto the obsidian-tc spine." Backlog; G1 cleared → G2 Design. Blocks THE-235 (atomic-claim extraction) + THE-234 (clean-room engine). Branch: `mislam2/the-233-converged-monorepo-migration-phase-1-fold-knowledge-mcp`. |

---

## 2. Governing-doc reconciliation (DECIDED by orchestrator) + the tripwire

Three documents, reconciled:

1. **`obsidian-tc/ARCHITECTURE.md`** (shipped v1.0, gate G2.2). Its scope note (§22, §738, §765) says "obsidian-tc is an *access* MCP; retrieval intelligence is out of scope; pair with external RAG." → **SUPERSEDED** for the converged direction by the vault note's 2026-06-25 `single-converged-product` decision and Linear THE-233 ("obsidian-tc **becomes** the converged engine"). Bind to ARCHITECTURE.md for its transport/auth/ACL/policy/tooling/dispatch seams; **ignore** its "retrieval out of scope" stance.
2. **Vault note `02-projects/converged-memory-engine-architecture.md`** (v1.1, *architecture of record*, amended through 2026-06-26). SANCTIONS the convergence. Confirms: SQLite + sqlite-vec embedded-by-default (2026-06-26 amendment); server is bun/TS, Rust is an optional NAPI perf sidecar with JS fallback; LiteLLM roles; experiential tier as separate physical store (§5); in-process embed/rerank is the *eventual* target (§6).
3. **Linear THE-233** = the **fold/migration** phase. It *blocks* THE-235/THE-234 (the typed-atom substrate + clean-room engine), proving the substrate is downstream.

### TRIPWIRE (HARD WALL — held)
THE-233 is **behavior-preserving consolidation onto the existing `db/` seam**, NOT the typed-atom substrate redesign. Do **NOT** author: claim atoms, MemIR `epistemic_role`, `authoritative_claims`, `derives_from`, 4-timestamp Graphiti bi-temporal columns. That is the engine-build Phase 1 (THE-235), out of scope here. If a unit drifts into it: STOP, revert, log in §10.

> **Tripwire clarification (avoid false-positive paralysis):** KMS's existing `vault_object_state` already has `valid_from`/`valid_until` (a 2-timestamp validity, ACT-R/engram state). EXPORTING and LOADING that *existing* state as-is is behavior-preserving and **allowed**. AUTHORING the new 4-timestamp bi-temporal substrate is **forbidden**. Load state; don't redesign it.

### Deferred-to-engine-build (NOT this merge)
- The `StorageBackend` trait + optional Postgres backend (2026-06-26 amendment) — we use the existing sync `db/` seam only.
- In-process fastembed-rs / bge-reranker as the *spine* — we reuse obsidian-tc's existing `EmbeddingProvider` abstraction; rerank handled per §10-D1.
- AGPL relicense (THE-260) — obsidian-tc is currently Apache-2.0; **do not relicense** as part of THE-233. Preserve existing license headers on ported files; flag if a ported file carries an incompatible header.

---

## 3. Execution DAG (authored by orchestrator)

> The brief's `## Execution DAG` and explicit escalation-point list arrived **empty/truncated** (absent from both the brief text and Linear THE-233). Authored below from the brief's subagent roster + the ticket graph + the inventory. **Invites correction** (logged E5).

```
W0 INVENTORY (Phase 0) ──┐  [GREEN]
                         ├─> W-SCHEMA ──────┬─> W-MIGRATE ──> W-EVAL ─┐
W0 ─> W-GATEWAY-CLIENT ──┤                  ├─> W-AUTH               ├─(gate)─> W-RETRIEVAL
                         │                  ├─> W-PLANE  <───────────┘
                         └──────────────────┴─> W-INGEST
Verifier: independent self-gate (§9) on every branch, not self-graded by the porter.
```

| Unit | Workstream | Branch (`the-233/…`) | Depends on | Roster role |
|---|---|---|---|---|
| W0 | Inventory + move-map | (main, this file) | — | inventory |
| W-SCHEMA | SQLite schema/migrations for state + retrieval support (graph edges, chunk-FTS/BM25, rerank cache, oauth, job_runs) split across authored vs experiential stores | `the-233/schema` | W0 | porter |
| W-GATEWAY-CLIENT | Role-based OpenAI-compatible LiteLLM client (`extract`/`synthesize`/`judge`), endpoint = config, **no keys/routing in tree** | `the-233/gateway-client` | W0 | porter |
| W-MIGRATE | Export Supabase state → load SQLite (authored cache + separate experiential store); parity-check | `the-233/migrate` | W-SCHEMA, **E3** | migrator |
| W-EVAL | Port eval harness + golden sets + baseline; wire adapters to obsidian-tc search; (re)establish recall@k floor | `the-233/eval` | W-SCHEMA, W-MIGRATE | retrieval |
| W-RETRIEVAL | Port hybrid (BM25+vector+RRF), GraphRAG expand, rerank, the 8 tools, capture+activation, onto sqlite-vec | `the-233/retrieval` | W-SCHEMA, W-GATEWAY-CLIENT, W-MIGRATE; **gated by W-EVAL** | retrieval |
| W-AUTH | OAuth 2.1 + DCR + consent fold; SQLite storage; in-process Hono routes; pluggable `verifyToken` | `the-233/auth` | W-SCHEMA | auth |
| W-PLANE | In-process sleep-time plane (scheduler + JobContext + `job_runs`) hosting synthesis + audit jobs | `the-233/plane` | W-SCHEMA, W-GATEWAY-CLIENT | plane |
| W-INGEST | Port ingest (chunk/extract/secrets/embed/edges/sync/contradictions); fix broken sync automation; reconcile with existing `search/indexer.ts` | `the-233/ingest` | W-SCHEMA, W-GATEWAY-CLIENT | porter |

Foundational unblockers after W0: **W-SCHEMA** and **W-GATEWAY-CLIENT** (run concurrently in separate worktrees).

---

## 4. Verified staleness rationale (Linear "verify before load-bearing")

KMS Express service retirement is grounded, not assumed: Node/Express on Railway; npm (not bun); hard Postgres+Supabase coupling in every ingest/search module; provider SDKs (`openai`, `@anthropic-ai/sdk`, `cohere-ai`); `zod@^3`; `@modelcontextprotocol/sdk@1.0.0`; currently parked on a security-audit branch (`fix/npm-audit-2026-06-12`); **ingest automation broken** (manual `npm run sync` only). Target obsidian-tc is the modern spine: bun, SQLite+sqlite-vec, Hono, jose, zod4, node>=24, native NAPI module with JS fallback.

---

## 5. Move-map (Phase 0 output)

Classification: **PORT** | **PORT→ROLE** (provider SDK → LiteLLM role) | **EXPORT-STATE** | **COLLAPSE-PLANE** | **RECONCILE** (overlaps existing obsidian-tc code) | **DROP** (obsidian-tc equivalent exists) | **LEAVE-IN-KMS** | **DECISION** (see §10).

### 5a. KMS tools (`src/tools/`) → obsidian-tc tool surface
| Source | Class | Destination | Rewrite axis |
|---|---|---|---|
| `knowledge_search.ts` | PORT→ROLE | `src/search/knowledge.ts` + tool def | Supabase RPC→SQLite match; query embed via obsidian-tc provider |
| `knowledge_get_critical.ts` | PORT | `src/search/critical.ts` | Supabase select→SQLite |
| `knowledge_list_mcps.ts` | PORT | `src/search/list_mcps.ts` | Supabase agg→SQLite |
| `knowledge_feedback.ts` | PORT | tool def + `src/search/capture.ts` | Supabase upsert→SQLite |
| `knowledge_challenge.ts` | PORT→ROLE | tool def | `@anthropic-ai/sdk`→LiteLLM `judge`/`synthesize`; Supabase→SQLite; zod3→4 |
| `vault_search.ts` | PORT→ROLE | `src/search/vault.ts` | hybrid BM25+vec+RRF→sqlite-vec; Cohere→§10-D1; capture preserved |
| `vault_by_wikilink.ts` | PORT | `src/search/vault_wikilink.ts` | Supabase RPC→SQLite wikilink join |
| `vault_graph_search.ts` | **PORT (high-risk)** | `src/search/vault_graph.ts` | `vault_graph_expand` recursive CTE → SQLite recursive CTE (SQLite supports it) + sqlite-vec for `<=>`; 3 fusion modes preserved; Cohere→§10-D1 |

### 5b. KMS ingest (`src/ingest/`)
| Source | Class | Destination | Rewrite axis |
|---|---|---|---|
| `chunk.ts` | RECONCILE | vs `src/search/chunk.ts` (exists!) | pick one chunker; both heading-anchored |
| `extract.ts` | PORT | `src/ingest/extract.ts` | none (pure) |
| `secrets.ts` | PORT | `src/ingest/secrets.ts` | none (pure) — pre-embed secret gate |
| `embed.ts` | RECONCILE/DROP | use `src/embeddings/` provider | obsidian-tc already abstracts embeddings; drop OpenAI direct |
| `edges.ts` | PORT | `src/ingest/edges.ts` | Supabase→SQLite wikilink-edge reconciliation |
| `sync.ts` | PORT | `src/ingest/sync.ts` | Supabase→SQLite; **fix broken automation**; reconcile w/ `search/indexer.ts` |
| `contradictions.ts` | PORT→ROLE | `src/ingest/contradictions.ts` | Haiku judge→LiteLLM `judge`; neighbor RPC→sqlite-vec; queue→bounded pool/plane |
| `db.ts`, `types.ts` | DROP/merge | — / shared types | Supabase client gone; merge zod types (→zod4) |

### 5c. KMS memory/rerank/inference (`src/lib/`, root)
| Source | Class | Destination | Rewrite axis |
|---|---|---|---|
| `lib/activation_reference.ts` (+test) | PORT | `src/search/activation.ts` | none (pure ACT-R math; mirrors migration 020) |
| `lib/bubble_safe_rerank.ts` (+test) | PORT | `src/search/bubble_safe_rerank.ts` | none (pure) |
| `lib/capture.ts` | PORT | `src/search/capture.ts` | Supabase insert→SQLite (sync seam, error-tolerant) |
| `reranker.ts` (+test) | **DECISION** | `src/search/rerank.ts` | Cohere → §10-D1; preserve graceful no-op fallback |
| `embedding.ts`, `utils.ts` | DROP | — | obsidian-tc `EmbeddingProvider` covers it |
| `clients.ts`, `logger.ts` | DROP | — | obsidian-tc has its own |
| `index.ts` | LEAVE (mine for wiring) | — | Express+MCP entry; obsidian-tc uses `transports/`+`mcp/` |
| `types.ts` | PORT/merge | shared types | → zod4 |

### 5d. KMS auth (`src/oauth/`) — see §10-D4 (is it wired?)
| Source | Class | Destination | Rewrite axis |
|---|---|---|---|
| `oauth/server.ts` | PORT | `src/auth/oauth-server.ts` | keep AuthServer config; SQLite model |
| `oauth/storage.ts` | PORT + MIGRATE | `src/auth/oauth-storage.ts` | Supabase model (5 tables)→SQLite; identical row shapes |
| `oauth/consent.ts` | PORT | `src/auth/oauth-consent.ts` | Express→Hono; bcryptjs fate (§10); session cookie |
| (today) `src/auth/jwt.ts` | EXTEND | pluggable `verifyToken` | JWT verify stays; add OAuth bearer path in `transports/http.ts` |

### 5e. KMS workers → sleep-time plane
| Source | Class | Destination | Rewrite axis |
|---|---|---|---|
| `kb-synthesis-worker/` | COLLAPSE-PLANE | `src/plane/jobs/synthesis.ts` | CF cron→in-proc schedule; Anthropic→LiteLLM `synthesize`; GitHub commit preserved (env); logs→`syntheses` |
| `kb-audit-worker/` | COLLAPSE-PLANE | `src/plane/jobs/audit.ts` | CF cron→in-proc; 6 Supabase RPCs→SQLite CTEs; →`audit_reports`/`audit_flags` |
| `unaligned-cron-worker/` | LEAVE-IN-KMS | — | empty placeholder |

### 5f. KMS eval + migrations
- **eval/**: `harness.ts`, `metrics.ts`, `compare.ts`, `compare-runs.ts`, `reachability.ts` → PORT (logic stable). `golden-set.ts`, `multi-hop-golden-set.yaml`, `baseline.json` → PORT (data). `adapters/{vault_search,vault_graph_search}.ts`, `run.ts`, `failure_analysis.ts` → ADAPT to obsidian-tc search API. Dest `packages/server/eval/`. See §8.
- **migrations/** (Postgres → SQLite):
  - STATE-TABLE (export+load via W-MIGRATE): `006 vault_chunks` (authored), `003 syntheses` (authored), `017 vault_object_state` (experiential), `018 chunk_retrievals` (experiential), `002 contradictions` (experiential), `vault_sync_state`.
  - PG-RETRIEVAL-FN (reimplement in app/SQLite, W-RETRIEVAL): `004 find_vault_chunk_neighbors`, `005/011/013 vault_graph_expand` (final sig = 013, virtual edges), `007/009 vault_search` (hybrid RRF + priority boosts), `008 vault_by_wikilink`, `019 vault_search_id` (activation multiply), `020 activation_recompute` (pg_cron→plane job).
  - OAUTH: `001` → W-AUTH. CONSTRAINTS/META: `012/014/015/016` → fold into W-SCHEMA equivalents (note: `015` tsvector enrich → FTS5/BM25 equivalent; will shift BM25 scores → re-baseline, §8).
- **scripts/**, `tests/`, `benchmark-mock.ts`, `test-*.ts`, `list-tools.mjs` → LEAVE-IN-KMS (or travel with their module's tests where ported).

---

## 6. Unit ledger

| Unit | State | SHA | Notes |
|---|---|---|---|
| W0 inventory | **green** | b3212b2 | Move-map §5, manifest §7, eval §8, decisions §10 produced |
| W-SCHEMA | **green** | `the-233/schema` @ 18df47f | vault_edges (cache.db) + experiential.db (object_state, chunk_retrievals); provisionExperientialDb; self-gate green (656 tests). Pushed. |
| W-GATEWAY-CLIENT | **green** | `the-233/gateway-client` @ 8fecea1 | role client extract/synthesize/judge + rerank passthrough; env/mock-injectable; self-gate green (660 tests). Pushed. |
| W-MIGRATE | blocked | — | needs **E3** (Supabase project ref + read creds) |
| W-EVAL | todo | — | after schema+migrate |
| W-RETRIEVAL | todo | — | gated by W-EVAL |
| W-AUTH | todo | — | pending §10-D4 verification |
| W-PLANE | todo | — | needs gateway client |
| W-INGEST | todo | — | reconcile w/ existing indexer |

States: todo / doing / blocked / green / escalated.

### Batch 1 delivered surface (for resume)
- **W-SCHEMA tables** — `cache.db`: `vault_edges`(source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at; UNIQUE(source,target,type) + source/target/kind indexes). `experiential.db` (physically separate, membrane): `vault_object_state`(object_id PK + ACT-R cols incl. valid_from/until, emotional_weight default 5, cached_activation_score) and `chunk_retrievals`(id PK, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results, rerank_score, cited_in_response, citation_score, feedback). No cross-file FK (chunk ids by value). Files: `migrations/20260626_001_vault_edges.sql`, `migrations/20260626_001_experiential_init.sql`; provisioner `db/experiential.ts`; wired in `cli.ts`. Tripwire held.
- **W-GATEWAY-CLIENT surface** — `createGatewayClient(opts)` → `{ extract, synthesize, judge, rerank }`. Completions POST `/chat/completions` `{model: <role>}`; rerank POST `/rerank` (Cohere-compatible passthrough, D1). Base URL from `OBSIDIAN_TC_GATEWAY_URL` (or `opts.baseUrl`); optional bearer `OBSIDIAN_TC_GATEWAY_TOKEN`; `opts.models` maps role→model; `fetchFn` injectable (mock→live is config-only); resolved provider:model surfaced for attestation. Module `src/gateway/{client,index}.ts`. No provider SDKs / keys in the tree.

---

## 7. Export-state manifest (W-MIGRATE)

Source = KMS Supabase (read-only). Targets = two SQLite files (membrane):
`cache.db` (authored) and a separate `experiential.db` (low-trust).

| Supabase table | Tier → target file | Row shape (summary) | Notes |
|---|---|---|---|
| `vault_chunks` | authored → `cache.db` | id, path, folder, chunk_index, headings, content, content_sha, wikilinks, tags, frontmatter, embedding(1536), embedded_at | ~4k rows incl. embeddings; feeds W-EVAL corpus |
| `syntheses` | authored → `cache.db` | iso_year, iso_week, vault_commit_sha, clusters(JSON), patterns(JSON), judge_model | weekly synthesis history |
| `vault_object_state` | experiential → `experiential.db` | object_id→chunk, retrieval/storage_strength, frequency, last_accessed, valid_from/until, emotional_weight, confidence, hits/misses, cached_activation_score | ACT-R state; load as-is (tripwire note §2) |
| `chunk_retrievals` | experiential → `experiential.db` | chunk_id, retrieved_at, session_id, surface_type, query_text, rank, cohere_score, feedback | append-only retrieval log |
| `contradictions` | experiential → `experiential.db` | source/conflict chunk, cosine, judge_verdict/rationale/model, status | flag-only lifecycle |
| `vault_sync_state` | system → `cache.db` | singleton: last_run_at, last_commit_sha, chunks_total | reset `last_run_at` for clean re-sync |

Parity check: row counts per table + spot-check N embeddings (dim + norm) + recall@k unchanged on migrated corpus (§8).

---

## 8. Eval gate (W-EVAL → gates W-RETRIEVAL)

- **Gate A (regression):** 30-query golden set; mean recall@10 must NOT drop >5pp vs `baseline.json` (2026-06-12).
- **Gate B (multi-hop):** 10-query multi-hop set; `vault_graph_search` recall@10 must be ≥20pp over flat `vault_search`.
- **Re-baseline risk:** baseline computed with `text-embedding-3-small` + `rerank-v3.5`. If obsidian-tc's configured embedding model or the rerank decision (§10-D1) differs, re-establish the baseline on obsidian-tc first and record the new floor here before gating.
- Adapters must call obsidian-tc `src/search/` and emit graph-aware fields (`source`, `hop`, `via_edge`) for Gate B.

---

## 10. Open decisions (resolve in the named workstream; do not silently default)

- **D1 — Cohere rerank (W-RETRIEVAL).** "No provider SDKs" vs behavior-preservation. Lead: route rerank through **LiteLLM's rerank passthrough** (keeps Cohere quality, no SDK in tree, preserves graceful no-op fallback on gateway timeout/unconfigured). Alt: in-process bge-reranker (bigger; deferred to engine-build). **Recommended: LiteLLM passthrough.**
- **D2 — Embeddings reconciliation (W-INGEST/W-RETRIEVAL).** KMS `embed.ts`/`embedding.ts` (OpenAI direct) is redundant; use obsidian-tc's existing `EmbeddingProvider`. Must confirm dimension alignment (KMS corpus = 1536) before importing `vault_chunks` embeddings, else re-embed.
- **D3 — Ingest vs existing indexer (W-INGEST).** obsidian-tc already has `search/chunk.ts` + `search/indexer.ts`. Reconcile rather than port a parallel pipeline; KMS adds: secrets gate, wikilink edges, contradiction hook, vault-sync orchestration + automation fix.
- **D4 — Is KMS OAuth wired/needed (W-AUTH)?** Agent reports conflict: `oauth/` exists (OAuth 2.1+DCR+consent) but may be unreferenced by tools / single-tenant today. Verify it's load-bearing before porting the full server; minimum is the pluggable `verifyToken` seam. Decide fate of `mcp-oauth-server`/`bcryptjs`/`express` deps (reimplement on Hono vs vendor).
- **D5 — Experiential separate store (W-MIGRATE/W-SCHEMA).** Confirmed direction: experiential state in its own SQLite file per vault-note §5 membrane. Implement as a second DB handle, not a partition.
- **D6 — `vault_object_state.valid_from/until` (W-MIGRATE).** Load existing 2-timestamp state as-is (allowed, §2). Do NOT extend to 4-timestamp bi-temporal (tripwire).

---

## Escalation log

| # | State | Item |
|---|---|---|
| E1 | resolved | KMS path wrong in brief/CLAUDE.md (`E:\knowledge-mcp-server`) → actual `E:\Projects\knowledge-mcp-server`. |
| E2 | resolved | Apparent contradiction (GraphRAG into "access-only" obsidian-tc) → SANCTIONED by vault note + Linear THE-233; ARCHITECTURE.md retrieval-scope SUPERSEDED. |
| E3 | **open (deferred)** | W-MIGRATE needs the legacy **Supabase project ref + read-only service key** to export state. Escalate to human when W-MIGRATE starts. (Judgment/keys = "out of Claude Code" per vault note §12.) |
| E4 | **open (deferred)** | W-GATEWAY-CLIENT integration test needs the **LiteLLM endpoint + role routing config** (judgment/keys, §12). The code seam is buildable now with config injection; live wiring escalates at integration. |
| E5 | resolved | Brief's `## Execution DAG` + escalation points arrived empty; orchestrator authored §3 from roster + ticket graph. **Confirmed by user 2026-06-26** ("proceed as scoped"). |
| E6 | open (info) | AGPL relicense (THE-260) is in flight but **out of scope** for THE-233; preserve Apache-2.0 headers. Flag if a ported KMS file carries an incompatible license. |
| E7 | **open (question)** | **KMS port branch.** KMS is on `fix/npm-audit-2026-06-12` @ 463c650, not `main`. No Batch 1 unit reads KMS source, so not yet blocking — but the first source-porting slice (W-INGEST / W-RETRIEVAL / W-AUTH) must port from a confirmed branch. **Decision needed: port from `fix/npm-audit-2026-06-12`, or land it on KMS `main` first?** Until answered, do not read KMS source for porting. |

---

## 11. DECOMMISSION HANDOFF — WRITTEN, NEVER EXECUTED

> ⚠️ For the SEPARATE human teardown pass. **No agent executes any item here.** Everything below stays LIVE until a human, post-verification, decides otherwise.

Preconditions before ANY teardown is even considered: obsidian-tc converged build green on all units; export parity verified (§7); recall@k gates green (§8); obsidian-tc running in production alongside legacy for a human-decided soak period.

Legacy assets that REMAIN LIVE (do not touch):
- [ ] KMS Railway deployment (Express service).
- [ ] KMS Supabase project (source of the export; keep until parity is human-confirmed).
- [ ] KMS repo `E:\Projects\knowledge-mcp-server` (read-only to agents).
- [ ] KMS vault→Supabase sync (the live ingest path).
- [ ] Cloudflare workers: `kb-synthesis-worker`, `kb-audit-worker`.
- [ ] External API keys: Cohere (rerank), OpenAI (embeddings) — still used by live legacy.

When the human runs teardown, suggested order (each gated on the prior): cut over traffic → soak → retire CF workers → retire Railway service → freeze Supabase (snapshot) → revoke keys → archive repo. **Reversible until the Supabase snapshot is deleted — which the agent never does.**
