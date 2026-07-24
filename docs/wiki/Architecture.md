# Architecture

Full design record: [`ARCHITECTURE.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/ARCHITECTURE.md). Tool surface: [`docs/G2.1-tools.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.1-tools.md).

obsidian-tc is a **polyglot monorepo**. The server is a single Bun/Node process; the companion plugin runs inside Obsidian; the native module is Rust linked over napi-rs.

## Packages

| Package | Language | Owns |
|---|---|---|
| `packages/server` | TypeScript (Bun + Hono; runs under Node >= 24 too) | Transport, auth, ACL, policy, router, tool impls, bridges, observability |
| `packages/plugin` | TypeScript | Companion Obsidian plugin (`/obsidian-tc/v1/*` routes) |
| `packages/native` | Rust (napi-rs) | cosine similarity, Unicode tokenizer, BM25 term scoring |
| `packages/shared` | TypeScript | Shared Zod schemas + types |

**Where the native module matters:** the main win is cosine similarity on the brute-force vector path (used when the bundled `sqlite-vec` extension can't load). The native tokenizer + BM25 power the fallback lexical ranker and the `find_capability` catalog search — primary lexical ranking for `search_text` is SQLite FTS5's own `bm25()` over the trigram index. Everything works without a prebuild.

## Components

Server-side (one process, soft TS-module boundaries): **Transport** (JSON-RPC over STDIO / Streamable HTTP), **Auth** (JWT / none), **ACL** (scope vs path/op), **Policy** (idempotency, rate limit, HITL), **Router**, **Tool impls**, **Plugin bridges** (HTTP to the companion plugin), **Embedding providers** (Ollama / OpenAI / Voyage / Cohere), **Native module**, **SQLite caches** (authored `cache.db` + quarantined `experiential.db` per vault), **Observability emitters**.

Obsidian-side (separate process): **Companion plugin** and the third-party **Local REST API plugin**.

## Dispatch pipeline

Every `tools/call` flows through seven layers; observability always fires, even on error:

1. **Transport** — parse JSON-RPC, normalize to `ToolRequest`, compute `args_hash`.
2. **Auth** — validate JWT or accept `none` (loopback only); build `AuthContext` with scopes.
3. **ACL** — evaluate the tool's declarative ACL annotation against scopes + vault + paths; honor the global `readOnly` kill switch.
4. **Policy** — (a) idempotency-key replay, (b) per-class rate limit, (c) HITL threshold → mint/consume `elicit_token`.
5. **Router** — static name → impl lookup.
6. **Tool impl** — Zod-parse args, run logic (may call native, a bridge, an embedding provider, SQLite).
7. **Observability** — OTLP span, Prometheus counter + histogram, event emit, JSONL trace, `event_log` row.

Details and the per-error short-circuits live in **[[Security and ACL]]** and **[[Observability]]**.

## IPC contracts

| Boundary | Wire | Auth |
|---|---|---|
| Server ↔ Companion plugin | HTTP over the Local REST API port (`127.0.0.1:27124`), path-versioned `/obsidian-tc/v1/*` | Shared bearer token (REST API key) |
| TypeScript ↔ Rust native | napi-rs FFI, synchronous, copy-on-boundary | In-process |

The native module never throws on a missing prebuild — a hand-written loader tries a local `.node`, then the platform sub-package, then the numerically identical pure-JS fallback (`nativeLoaded` tells callers which backend is active).

## Multi-vault registry

Each configured vault is isolated at the storage layer: its own SQLite caches (`cache.db` + `experiential.db`), its own JSONL trace directory, its own embedding provider, and its own slice of the global ACL (per-vault `acl` overrides supported). Vault resolution order: explicit `args.vault` → `OBSIDIAN_TC_DEFAULT_VAULT` → config default → the sole vault → else `invalid_input`.

## Retrieval (shipped, measured)

The converged retrieval engine shipped in the v1.4–v1.7 line: GraphRAG graph-walk via `vault_graph_search` (vector seeds + wikilink expansion, fused with RRF), FTS5 BM25 text search and dense-vector search (vec0 with a per-vault **partition key**, so KNN prunes to the query vault's shard), and gateway-optional rerank + `knowledge_challenge` red-team. Every ranking change is gated by an **n=250 golden set with a statistical ship rule**; contextual chunk enrichment (`embeddings.chunkContext`, default on) measured +0.223 nDCG. Mechanisms that lost their A/B (rerankers, learned sparse, query decomposition, class router, convex fusion) ship **dark behind flags** with their numbers recorded, each with a one-command re-test. An experimental **graph-densification** pass (off by default) can add derived edges to the wikilink graph beyond authored links: frontmatter tag co-occurrence, vec0 kNN semantic neighbors (built from the embeddings already computed, no egress), and an optional LLM pass routed through the **local** inference gateway. The walk traverses them down-weighted vs authored links. It is derived and rebuildable, never written back into notes as wikilinks, and stays dark behind `retrieval.densify.*` pending its own golden-set A/B — retrieval defaults are unchanged.

## The memory engine (v1.6–v1.7)

The experiential tier is a **membrane**: a physically separate `experiential.db` beside the authored `cache.db`, with its own migration chain. Nothing in it can reach an authored chunk except through query-time composition.

- **Write side** — `chunk_retrievals` logs every serve-path retrieval (with later-stamped `outcome` and `cited_in_response` axes); `agent_episodes` auto-captures dispatch outcomes (content capture defaults **off**), born `pending`, with a deterministic pre-ingest poison scanner that marks injection-shaped content born-ineligible.
- **Evaluation** (`obsidian-tc reflect`, sleep-time) — pending episodes promote under deterministic rules; an optional gateway judge can only lower; the same pass maintains a **versioned preference profile** updated only by typed deltas.
- **Read side** — the M8 tools enforce the reader contract: eligible-only, tombstones, trust floor, caller partition.
- **Deletion** — `forget` propagates through derived state with tombstone-vs-erase modes and a **hash-chained `forget_log`** (editing any entry breaks verification).
- **Flywheel** — access statistics are views over the retrieval log (never mutated columns on the authored store); the `metrics` / `gaps` CLIs feed a cycle-close loop that writes scorecards back into the vault.

## Protocol

MCP spec **2025-11-25**. STDIO for local; Streamable HTTP for HTTP modes. The server advertises **tools, resources, and prompts** — notes are readable as MCP Resources over `obsidian-tc://<vault>/<path>` URIs (read-scope + folder-ACL enforced). HITL uses a custom single-use `elicit_token` pattern that works with any MCP client.

## V2 (parked, with a trigger)

The typed-atom MemIR substrate (claim atoms, `authoritative_claims`, `derives_from` provenance) remains reserved for a next substrate generation. Its qualification spike ran in 2026-07 and **did not clear the pre-registered quality bar at the local-model footprint**, so the program is parked with recorded numbers and an explicit re-entry trigger. v1.x is the stable line; V2 capabilities would be added additively.
