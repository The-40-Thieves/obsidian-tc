# obsidian-tc

> Obsidian Turbocharged — governed, agent-ready vault access over MCP.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
![Status: Shipped v1.27.0](https://img.shields.io/badge/Status-Shipped_v1.27.0-success)

```bash
npm install -g obsidian-tc      # Node >= 24 or Bun >= 1.1
```

Also ships as a Docker image (`ghcr.io/the-40-thieves/obsidian-tc`), a one-click `.mcpb` bundle, and standalone binaries.

Since v5.0 (2026-07-24), the Local REST API plugin ships its own built-in MCP server — 18
tools at `https://127.0.0.1:27124/mcp/` for vault CRUD, search, and commands. obsidian-tc adds
three things it doesn't have: **governed writes** (folder ACLs, human-in-the-loop confirmation,
compare-and-swap, an audit log), **fused retrieval** (BM25 + vector + graph, RRF-fused and
reranked), and **memory that lives in the vault** — episodes, activation decay, and explicit
forgetting, under the same ACL as every other write.

The fastest way to try it, no install step and no config file:

```sh
npx obsidian-tc /path/to/vault
```

Lexical search and every note tool work immediately; semantic and graph-seeded retrieval need
an embeddings backend (Ollama by default), which is the upgrade a config file buys you.

## Why this exists

An AI agent with raw filesystem access to your Obsidian vault can do real damage: overwrite years of notes, delete the wrong folder, read the journal you never meant to expose, or quietly leak plugin API keys sitting in `.obsidian/`. Most Obsidian MCP servers hand an agent that access with little more than an API key between it and everything you have written.

obsidian-tc gives agents **governed** access instead. Every tool call — no exceptions — runs through one dispatch pipeline: auth → scopes → folder ACL → read-only kill switch → idempotency → throttle → human-in-the-loop confirmation → handler → response governor → audit log. You decide which folders an agent can read, write, or delete (per vault, per caller); destructive operations fail closed until a human approves them; and every invocation is audited on a best-effort basis (an audit-store write failure surfaces in `server_health` and is never swallowed silently, but it does not block the call — observability must never break dispatch).

New here? Start with the [5-minute quickstart](./docs/QUICKSTART.md) or the [threat model and design rationale](./docs/WHY.md).

## The interface: 3 tools, ~163 governed capabilities

By default the server advertises just **three meta-tools** instead of a wall of 150:

- **`find_capability`** — BM25 search over the caller-visible capability catalog ("how do I move a note?")
- **`describe_capability`** — one capability's schema, required scopes, and safety hints
- **`call_capability`** — invoke the named capability; the call routes through the same auth/scope/ACL/HITL/idempotency/throttle pipeline as a direct call, and the target's own schema validates the arguments

This keeps agent context lean while the full surface — 163 tools across 31 domains — stays reachable, and every tool remains directly callable by name. `toolFacade.mode` selects the shape: `triad` (default), `domain` (~a dozen domain meta-tools like `notes`, `search`, `vault`), or `flat` (the full advertised surface, the pre-facade behavior). The facade is boundary-only: no gate is ever bypassed, whichever mode you pick.

<!-- BEGIN GENERATED: tools-summary -->
**163 governed capabilities**, grouped by access scope.

**read** (96) — `audit_provenance`, `bundle_files`, `bundle_folder`, `diagnose_retrieval`, `episode_stats`, `eval_dataview_field`, `explain_answer`, `find_link_cycles`, `find_notes_by_property`, `find_notes_by_tag`, `find_orphans`, `find_unresolved_links`, `gap_report`, `generate_uri`, `get_attachment`, `get_backlinks`, `get_entity`, `get_index_status`, `get_link_strength`, `get_note_tags`, `get_outgoing_links`, `get_periodic_note`, `get_session_traces`, `get_vault`, `git_diff`, `git_log`, `git_status`, `graph_centrality`, `graph_communities`, `graph_path_between`, `knowledge_challenge`, `knowledge_get_critical`, `knowledge_search`, `list_attachments`, `list_bookmarks`, `list_capture_queue`, `list_commands`, `list_contradictions`, `list_goals`, `list_kanban_boards`, `list_notes`, `list_periodic_notes`, `list_properties`, `list_quickadd_actions`, `list_snapshots`, `list_tags`, `list_tasks`, `list_templates`, `list_vaults`, `list_workspaces`, `makemd_list_spaces`, `makemd_query`, `note_exists`, `note_quality_report`, `ocr_attachment`, `ocr_bulk`, `plur_get`, `plur_recall`, `plur_recall_hybrid`, `plur_similarity_search`, `query_base`, `query_canvas`, `query_datacore`, `query_entity_graph`, `read_base`, `read_canvas`, `read_excalidraw`, `read_frontmatter`, `read_kanban_board`, `read_metadata_fields`, `read_note`, `read_notes`, `read_property`, `read_snapshot`, `reflect`, `remotely_save_status`, `resolve_daily_note`, `search_dql`, `search_jsonlogic`, `search_omnisearch`, `search_regex`, `search_semantic`, `search_text`, `search_vault`, `server_health`, `session_bootstrap`, `snapshot_note`, `suggest_links`, `tasks_filter`, `validate_dql`, `vault_context`, `vault_graph_search`, `vault_health_score`, `work_episode_chain`, `work_episodes`, `work_search`

**write** (46) — `add_bookmark`, `add_kanban_card`, `add_observation`, `add_tag`, `append_note`, `append_to_periodic_note`, `close_goal`, `commit_capture`, `copy_note`, `create_base`, `create_canvas`, `create_entity`, `create_excalidraw`, `create_periodic_note`, `end_session`, `enqueue_capture`, `execute_template`, `find_or_create_periodic_note`, `format_table`, `git_stage`, `insert_table_column`, `insert_table_row`, `link_entities`, `move_kanban_card`, `open_workspace`, `patch_note`, `prune_hub_links`, `record_retrieval_feedback`, `remotely_save_trigger`, `remove_tag`, `rename_entity`, `restore_note`, `rewrite_link`, `save_workspace`, `set_goal`, `sort_table_by_column`, `start_session`, `unlink_entities`, `update_base`, `update_canvas`, `update_excalidraw`, `update_frontmatter`, `update_task`, `work_forget`, `work_result`, `write_note`

**delete** (6) — `delete_attachment`, `delete_entity`, `delete_note`, `move_attachment`, `move_note`, `remove_bookmark`

**bulk** (3) — `bulk_create_notes`, `bulk_move_notes`, `bulk_set_property`

**execute** (3) — `execute_command`, `git_commit`, `trigger_quickadd`

**admin** (9) — `add_vault`, `get_metrics`, `get_server_config`, `index_vault`, `inspect_acl`, `inspect_visibility`, `refresh_plugin_capabilities`, `reload_vault`, `reset_vault_cache`
<!-- END GENERATED: tools-summary -->

## What it is

obsidian-tc is a comprehensive Model Context Protocol (MCP) server for [Obsidian](https://obsidian.md), designed for both humans and autonomous agents. Multi-vault native. Pluggable embeddings. Works with local Ollama or cloud models.

Three pillars:

1. **Broad.** 163 tools covering the meaningful Obsidian operations — including native Bases (`.base`) support with a real expression-DSL evaluator, GraphRAG retrieval, a quarantined work-memory tier, and composite context calls — the broadest open-source Obsidian MCP surface we know of (surveyed 2026-07).
2. **Governed by default.** JWT auth (HS256 or asymmetric RS256/ES256/EdDSA via a local JWKS with `kid` rotation), folder ACLs (per vault), read-only kill switch, human-in-the-loop elicit on destructive operations, compare-and-swap on writes, idempotency keys, bulk throttling.
3. **Observable from day one.** OpenTelemetry traces, Prometheus metrics, structured CloudEvents emission on every tool call — all opt-in export streams that fail soft.

Beyond Tools, the server exposes your vault as MCP **Resources** (`resources/list` + `resources/read` over `obsidian-tc://<vault>/<path>` URIs, read-scope and folder-ACL enforced) and a set of built-in **Prompts** (`prompts/list` + `prompts/get`).

## Status

✅ **Shipped — v1.27.0** (2026-08-02). Published to npm as provenance-signed packages, with a container image at `ghcr.io/the-40-thieves/obsidian-tc:1.27.0`. The surface is **163 tools across 31 domains**, presented by default via the triad facade described above.

The v1.6–v1.7 line turned the server into a **measured memory engine** (full detail in the [CHANGELOG](./CHANGELOG.md)):

- **Experiential work-memory tier** — a quarantined second store (never mixed with your authored notes): serve-path retrieval logging with a citation signal, auto-captured agent work episodes with a pre-ingest poison scanner and evaluator-stamped eligibility, and reader tools under a strict contract (eligible-only, tombstones, trust floor, caller partition).
- **Composite context surfaces** — `vault_context` (the one-call `get_context(query, token_budget)` primitive: budget-packed graph-reranked chunks, synthesis patterns, open contradictions, proactive lesson surfacing, opt-in work episodes; session bootstrap reads a `_next-session.md` signal note through a TTL-enforced prewarm cache) and `reflect` (grounded synthesis with source provenance, an adversarial challenge mode, and a versioned preference profile updated only by typed deltas).
- **Dependency-aware deletion** — `forget` propagates a deletion through derived state, with tombstone-vs-erase modes and a hash-chained audit log where tampering with any entry breaks verification.
- **New companion bridges** — Obsidian Git (status/diff/log/stage, with commits behind a hardcoded human-confirmation floor) and Remotely Save (independent backup verification).
- **A knowledge-flywheel CLI family** — `metrics`, `gaps` (calibrated coverage floor), `prefetch`, `reflect`, `forget`, `citation-infer`, `contribution-report`, `activation-recompute`, `cluster`.
- **Retrieval measured, not asserted** — a statistical ship rule (paired permutation test + bootstrap CI, both unit-tested in CI) gates every ranking change against an n=250 golden set, which lives in a private vault and is **not checked in**. This bullet used to quote headline retrieval figures. **They have been withdrawn** (2026-08-07, THE-748): they entered the README before the oldest surviving eval artifact and could not be reproduced from anything on the eval host, so their provenance is unrecoverable. Trying to re-derive them also surfaced a harness defect — one flag was widening the graph arm's retrieval depth without widening the baseline's — now fixed, with each arm's depth recorded in every artifact. What ships in this repo is the *machinery*, and it is the part worth judging: the method, the ship rule, and the negative results are all in [docs/EVALUATION.md](./docs/EVALUATION.md). A reproducible retrieval result on a public corpus, dated 2026-08-07, lives there too, beside its own power analysis — no figure repeated here. Contextual chunk enrichment's **+0.223 nDCG** stands — it is a paired single-knob A/B, unaffected by the above. Mechanisms that lost their A/B ship dark behind flags with the numbers recorded. The vec0 index carries a per-vault partition key and metadata aux columns, rebuilt in place from stored embeddings (no re-embed).

Earlier v1.3.x hardening (per-vault ACLs, symlink-canonical enforcement, trigram FTS5 substrate, vec0 KNN pushdown, Bases expression-DSL evaluator, compute-abuse budgets, asymmetric JWT via local JWKS, the sleep-time consolidation scheduler, AGPL-3.0 relicense) is recorded in the CHANGELOG.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Walking skeleton: dispatch pipeline, folder ACL, HITL elicit, migrations | ✅ Merged |
| M1 | Core vault access — 30 tools (CRUD, frontmatter, tags, links) | ✅ Merged |
| M2 | Search + embeddings — 6 tools + retrieval substrate | ✅ Merged |
| M3 | Structured formats — 23 tools (Bases, Canvas, Periodic, Attachments, Bookmarks, Workspaces) | ✅ Merged |
| M4 | Plugin bridges + companion plugin — 20 tools across 9 domains | ✅ Merged |
| M5 | Memory + capture substrate — 15 tools (capture queue, memory entities + `[[link]]` graph, workspace sessions + JSONL traces, plur read proxy) | ✅ Merged |
| M6 | Bulk + admin + URI — 7 tools | ✅ Merged |
| M7 | Harden + ship: OpenTelemetry tracing, Prometheus `/metrics`, CloudEvents spool, rate limiter, 8-triple native prebuilds, release workflow | ✅ Shipped (v1.0.2) |
| M7+ | Knowledge domain: GraphRAG (`vault_graph_search`), `knowledge_challenge`, composite `vault_context` + `reflect` | ✅ Shipped (v1.4–v1.7) |
| M8 | Experiential work-memory tier: retrieval log, episode capture + poison defense, reader contract, preference profile, forget | ✅ Shipped (v1.6–v1.7) |

This repository is public under [`The-40-Thieves`](https://github.com/The-40-Thieves), licensed AGPL-3.0-only.

## Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP protocol layer, auth, routing, tool implementations, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/shared` | TypeScript | Shared Zod schemas and types |
| `packages/native` | Rust (via napi-rs) | Optional acceleration with a numerically-identical pure-JS fallback — see below |

**Where the native module actually matters:** the main native win is **batched cosine similarity** (`cosineBatch`) on the brute-force vector path (used when the bundled `sqlite-vec` extension can't load) — the whole candidate set is scored in ONE crossing of the JS↔native boundary. The per-pair entry point is a *pessimization* and is not used there: it measured 13–22× SLOWER than the pure-JS fallback, because the N-API crossing and query marshaling dwarf the arithmetic. Boundary granularity, not language, decides the win — cross once per query, never once per vector (THE-420). The native tokenizer + BM25 scorer power the **fallback** lexical ranker (the exhaustive disk scan used for sub-trigram queries or when the FTS index is missing/unhealthy) and the `find_capability` catalog search — the **primary** lexical ranking for `search_text` is SQLite FTS5's own `bm25()` over the trigram `notes_fts` index. Everything works without a prebuild; the native module makes some cold paths faster.

obsidian-tc is the **converged memory engine**: vault read/write, search, and control, *plus* folded-in retrieval intelligence: GraphRAG graph-walk via `vault_graph_search` (vector seeds + wikilink expansion, fused with RRF), FTS5 BM25 text search and dense-vector search as separate retrieval modes, gateway-optional rerank, and a `knowledge_challenge` decision red-team. The RRF fuses GraphRAG's seed/expansion streams into a general hybrid retriever — enriched BM25 + dense-vector + hop-ordered wikilink expansion at k=10 — which shipped and closed THE-196 (`search_vault` remains the mode router: text, then semantic on zero hits). GraphRAG edges carry a per-vault partition key (THE-310). Ambient consolidation (weekly synthesis + decision audit) runs on the sleep-time plane when the inference gateway is configured; the GraphRAG ship-gate eval (recall@10 vs baseline) still requires an out-of-band run against a freshly built index — machinery present and scheduled, headline retrieval numbers pending (THE-748). This supersedes the earlier "access MCP, retrieval out of scope" framing (the 2026-06-25 single-converged-product decision; see `ARCHITECTURE.md`). The reserved "V2 ML sidecar" (and the native `kmeansAssign` / `actrDecayScore` hooks) was removed; the typed-atom MemIR substrate is a downstream engine-build phase, not this v1.x line.

## Quick start

Full walkthrough (Claude Desktop / Claude Code wiring, first queries, a governed write): [docs/QUICKSTART.md](./docs/QUICKSTART.md). Prefer Docker over a local install? [docker-compose.yml](./docker-compose.yml) runs the server against a bind-mounted vault with no `npm install` needed.

Install, then point obsidian-tc at a JSON config — a vault `id` and `path` is the
minimum (every other field has a default):

```bash
npm install -g obsidian-tc
```

obsidian-tc runs on **Node (>= 24)** or **[Bun](https://bun.sh) (>= 1.1)** — `npm` / `npx`
installs run under Node (which uses `better-sqlite3`, falling back to the built-in
`node:sqlite`); under Bun it uses `bun:sqlite`. The runtime is auto-detected, so the same
install works either way.

The fastest start is zero-config: point it at a vault folder and it boots a single
vault named `main` with sensible defaults.

```bash
obsidian-tc /path/to/your/vault
```

For multi-vault, auth, ACLs, or custom embeddings, pass a config file instead:

`obsidian-tc.config.json`:

```json
{
  "vaults": [{ "id": "main", "path": "/path/to/your/vault" }]
}
```

```bash
obsidian-tc ./obsidian-tc.config.json
# or set the path in the environment:
OBSIDIAN_TC_CONFIG=./obsidian-tc.config.json obsidian-tc

# inspect the effective config (secrets redacted), or print the version:
obsidian-tc config show ./obsidian-tc.config.json
obsidian-tc version

# install the companion Obsidian plugin into your vault (then enable it in Obsidian):
obsidian-tc plugin install --vault /path/to/your/vault
```

### Runs locally by default

No cloud account or API key is required. With the defaults, everything runs on your
machine: embeddings via a local [Ollama](https://ollama.com) model (`nomic-embed-text`,
768-dim), vector search via the bundled `sqlite-vec` (with a pure-JS cosine fallback), and
a shared SQLite cache (one `cache.db`, row-scoped by vault). Pull the model once, then start:

```bash
ollama pull nomic-embed-text       # the default embeddings model
obsidian-tc /path/to/your/vault    # boots local-only, no config file
```

The optional inference gateway (`OBSIDIAN_TC_GATEWAY_URL`) powers rerank and the
`knowledge_challenge` red-team; leave it unset and those degrade gracefully while
everything else keeps working. Cloud embedding providers (OpenAI, Voyage, Cohere, or any OpenAI-shaped endpoint via `openai-compatible`) are
opt-in via a config file.

> **Security posture in zero-config mode.** `obsidian-tc /path/to/vault` boots with **auth off
> and no folder ACL** — any client that can reach the server has full read/write/delete over the
> vault (the same authority raw filesystem access would give). That is acceptable *because the
> surface is local-only*: the config **fail-closes** if you enable an HTTP transport on a
> non-loopback host while auth is off, and a DNS-rebinding/Origin guard protects the loopback
> bind. The governance layer this README leads with — JWT scopes, per-vault folder ACLs, the
> read-only kill switch, HITL — is **opt-in and off by default**; turn it on with a config file
> (`auth.mode: "jwt"` + `jwtSecret`, and `acl.readPaths` / `writePaths` / `deletePaths`) **before**
> exposing the server to partially-trusted, remote, or multi-agent callers. See
> [docs/WHY.md](./docs/WHY.md) and [SECURITY.md](./SECURITY.md).

### Plugin bridges (optional, live mode)

Bridge tools (Dataview, Templater, QuickAdd, OCR, Excalidraw, Obsidian Git, the
command palette, …) talk to your *running* Obsidian through the companion plugin and
need two per-vault config keys: `restApiUrl` (Local REST API's non-encrypted loopback
server, `http://127.0.0.1:27123`) and `restApiKey`. Live/headless mode is resolved
once at server start; without the keys, bridge tools return the typed
`requires_live_obsidian` while every filesystem tool keeps working. Setup walkthrough:
[docs/QUICKSTART.md](./docs/QUICKSTART.md) step 6.

> **The companion plugin was renamed.** It is now `tc-bridge` ("TC Bridge"), not `obsidian-tc`
> ("Obsidian Turbocharged") — the community plugin directory bans "obsidian" in a plugin id. If
> you installed it before this rename, your settings migrate automatically on first load after
> upgrading; see [docs/CUTOVER.md](./docs/CUTOVER.md) and `packages/plugin/README.md`.

## Install in Cursor / VS Code

One-click install (launches via `npx`; after installing, set the config path to your
own obsidian-tc JSON config):

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=obsidian-tc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLXRjIl0sImVudiI6eyJPQlNJRElBTl9UQ19DT05GSUciOiIvQUJTT0xVVEUvUEFUSC9UTy9vYnNpZGlhbi10Yy5jb25maWcuanNvbiJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_obsidian--tc-0098FF?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22obsidian-tc%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-tc%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_TC_CONFIG%22%3A%22%2FABSOLUTE%2FPATH%2FTO%2Fobsidian-tc.config.json%22%7D%7D)

Or add it by hand. The server object is the same; only the wrapper key differs — Cursor
(`~/.cursor/mcp.json`) uses `mcpServers`, VS Code (`.vscode/mcp.json`) uses `servers`:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/obsidian-tc.config.json" }
    }
  }
}
```

`OBSIDIAN_TC_CONFIG` is the absolute path to your obsidian-tc JSON config (vaults, ACL,
transports); it may also be passed as the first CLI argument. A prebuilt MCPB bundle
(`bun run bundle` → `dist/obsidian-tc.mcpb`) is also available for one-click install in
Claude Desktop and other MCPB hosts.

## How it compares

The ecosystem splits into three groups, and most projects sit squarely in one:

1. **Vault access servers** — expose your vault to an agent as tools. The large majority.
2. **Retrieval engines** — the vault as a search corpus: embeddings, BM25, graph, rerank.
3. **Memory engines** — durable agent memory (what happened, what was learned, what is
   no longer true), usually in a knowledge base *beside* your vault rather than in it.

obsidian-tc is the only one we know of that is all three at once, and the combination is
the point: the memory lives **in the vault**, under the same ACL and audit pipeline as
every other write. Concretely, we are not aware of another Obsidian MCP server that pairs
**write governance** (compare-and-swap, idempotency keys, snapshots with restore, a
per-invocation audit trail) with a **memory engine** (episodes, activation decay, explicit
forgetting with a hash-chained log, contradiction detection).

That is a narrow claim, deliberately. Several of the projects below do specific things as
well as or better than we do, and the honest comparison says so.

Features as of **2026-09-03**; these projects move quickly, so check their repos rather
than trusting this table. Tool counts are omitted where a project's README and its code
disagree.

| | Tools | Group | Retrieval | Governance | Memory engine |
|---|---|---|---|---|---|
| **obsidian-tc** | 163 (3-tool facade) | all three | BM25 (FTS5) · vector (vec0) · graph · RRF fusion · diversity | JWT (HS256/JWKS) · per-vault folder ACL · HITL elicit · CAS · idempotency · snapshots · audit log | episodes · activation · forgetting · contradictions |
| [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) (built-in MCP, v5.0+) | 18 | access | text (`search_query`/`search_simple`) | single REST API bearer key (full vault admin) | — |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | ~14 | access | text / regex | JWT/OAuth · folder-scoped path policy · read-only mode · elicited delete confirmation showing blast radius | — |
| [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) | 8 families | access | text · graph traversal · Dataview/Bases | path allow/block lists · read-only mode · per-operation controls · API key | — |
| [bitbonsai/mcpvault](https://github.com/bitbonsai/mcpvault) | ~14 | access | BM25 | traversal + symlink protection · delete confirmation | — |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | ~13 | access | text · JsonLogic / DQL | Local REST API key | — |
| [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools) — **archived** (last push 2026-05-13) | — | access | DQL · JsonLogic · semantic (via Smart Connections) | Local REST API key | — |
| [engraph](https://github.com/devwhodevs/engraph) | — | retrieval | 5-lane RRF: semantic · BM25 · graph · cross-encoder rerank · temporal, fully local | API keys with read/write levels · rate limit · operation log | — |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | ~35 | memory | semantic + keyword | path containment | entities · observations · relations, in a separate markdown KB |

Where the others win, plainly:

- **Zero-config start.** `mcpvault` is one `npx` line and `engraph` is one `brew install`
  with local models bundled — no config file, no separate embeddings pull. obsidian-tc's
  `npx obsidian-tc /path/to/vault` matches that for a single vault (lexical search and every
  note tool work immediately); multi-vault, ACLs, and custom embeddings still want a config
  file, and semantic/graph retrieval still wants an embeddings backend.
- **Nothing outside Obsidian.** `aaronsb/obsidian-mcp-plugin` runs *inside* the app — no
  external process at all. obsidian-tc is a standalone server.
- **Offline retrieval quality, as core rather than opt-in.** `engraph` ships cross-encoder
  reranking and a query orchestrator as core, on local models, everywhere it runs. obsidian-tc's
  cross-encoder reranker is now also local and gateway-free — an optional npm package
  (`@the-40-thieves/obsidian-tc-reranker-local`), auto-selected when no `reranker` block, no
  `embeddings.modelTier.full`, and no gateway URL are configured, that fetches and
  checksum-verifies its weights on first use — but it is opt-in machinery, not core: the
  standalone compiled binaries, musl (Alpine) installs, and macOS x64 can't reach it.
- **Memory as a portable KB.** `basic-memory` keeps memory in its own markdown store that
  syncs to any vault. If you want memory decoupled from one vault, that is the better fit.

What we have not seen elsewhere: multi-vault in one process with per-vault ACLs, a
retrieval change gated by a paired permutation test before it ships, and the memory tier
above.

## When NOT to use obsidian-tc

Honest guidance — obsidian-tc is deliberately a heavier product:

- **You want the smallest possible footprint.** A single trusted human driving a chat
  client over one vault is well served by the simpler community servers above; the
  governance pipeline here mostly pays off with autonomous or multi-agent access.
- **You only need read access.** A read-only wrapper (cyanheads' `OBSIDIAN_READ_ONLY`, or
  aaronsb's read-only mode) is less machinery for a similar safety outcome.
- **You want everything inside Obsidian.** obsidian-tc is a standalone server, not an
  Obsidian plugin — the optional companion plugin only bridges plugin-specific features.
  If you never leave the app, [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin)
  runs the whole server in-process, and community plugins may be all you need.
- **You want the best search with no setup and no network.** [engraph](https://github.com/devwhodevs/engraph)
  is a single binary with local models and no configuration. Our retrieval goes further on
  fusion and diversity and is gated by a statistical ship rule, but it asks more of you and
  its rerank stage is opt-in machinery today, not core: unreachable from the standalone
  compiled binaries, musl (Alpine) installs, or macOS x64.
- **You want agent memory that is not tied to one vault.** [basic-memory](https://github.com/basicmachines-co/basic-memory)
  keeps memory in its own portable markdown KB. Ours is deliberately *inside* the vault, so
  it inherits the vault's ACL and audit trail — a different trade, not a strictly better one.
- **You don't need MCP at all.** Obsidian URI or the Local REST API plugin can cover
  simple scripting directly.

Migrating the other way — replacing an existing Obsidian MCP setup with obsidian-tc —
is covered in [docs/CUTOVER.md](./docs/CUTOVER.md).

## Docs

- [docs/QUICKSTART.md](./docs/QUICKSTART.md) — install to first governed write in ~5 minutes
- [docs/WHY.md](./docs/WHY.md) — threat model, what governance means concretely, what obsidian-tc is not
- [docs/COHERENCE.md](./docs/COHERENCE.md) — writing while Obsidian is open: the coherence contract
- [docs/CUTOVER.md](./docs/CUTOVER.md) — migrating from another Obsidian MCP server
- [docs/MCP-COMPATIBILITY.md](./docs/MCP-COMPATIBILITY.md) — protocol-revision and capability compatibility matrix, evidence-backed
- [docs/EVALUATION.md](./docs/EVALUATION.md) — how retrieval changes are measured, the ship rule, and the results that failed it
- [Performance benchmarks](https://obsidian-tc.the40thieves.io/observability/performance-benchmarks/) — cold boot, indexing, retrieval and HTTP numbers recorded on a public CI runner behind a variance gate that refuses a noisy run
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the dispatch pipeline and package layout
- [SECURITY.md](./SECURITY.md) — threat model, protections, reporting

## Trademark

obsidian-tc is an independent, community-built open-source project. It is **not** affiliated with, endorsed by, or sponsored by Obsidian or its maker, Dynalist Inc. "Obsidian" is a trademark of Dynalist Inc.; it is used here only nominatively — to describe the application this MCP server interoperates with — including within the package, image, and plugin names (`obsidian-tc`), which denote compatibility, not origin or endorsement. For the official app, visit [obsidian.md](https://obsidian.md).

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only). See [LICENSE](./LICENSE). A commercial-exception license may also be available for use that cannot meet the AGPL's network-copyleft terms — open a [discussion](https://github.com/The-40-Thieves/obsidian-tc/discussions) to enquire. Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/); see [CONTRIBUTING.md](./CONTRIBUTING.md#license-and-sign-off-dco) for how to sign off your commits.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

For security issues, see [SECURITY.md](./SECURITY.md).
