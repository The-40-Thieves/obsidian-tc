# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Anticipatory context prefetch (THE-136).** New CLI command
  `obsidian-tc prefetch [path] [--vault id] [--ttl-hours N]` composes
  vault_context's session-bootstrap bundle per vault and writes a prewarm cache
  (`prewarm-<vault>.json` in the cache dir, atomic tmp+rename). Bootstrap mode
  now reads that cache — with the TTL **enforced at read time** and a
  signal-content hash so an edited `_next-session.md` invalidates immediately
  (the FlowState-QMD staleness bug, fixed and pinned by test) — and writes
  through on a live compose. A prefetch that packs nothing writes an empty
  marker, never a wrong bundle.
- **Proactive lesson surfacing in vault_context (THE-231).** The composite call
  now returns a `lessons` leg — decision/lesson/postmortem chunks relevant to
  the query (engine-ranked hits first, BM25 backfill over lesson-class paths) —
  and gains a session-bootstrap mode: omit `query` and the queued thread is
  read from the memory folder's `_next-session.md` signal note, so every
  session opens with its applicable past lessons (push, not pull). Composition
  only: packing and ranking are untouched.

## [1.6.0] - 2026-07-11

### Changed

- **`embeddings.chunkContext` now defaults ON (THE-408).** Contextual chunk enrichment measured
  +0.223 nDCG@10 (p=0.0001) and survived a 126-query re-test; with the divergence rebuild now
  enrichment-aware there is no remaining representation-skew hazard. **Upgrade note:** an existing
  index built with the flag off re-embeds in full on the first reconcile after upgrading (chunk
  content hashes cover the enriched text). Set `embeddings.chunkContext: false` to keep the old
  raw-text representation.

### Added

- **Conditional temporal retrieval stream, flag-gated (THE-221 Phase 1).** `temporal` on
  vault_graph_search's engine options: when the query carries an explicit temporal constraint
  (precision-first parser — prepositioned months/years, ISO dates, early/mid/late month, relative
  forms; bare title-style "May 2026" tokens never route), chunks of notes whose filename date
  falls in the parsed range join the fusion ranked by proximity to the range midpoint. Empty on
  non-temporal queries — exactly the static configuration. Eval gains `--temporal`. Off by
  default pending its A/B. (The ticket's date-augmentation item is already satisfied by THE-406
  enrichment: dated titles are in the embedded text.)
- **The experiential tier is live (THE-227 family — Phase 2 of the converged-engine plan).**
  A physically separate membrane store (`experiential.db`) now captures work-memory:
  - **Serve-path retrieval logging + the outcome axis (THE-230).** The search tools
    (`search_semantic`, `search_vault` semantic mode, `vault_graph_search`,
    `knowledge_challenge`) append retrieval events (chunk, rank, score, query text, surface,
    session) to `chunk_retrievals` — tool-layer only, so eval runs never pollute the log.
    Config `experiential.logRetrievals` (default on). A new `outcome` column (−1|0|+1,
    migration `20260711_001`) folds multiplicatively with relevance feedback in the ACT-R
    activation recompute (bounded weight ∈ [0.25, 4]).
  - **agent_episodes capture bus (THE-228).** A new registry `onEpisode` hook fires once per
    dispatch outcome (every dispatch, session or not); the bus appends append-only episodes
    (migration `20260711_002`) with self-carried caller/session attribution, a per-caller
    `prev_id` chain, and write-on controls stamped at birth (`eligibility='pending'`, blocked
    tombstone, bi-temporal validity). Action-axis capture (`experiential.captureEpisodes`)
    defaults on; the content axis (`experiential.captureContent`, secret-scanned + size-capped
    raw args) defaults off.
  - **Pre-ingest poisoning defense (THE-238).** A deterministic scanner (instruction-override
    markers incl. es/fr/de calques, persistence/preference-drift and delayed-trigger
    directives, hidden-text vectors — zero-width, bidi override, directive HTML comments,
    opaque blobs — and exfil shapes) runs in memory on every capture regardless of content
    persistence; high-risk content is born `ineligible` and never auto-raised. Per-channel
    trust contracts (dispatch 0.6 > ambient 0.3 > import 0.2; risk only lowers trust). The
    red-team acceptance harness ships in the test suite.
  - **M8 experiential tool domain (THE-229) — 4 new tools, 132 total.** `work_search`
    (memory retrieval with the reader contract enforced: eligible-only by default, tombstoned
    and expired rows never surface, per-agent caller partition, trust floor 0.3),
    `work_episodes` (inspection), `work_forget` (the tombstone as a first-party verb),
    `record_retrieval_feedback` (manual feedback/outcome stamping).
  - **Activation is measurable end-to-end (THE-187, THE-193).** The eval harness gains
    `--activation` and the serve path gains `experiential.activationRerank` (dark by default)
    — one bubble-pass mechanism on both paths, no eval/serve skew. Stale floor decided: clamp
    at 0.5 (time alone never demotes below never-retrieved; explicit negative feedback/outcome
    may). First live A/B at n=136: exact equivalence — ships dark per the ship rule.
  - **Citation inference (THE-170).** `obsidian-tc citation-infer <config> --transcript <file>
    (--session <id> | --since <ms> [--until <ms>])` — the two-stage gate (ROUGE-L +
    stored-embedding cosine, then the gateway judge role with a 5% parse-failure kill switch)
    stamps `cited_in_response`/`citation_score`. `session_id` is threaded into every
    retrieval-log call.
  - **Contribution report (THE-249).** `obsidian-tc contribution-report <config> [--since]
    [--until] [--json]` — per-note output-contribution credits over the citation signal, with
    top-contributor and dead-retrieved review lists.

### Fixed

- **chunk_fts divergence-rebuild is enrichment-aware (THE-408).** A wholesale rebuild (first
  FTS-capable open of an older index, or writes made without FTS5) previously reconstructed raw
  chunk text even under an enriched index, silently de-enriching the BM25 stream while the dense
  side stayed enriched. The indexer now threads `embeddings.chunkContext` into every
  `ensureChunkFts` call site and the rebuild reconstructs the enriched text from
  path + headings + content.
- **Tool-count headline drift healed.** All eight documentation surfaces and the coherence
  script's patterns now agree at 132 tools across 29 domains.

## [1.5.0] - 2026-07-11

### Changed

- **graph_rrf fusion constant k: 60 → 10 (THE-397), config-exposed as `retrieval.rrfK`.** With
  ~30-item stream pools, k=60 mathematically lets a document ranked ~30 in two streams outrank a
  rank-1 single-stream dense hit, burying confident results under overlapping noise. Measured on
  the n=32 golden set: k=10 is better-or-equal on all four gate metrics (nDCG@10 .444 vs .426,
  recall@10 .586 vs .569, MRR +.024, bridge recall equal), replicated on a second index.

### Added

- **Asymmetric embedding prefixes, config-driven (THE-405).** `embeddings.queryPrefix` /
  `embeddings.documentPrefix` (both default empty) apply at the provider factory: query-side
  embeds (`input: "query"`) get the query prefix, indexing gets the document prefix — the seam
  models like Qwen3-Embedding require (`Instruct: ...\nQuery: ` on queries, documents plain).
  Empty prefixes are the identity; nomic-style prefixes measured harmful on this vault, so
  nothing changes unless a config opts in.

- **Selective query-decomposition spike in the eval harness (THE-404).** `eval/run.ts --decompose`
  decomposes z-HARD queries only (z1 below `DECOMPOSE_Z`, default 2.54) into 2–3 atomic
  sub-queries via a small local instruct LLM (Ollama, `DECOMPOSE_MODEL`), runs the full graph
  search per sub-query, and RRF-merges the ranked lists — the routed (never blanket) form the
  2025–26 evidence supports for private corpora. Eval-only; no engine change.

- **Z-margin confidence signal (THE-400).** `seedZMargin` — the top-1 z-score over the dense
  seed-cosine pool — is the model-agnostic replacement for absolute cosine thresholds (which do
  not transfer across embedding models; the 0.55 rerank gate fired 0/32 on nomic). Opt-in uses:
  `router.zThreshold` (skip expansion on a confident dense lock) and `gatedRerank.hardZ` (rerank
  only z-hard queries). The eval logs per-query `z1` + a calibration quantile line and gains
  `--z-router <t>` / `GATED_HARD_Z`. Existing sim/margin + hardTop1 rules unchanged by default.

- **Convex-combination fusion mode, flag-gated (THE-398).** `fusionMode: "convex"` fuses per-query
  min-max-normalized RAW stream scores (dense cosine, expansion cos·decay, negated BM25, sparse
  dot) as `α·semantic + (1−α)·lexical` (α default 0.7) instead of rank-based RRF — preserving the
  dense model's confidence margins that RRF discards (Bruch et al., arXiv:2210.11934). Shares the
  graph_rrf diversification + gated-rerank pipeline; eval gains `--fusion convex` + `CONVEX_ALPHA`.
  Off by default pending its A/B vs RRF k=10.

- **Smooth expansion scoring, flag-gated (THE-401).** `smoothExpansion` replaces the graph
  stream's two hard discontinuities — the lexicographic hop-then-cosine order (any 1-hop beats
  every 2-hop) and the `hubDegreeCap` Heaviside drop (measured to cost bridge recall 0.7→0.4 at
  cap 40) — with one continuous score `cos · λ^(hop−1) · 1/(1+(deg/μ)^γ)` (defaults λ=0.8, μ=75,
  γ=6, tuned to this vault's bridge-vs-hub degree split). Composes with `graphStream` caps and
  Ebbinghaus decay; the similarity gate still uses raw cosine. Off by default pending its A/B.

- **Contextual chunk enrichment, flag-gated (THE-406).** `embeddings.chunkContext` embeds and
  BM25-indexes each chunk as `"{note title} — {heading breadcrumb}\n\n{content}"` instead of the
  bare section text. The chunker consumes heading lines into metadata, so a note whose evidence
  lives in its name or headings was invisible to BOTH retrieval streams (the golden-set failure
  taxonomy attributes ~49% of misses to promotion/representation, not recall). Display content is
  unchanged; the chunk content hash covers the enriched text, so flipping the flag re-embeds on
  the next reconcile. Default off pending its A/B gate.

- **Configurable `bge-m3` embeddings provider (THE-395).** `embeddings.provider: "bge-m3"` speaks
  an OpenAI-compatible vLLM base (`baseUrl`, default `http://127.0.0.1:8000/v1`): dense via
  `/embeddings`, plus the learned-sparse and ColBERT heads via the THE-388 encoder at index time
  (`chunk_sparse` / `chunk_colbert`), so a bge-m3 index carries all three representations. The
  retrieval eval gains `--sparse` to fuse the learned-sparse RRF stream query-side.

### Fixed

- **Embed batches no longer overrun a small provider context, and a rejected request no longer
  aborts the whole reindex (THE-390).** Ollama loads models at `n_ctx` 4096 by default and
  400-rejects any `/api/embed` request whose summed tokens exceed it; the chars/4 estimate
  undercounts real tokenization (~2-2.5x on link-dense markdown), so the previous 8192-estimated
  budget could overrun a 4096 context and halt the boot reconcile partway (`reconcile: degraded`,
  `HTTP 400`). `embeddings.maxBatchTokens` now defaults to 2048; a rejected (HTTP 400/413) batch
  is bisected and retried; a chunk rejected even as a single-text request quarantines its note —
  skipped this pass, surfaced via `notes_embed_failed` + degraded reconcile health, retried next
  reconcile — instead of aborting the reindex. Outage-class errors (timeout / 5xx) still abort.

## [1.4.0] - 2026-07-10

### Added

- **`session_bootstrap` tool (THE-101).** Server-side session bootstrap so any MCP client (Cursor,
  ChatGPT, Cline, Continue), not just skill-enabled Claude, can triage its opening message
  (lightweight | standard | deep) and preload the matching vault context notes through the headless
  FilesystemBackend. The routing table (deep-mode paths + a domain signal-to-path map) is supplied
  via the new `bootstrap` config block, never baked in; with none configured the tool degrades to
  lightweight. Read-only. Tool surface 122 to 123.

### Fixed

- **Local-Ollama indexing robustness (THE-386, GH #171 / #172).** The default local-Ollama embedding
  path could not index a real vault out of the box. Three fixes: (1) embed requests were aborted at a
  hardcoded 30s with no knob, so a slow local model presented as a hang — added `embeddings.timeoutMs`
  (default 120s), threaded through the provider adapters; (2) boot-reconcile failures were recorded
  only in in-memory index health, never stderr, presenting as a permanent silent stall — a degraded
  reconcile now emits a stderr warning per vault with a remediation hint; (3) a fixed 512-input embed
  batch could pack ~87k tokens into one request and crash a stock local runner (`/tokenize: EOF`) —
  batches are now capped by BOTH input count and estimated tokens (`embeddings.maxBatchTokens`,
  default 8192), and a single over-budget text still goes alone. `embeddings.batchSize` /
  `concurrency` / `maxBatchTokens` are all configurable.

## [1.3.6] - 2026-07-05

### Fixed

- **CLI no longer crashes at boot under GUI launchers (EPERM on `mkdir .obsidian-tc`).** The
  `cacheDir` default `.obsidian-tc` was relative, so the server tried to create it in the process
  CWD. GUI MCP launchers spawn with a non-writable CWD (Claude Desktop uses `C:\WINDOWS\system32`),
  so boot failed with `EPERM: mkdir 'C:\WINDOWS\system32\.obsidian-tc'`. A relative `cacheDir` is
  now anchored to the user's home (`~/.obsidian-tc`) — absolute and CWD-independent; explicit
  absolute `cacheDir` values are unchanged. `serve <vault>` now works from any launcher.

## [1.3.5] - 2026-07-05

### Security

- **Intermediate-directory symlink-swap TOCTOU closed (THE-272).** `read_note` / `write_note` now
  route through a native symlink-safe open — a per-component `openat(O_NOFOLLOW)` walk (Rust /
  `rustix`) that follows no symlink in any path component and operates on the resulting fd — so an
  attacker cannot redirect a read/write by swapping an ancestor directory for a symlink between the
  ACL check and the open. Active on all published platform prebuilds; the pure-JS fallback keeps the
  prior hard-link + final-component guards, and Windows uses the JS path (symlink creation is
  admin-gated there). Closes the last residual behind GHSA-c5xx.
- **`copy_note` overwrite is now gated + recoverable.** Overwriting an existing destination with
  `copy_note` (`overwrite: true`) previously clobbered it irreversibly with no confirmation floor; it
  now requires HITL confirmation and soft-deletes the destination into `.trash` first, matching
  `move_note`.

### Fixed

- **`obsidian-tc` CLI now runs from the npm bin on Windows.** The published `dist/cli.js` shipped
  without a `#!/usr/bin/env node` shebang, so npm's generated launcher shim handed the file to the
  Windows file association (Script Host) instead of node, and `obsidian-tc serve ...` silently
  no-opped (exit 0, no output) while `node .../dist/cli.js serve ...` worked. The build now prepends
  the shebang to the bin (POSIX exec bit set, sourcemap kept accurate) and install-smoke asserts it.
- **Multi-vault GraphRAG edge isolation (THE-310).** `vault_edges` now carries `vault_id`
  (migration 20260703_001): `reconcileVaultEdges` scopes its full-state SELECT/DELETE to the vault
  and `vault_graph_search`'s walk filters by `vault_id`, so reindexing one vault no longer deletes
  another vault's wikilink edges and expansion never crosses vaults. Single-vault deployments are
  unaffected; the edge cache rebuilds on the next `index_vault`.
- **Cohere query embeddings use the query encoding (THE-308).** The Cohere provider hardcoded
  `input_type: "search_document"` for every embedding, so user queries were encoded as documents and
  landed in a different subspace than the indexed vectors, degrading recall. `embed` now takes an
  `input: "query" | "document"` option; the two query sites pass `"query"` (→ `search_query`) while
  indexing keeps the document default. Cohere-only; other providers are unaffected.
- **`knowledge_challenge` gives the judge tags + open contradictions (THE-309).** Evidence is now
  enriched with note-level frontmatter tags — so a decision-tagged note outside the decision folders
  is recognized — and open contradictions touching the evidence paths are passed into the judge for
  cross-note conflict context; previously it sent path-only evidence and an empty contradiction list.

### Docs

- **Retrieval claims corrected to match the code (external claim audit).** Reworded the "hybrid BM25 +
  vector + RRF fusion" phrasing in README/ARCHITECTURE — there is no general lexical+vector RRF
  retriever; RRF fuses only GraphRAG's seed/expansion streams (THE-196) — and reconciled the docs-site
  roadmap/v2-preview, which still framed obsidian-tc as "an access MCP; pair with an external
  retrieval/RAG service", to the 2026-06-25 converged-engine decision. Documented the single-vault
  GraphRAG edge caveat (THE-233).

## [1.3.4] - 2026-07-03

### Changed

- **Docs reflect the shipped version + registered surface.** Swept the version prose (README status
  badge/line, docs-site current-release line + ghcr example tags) from 1.3.2 to 1.3.3 and the example
  tool-count output from 103 to 105. `release.mjs` now bumps the version prose on every cut and
  `check-version-coherence.mjs` fails if it drifts from the package version (recurrence fix). The
  GitHub wiki was refreshed to match.
- **npm package README refreshed.** `packages/server/README.md` — the README npm renders for the
  `obsidian-tc` package — carried a stale `Shipped — v1.0.2` status while shipping 1.3.x; it now
  tracks the shipped version and is covered by the version-prose gate + release auto-bump.

## [1.3.3] - 2026-07-03

### Security

- **Folder-ACL case-fold hardening (THE-272).** The `.obsidian` / `.git` / `.trash` default-deny now
  matches case-insensitively, so a case-variant control-directory path (e.g. `.Obsidian/…`) can no
  longer evade the deny on a case-insensitive filesystem. Path whitelists likewise match
  case-insensitively on case-insensitive filesystems (Windows/macOS) and stay case-sensitive on
  Linux. The intermediate-directory symlink-swap TOCTOU remains a documented residual (needs a
  native per-component `openat`; still tracked on THE-272).

### Changed

- **`elicitTtlSeconds` now governs HITL token TTL (THE-302).** The accepted config key is wired: the
  server sets the default elicit-token lifetime from config at startup instead of the hardcoded 300s;
  an explicit per-call `ttlSeconds` still overrides it.
- **`release.mjs` formats after the bump (THE-301).** The release script runs `bun run format` after
  writing the version files, so a release commit never carries biome drift.
- **Build hygiene (THE-278).** The root `package.json` pins `packageManager: bun@1.3.14` to match the
  CI toolchain.
- **Tool count corrected to 105 and pinned (THE-306).** The registered surface is 105, not 106 (a
  manual miscount in 1.3.2). A new `tool-count` test asserts the assembled registry length and
  `check-version-coherence.mjs` now fails if the documented headline drifts from it; the count is
  corrected across the README, ARCHITECTURE, and the docs site.
- **Companion plugin ships the complete 3-file set (THE-206).** The build now emits `styles.css`
  beside `main.js`/`manifest.json`, the release zip includes it, and the three files are attached to
  the GitHub Release as individual assets so BRAT can sideload the plugin (community-store
  submission readiness).

### Documentation

- **Accepted-residuals section + release runbook.** SECURITY.md gains a "Known limitations and
  accepted residuals" section documenting the `move_attachment` cross-ACL link rewrite (N-3,
  THE-303), the exp-only-token max-age contract (M-3, THE-304), and the intermediate-directory
  symlink-swap TOCTOU residual (THE-272). New `docs/RELEASING.md` captures the single-command +
  human-tag release flow and the community-store submission path (THE-256).

## [1.3.2] - 2026-07-03

### Security

- **Hard-link folder-ACL bypass closed (C-1b).** `enforcePathAcl` and the fd-based `readNote` /
  `readFileChecked` reject a regular file with `st_nlink > 1` in an ACL'd vault, so a hard link can
  no longer alias a file outside the caller's folder ACL (or past the `.obsidian` default-deny) into
  an allowed path — realpath canonicalization cannot dereference a hard link. Reads open an fd and
  fstat it, so the inode check and the read run on the same object.
- **Atomic-write temp-file symlink TOCTOU closed (H-4).** `writeNoteAtomic` opens its temp file
  `O_EXCL | O_NOFOLLOW` with a randomized name, so a symlink planted at a predictable temp path can
  no longer redirect an in-ACL note write into an arbitrary file.
- **`get_attachment` no longer reads arbitrary files (N-1).** It enforces the attachment extension
  allowlist (matching `list_attachments`), so `read:attachments` grants binary attachment reads, not
  read-any-file; notes are read via `read_note` under `read:notes`.
- **Elicit (HITL) tokens are caller-bound (H-3).** Redemption checks the issuing caller, so on a
  multi-caller HTTP deployment one caller cannot spend another's confirmation for the same vault + args.
- **Attachment reference lists are ACL-filtered (N-2).** `get_attachment(include_references)` and
  `delete_attachment` reveal only referencing notes the caller may read, closing a note-path
  enumeration channel.
- **`config show` redacts credential-header values (H-5).** `observability.otel.headers.Authorization`
  and `morgiana.httpHeaders.Cookie` (and similar) are masked by header name, not just key suffix.
- **`list_attachments` honors `strictReadDefault` (N-4).** Its read filter uses the shared
  `readableRel` predicate, which also applies the `.obsidian`/`.git`/`.trash` default-deny.
- **`/metrics` enforces the token max-age (M-3).** The Prometheus scrape verify threads
  `auth.tokenTtlSeconds`, so an over-age `iat`-bearing token can no longer scrape metrics
  indefinitely. The exp-only-token contract (max-age applies only to `iat`-bearing tokens) is
  unchanged and tracked separately.

### Changed

- **Companion plugin rejoins the repo version lockstep** (`scripts/release.mjs` +
  `scripts/check-version-coherence.mjs` now include it), and the tool count is corrected to 106
  across the docs, with the fd/inode path-safety + caller-bound elicit documented.

## [1.3.1] - 2026-07-03

### Fixed

- **Native platform sub-packages now publish with public access (packaging).** New scoped npm
  packages default to `restricted`, so the first publish of the new musl platform sub-packages
  hit `402 Payment Required`. The publish workflow now sets `publishConfig.access = "public"` on
  every generated platform package before `napi pre-publish`, and `packages/native` declares it
  too. (The `v1.3.0` tag's publish stopped at this step; `1.3.1` is the first fully published cut
  of this feature batch.)

## [1.3.0] - 2026-07-03

### Added

- **Tool-surface facade / progressive disclosure (THE-219 consolidation).** A new
  `transports`-independent `toolFacade.mode` (`triad` default, `domain` reserved, `flat` back-compat)
  reshapes what `tools/list` advertises WITHOUT removing any capability. In `triad` mode the server
  advertises three meta-tools instead of the full ~103: `find_capability` (BM25 search over the
  caller-visible catalog, reusing the in-process tokenizer/BM25, no new index), `describe_capability`
  (a single tool's schema + scopes + safety hints), and `call_capability` (routes the named target
  straight through `registry.dispatch`, so every scope/ACL/HITL/idempotency/throttle gate and the
  target's own Zod validation fire unchanged). Boundary-only: the ACL/Policy/HITL/idempotency/throttle
  pipeline and observability are untouched, and every tool remains callable by name. `flat` mode is the
  previous full-surface behavior. (Domain-verb facade + Claude-native deferred-tool discovery are follow-ups.)

- **Native `linux-x64-musl` + `linux-arm64-musl` prebuilds.** The publish matrix now builds eight triples (was six); Alpine/musl hosts load the compiled native addon instead of the pure-JS fallback. The hand-written loader detects musl vs glibc (`process.report.glibcVersionRuntime`, then `/usr/bin/ldd`) and requests the `-musl` triple. musl targets cross-compile via `napi build -x` (cargo-zigbuild + zig). The actual musl publish is validated on a release tag (the cross-build cannot run on non-linux/local dev).

### Changed

- **SQLite per-connection baseline + prepared-statement cache (THE-273).** Both runtime adapters now set `synchronous=NORMAL` (WAL-safe), `busy_timeout=5000` (wait instead of `SQLITE_BUSY` when the reindex, boot reconcile, and a live tool call contend for `cache.db`), a 32 MB page cache, `mmap_size`, and `temp_store=MEMORY`. The per-dispatch audit + idempotency statements are prepared once via a new `prepareCached` (bun:sqlite's `db.prepare` is uncached), removing a parse-per-call on the hottest path.
- **Distribution hardening (THE-276).** The packed `.mcpb` no longer ships local state / non-runtime files (`.claude/` including `settings.local.json` + `state/`, `.ruff_cache/`, `.gitleaks.toml`, `.gitattributes`, and the stray 26 KB `packages/native/false` left by `napi build --js false`). The server bundle is now built with `--minify --sourcemap=linked` (it was ~2.4 MB parsed on every stdio spawn), and the standalone `--compile` binaries add `--bytecode --minify --sourcemap` for faster cold start.
- **Batched embeddings on index / reconcile (THE-277).** `indexVault` now computes all of a batch's chunk plans first and embeds them together in provider-sized sub-batches under bounded concurrency, instead of one serial `embed()` round-trip per note. A cold/warm reconcile makes ~`ceil(chunks / 512)` requests with a few in flight rather than one per changed note; the write lock is still never held across a network call and the stored vectors are unchanged.
- **Parallelized the contradiction sweep (THE-277).** The post-index contradiction detector judged each (chunk, neighbor) pair with a serial `judge()` round-trip; it now windows the judge calls at 4 in flight (neighbor discovery and the DB inserts stay serial on the single connection), and a single pair's judge failure degrades to `no_conflict` instead of sinking the batch.
- **Domain-verb facade mode (THE-275).** `toolFacade.mode: "domain"` now advertises ~a dozen domain meta-tools (`notes`, `metadata`, `links`, `search`, `vault`, `attachments`, `structured`, `workspace`, `automation`, `knowledge`, `admin`) instead of the full ~100-tool surface or the triad. Each takes a shallow `{ action, args }` and routes the named action through the same `registry.dispatch` pipeline (every ACL / HITL / idempotency / throttle gate and the target's own schema validation fire unchanged). Boundary-only; every tool stays callable by name, and an unmapped tool still ships under an `other` domain rather than being hidden.
- **Unicode-normalization-insensitive folder ACL (THE-272).** ACL glob matching and the default-deny check now normalize both the rule and the path to NFC before comparing, so a deny/whitelist rule authored in NFC still matches the same name stored on disk as NFD (notably on macOS) instead of silently failing to match. Residual path-hardening items remain open on THE-272 (hardlink / TOCTOU, which needs non-portable `openat`/`O_NOFOLLOW`, and case-folding, which cannot be applied blindly without breaking case-sensitive filesystems); the symlink canonicalization landed earlier in THE-269.
- **Tool / capability schemas emitted as JSON Schema 2020-12 (THE-278).** `tools/list` (flat), the facade meta-tools (triad + domain), and `describe_capability` now emit input schemas in the **2020-12** dialect (the MCP `2025-11-25` default) instead of draft-7. The server already negotiates protocol `2025-11-25` via `@modelcontextprotocol/sdk@1.29.0` (`LATEST_PROTOCOL_VERSION`); this aligns the advertised schema dialect with the negotiated version. draft-7 remains spec-valid, so this is a forward-alignment with no client-visible breakage.
- **MCP 2025-11-25 tool-surface alignment (THE-278).** Three spec-aligned additions, all opt-in and non-breaking: (1) a dispatch failure now returns as a **Tool Execution Error** with a human-readable sentence plus the full error (including the Zod issues) as `structuredContent`, so a model can self-correct (SEP-1303), instead of an opaque JSON blob; (2) `ToolDefinition` gains an optional **`outputSchema`** advertised in `tools/list` + `describe_capability` (conformant clients then validate the `structuredContent` the server already emits); (3) optional **`icons`** metadata on tools (and prompts). Tools that declare neither `outputSchema` nor `icons` serialize byte-identically to before.
- **OAuth 2.0 Protected Resource Metadata + `WWW-Authenticate` challenge (THE-278).** When the operator sets `auth.resource` plus at least one `auth.authorizationServers` entry, the HTTP transport serves an RFC 9728 Protected Resource Metadata document at `/.well-known/oauth-protected-resource[/mcp]` and returns `WWW-Authenticate: Bearer resource_metadata=...` on a 401, so a spec-compliant MCP client can discover the authorization server (MCP 2025-11-25 resource-server role). Opt-in and non-secret; the HS256 token format is unchanged and the default config (no `resource`) serves nothing. The authorization-server half (token issuance, Dynamic Client Registration, OIDC discovery) remains out of scope until a real external AS exists.
- **Docs site reconciled with shipped reality (THE-278).** The documentation site was audited against the code and corrected: JSON-only config (not YAML) with real defaults (`http.port` 8765, `perMinute` throttle tiers + a `delete` tier, retention 90/90/30, `ollama` embeddings), Node 24+, the 8-triple native matrix, the `oven/bun:1-slim` Docker base, the `.mcpb` + minified-bundle artifacts, the `toolFacade` (triad default / domain / flat) surface with derived annotations + optional `outputSchema`/`icons` + JSON Schema 2020-12 (MCP 2025-11-25), the `delete` scope class/tier and corrected error codes (`forbidden` / `throttled` / `overflow`), and the optional RFC 9728 Protected Resource Metadata. Version references updated to v1.2.1.
- **Repo docs reconciled with reality (THE-278).** `ARCHITECTURE.md` now reflects the shipped MCP surface (`tools/list` emits `title` + derived annotations + optional `outputSchema`/`icons` as JSON Schema 2020-12; `resources` + `prompts` capabilities are advertised; auth is `none`|`jwt` with optional RFC 9728 Protected Resource Metadata, not an `oauth`/DCR mode), `CONTRIBUTING.md` corrects the native matrix to eight triples + the CI job list, and the README notes the default tool-surface facade.
- **Node falls back to built-in `node:sqlite`, making the one-click `.mcpb` self-contained (THE-276).** Under Node the server still prefers `better-sqlite3` (native, fastest) but falls back to the built-in `node:sqlite` when `better-sqlite3` cannot be resolved — notably inside the packed `.mcpb`, which ships no `node_modules`. The bundle is now installable and usable under Node 24+ on macOS, Windows, and Linux with no native dependency (`ci-install-smoke` proves the no-`better-sqlite3` boot on all three OSes); vector search uses the existing brute-force fallback when the sqlite-vec extension can't load. npm installs (which include `better-sqlite3`) are unchanged.
- **`linux-arm64` standalone binary + `.mcpb` attached to releases (THE-276).** The release now builds a `bun-linux-arm64` standalone binary, so the no-runtime binary covers macOS x64/arm64, Windows x64, and Linux x64/arm64, and it attaches the one-click `obsidian-tc.mcpb` bundle to the GitHub Release (self-contained under Node 24+ via the `node:sqlite` fallback). Windows-arm64, which is not a `bun --compile` target, is covered by the npm install. The install docs gain a per-platform method matrix.
- **DCO governance + dual-license note (THE-263).** Sign-off is now **required**: a new lightweight `dco` GitHub Action verifies every non-merge commit in a PR carries a `Signed-off-by` trailer (merge commits and existing history exempt). CONTRIBUTING and the README now state the project is AGPL-3.0-only with a commercial-exception license potentially available on request (no terms committed). Docs / CI only — no runtime or tool-surface change.
- **Multi-stage Docker image (THE-276).** The `Dockerfile` is now two stages on glibc `oven/bun:1-slim`: a builder that installs deps and builds shared + server, and a runtime stage that copies **only** `packages/server/dist` (no source, no `node_modules`). It runs under Bun (`bun:sqlite`), degrading the native module + sqlite-vec to pure-JS exactly as the previous image, for a smaller runtime layer. The `ci-docker` PR gate builds it and runs the `version` smoke.
- **Idempotency observability wired (THE-197).** The three idempotency Prometheus series are now live instead of registered-zero: `obsidian_tc_idempotency_hits_total` increments on a cache replay, `obsidian_tc_idempotency_cache_skipped_total` when a keyed result is dropped over the response-byte cap, and the `obsidian_tc_idempotency_cache_bytes` gauge reports the live per-vault cache size (`SUM(result_size)` over unexpired completed rows). Metrics only; no tool-surface or behavior change.
- **Terse search projection (THE-251).** The read/search hit tools (`search_text`, `search_regex`, `search_semantic`, `search_jsonlogic`, `search_vault`, `find_notes_by_property`) accept an opt-in `verbosity: "full" | "terse"` (default `full`). In `terse` mode each hit collapses to `path` plus `score`/`snippet` when present, dropping heavy per-hit fields (line/col, chunk id, chunk content, matched value) to cut agent prompt cost. Full mode is unchanged.
- **In-session tool-invocation tracing (THE-209).** When a workspace session is active, each tool dispatch now appends a `tool_invocation` record (`{ts, tool, caller, duration_ms, args_hash, result_size, status}`) to that session's JSONL trace, so `get_session_traces` reflects in-session activity without the external ambient worker. Wired via an opt-in `sessionTracer` on the dispatch registry plus a process-local active-session tracker (`start_session`/`end_session` maintain it; the stdio transport stamps `ctx.sessionId`). Best-effort — tracing never breaks a dispatch. No tool-surface change.
- **Templater expansion for periodic notes (THE-207).** `create_periodic_note` and `find_or_create_periodic_note` accept an opt-in `expand_template` (default `false`). When set, the configured or overridden template is expanded through the Templater bridge (which writes the note itself), gated on the `write:templater` scope; it degrades cleanly to a verbatim copy when the companion or Templater plugin is unavailable. Default behavior (verbatim copy) is unchanged.
- **Zero-copy `Float32Array` cosine on the native brute-force path (THE-266).** The native `cosine_similarity` now accepts the document vector as a zero-copy `Float32Array` (the query stays f64), widening each element f32->f64 in-loop so the result is bit-identical to the pure-JS fallback (guarded by a strict `===` parity test). `blobToFloats` returns the `Float32Array` view directly instead of copying into a `number[]`. Cold-path optimization (only the sqlite-vec-unavailable brute-force scan); the rebuilt prebuilds ship with the next native release cut.
- **`.mcpb` bundle no longer leaks non-runtime tracked files (THE-276).** The MCPB denylist now excludes tracked root config/tooling that is not part of the runtime bundle — `.gitleaks.toml` (the named leak), `biome.json`, `bun.lock`, `tsconfig.base.json`, `server.json`, `Dockerfile`, `.mcpbignore` itself — plus local-only `.claude/` and `.ruff_cache/`. The packed bundle now ships only `packages/server/dist`, `manifest.json`, `package.json`, `README.md`, and `LICENSE`.
- **Obsidian-fit fixes (THE-284).** `read_canvas`/`query_canvas` now surface spec-valid edge `fromEnd`/`toEnd` and group-node `background`/`backgroundStyle` (previously dropped from the read projection; the on-disk round-trip was already lossless). `query_base` now refuses a base written with the real Obsidian Bases expression DSL (a bare-string filter, an `and`/`or`/`not` of string statements, a top-level `filters`, or a string formula) with a typed `unsupported_base_filter` instead of silently matching all rows; obsidian-tc's own JSONLogic base model is unchanged (superseded in-cycle: the THE-281 subset evaluator now runs pure string-DSL filters/formulas; mixed trees still refuse). ARCHITECTURE.md's dependency chain now reflects that M1 CRUD, M2 search, and M3 format reads are filesystem-native (Obsidian / Local REST API / companion are Tier-3 only).
- **Uniform symlink-canonical ACL enforcement (THE-286).** `enforcePathAcl`'s vault-root argument is now mandatory, so every path-based tool gates on the realpath-resolved vault-relative path (THE-269) instead of silently falling back to a lexical check. This closes the residual symlink-scope bypass on the callsites that previously omitted the root: the Templater / Excalidraw / OCR / Dataview bridges, memory-entity materialization, and the search / index / canvas / attachment / tasks / bundle folder-scope checks. Behavior is unchanged for non-symlinked paths.
- **Semantic search no longer crowds out ACL-visible hits (THE-287).** The vec0 KNN path over-fetched a fixed `k*5+10` global candidates then filtered by vault + read-ACL in JS, so a query whose top candidates were all in denied folders (or, under a shared cache.db, another vault) could return zero hits despite relevant visible matches — a functional DoS and a weak existence side-channel. The vault filter now runs in SQL, the over-fetch is widened, and when the top candidates cannot fill `k` visible hits the query falls back to the exhaustive (already ACL-correct) brute-force scan. Same results in the common case; correct results under crowding.
- **Config keys `transports.stdio` + `throttle.enabled` are now honored (THE-288).** Both were accepted by the schema but silently ignored: the stdio transport always connected and the dispatch rate-limiter always enforced regardless of the flags. `transports.stdio: false` now skips the stdio transport (the server serves HTTP-only, or exits with a clear message when neither transport is enabled), and `throttle.enabled: false` runs the dispatch gate with no limiter (the `RateLimiter` object still backs `get_metrics`, just unenforced). A non-typed handler exception (a server bug, previously swallowed into an opaque `{code:"internal"}` with the stack discarded) now also reaches an operator-side `onInternalError` sink that writes the real error + stack to stderr for diagnosis — the client response stays the redacted `internal`, and stdout (the MCP channel) is untouched.
- **`server_health` surfaces search-index degradation (THE-288).** Boot-reconcile failures and index-on-write failures were swallowed (`.catch(() => {})`), so the server reported healthy while its search index silently drifted. `server_health` now includes an `index` block: `reconcile` (`pending` / `ok` / `degraded`), `reconcile_at`, and a `write_failures` count (all non-identifying, always present); authenticated callers additionally get per-vault reconcile errors + the last write-error message (path-bearing `detail` is withheld from the unauthenticated liveness probe).
- **Documented the companion trust boundary (THE-289).** SECURITY.md and the companion plugin README now state explicitly that possession of the Local REST API bearer key is equivalent to full vault admin: the companion extends LRA's HTTP server and LRA's own endpoints already grant full read/write/delete, so the companion routes add no new authority and deliberately do not re-implement the server's ACL/HITL/command-allowlist gates (which protect the MCP surface, not direct LRA calls). Docs only.
- **Memoized per-request schema + capability-search work (THE-294, partial).** `tools/list`, `describe_capability`, and the triad meta-tools recomputed `z.toJSONSchema` over static schemas on every request, and `find_capability` re-tokenized the whole tool catalog per query. Both are now memoized by schema / tool-definition identity (the triad meta-tool schemas were hoisted to module constants so the cache hits), so each distinct schema is converted at most once and each tool's description is tokenized at most once. Pure internal caching — the advertised surface is byte-identical. (The remaining THE-294 items — caching the assembled HTTP server across requests, and dropping the dispatch/transport double-serialization — are deferred; both touch a per-request-context or shared-result contract and warrant their own change.)
- **Compare-and-swap for JSON-config edits (THE-292).** `add_bookmark`, `remove_bookmark`, `open_workspace`, and `save_workspace` now accept an optional `prev_hash` (like note writes): the edit is rejected with `concurrent_modification` when `.obsidian/bookmarks.json` / `workspaces.json` changed since that hash, closing a lost-update window versus a concurrent agent or the Obsidian GUI. Omitting `prev_hash` preserves the previous last-write-wins behavior. (THE-292's indexer-transaction item was already satisfied — `indexNote` / `indexVault` wrap their applies in BEGIN/COMMIT/ROLLBACK; the periodic cache.db maintenance sweep remains a follow-up.)
- **Compute-abuse budgets (THE-293).** (1) `search_regex` / `search_vault(mode:regex)` now enforce a TRUE regex-execution timeout: the scan runs in a lazily-spawned worker thread and only worker time counts against the budget (`governor.regexTimeoutMs`, default 2000 ms), so a catastrophic-backtracking pattern that slips the nested-quantifier heuristic is terminated with a new non-retryable `compute_budget_exceeded` error instead of hanging the event loop. A runtime that cannot run the eval worker (readiness handshake) falls back to the prior inline scan. (2) JSONLogic evaluation carries a 10k op budget counted on EVERY node — literals and wide flat argument lists included — so `search_jsonlogic` and `query_base` view filters reject pathological width with `jsonlogic_error` instead of burning CPU (the depth cap only bounded nesting). (3) The idempotency in-flight reclaim window is now configurable (`idempotencyReclaimSeconds`, default 60): a legitimately slow keyed bulk op can be given a longer window so a concurrent duplicate cannot false-reclaim its in-flight row and double-execute.
- **Dev-dependency audit freshen (THE-299).** `bun audit` reported 4 advisories (1 high) against stale lockfile resolutions — `vite@5.4.21` (fs.deny bypass on Windows, optimized-deps `.map` path traversal, launch-editor NTLMv2 hash disclosure) and its transitive `esbuild@0.21.5` (dev-server cross-origin read). vitest's declared range already admits vite 7; a root `overrides` entry now pins `vite` to `^7.0.0` so the lockfile re-resolves onto the patched line (bringing esbuild ≥0.25 with it). `bun audit` is clean. Dev/build-time only — no runtime dependency changed.
- **Index-on-write now covers every M1 note mutation (THE-291, part 1).** `add_tag`, `remove_tag`, `update_frontmatter`, `rewrite_link`, `prune_hub_links`, `move_note`, and `copy_note` wrote notes to disk WITHOUT firing the index-on-write seam (only `write_note`/`append_note`/`patch_note`/`delete_note` did), so the semantic-search index silently went stale on those writes until the next boot reconcile — a read-your-writes gap. All seven now reindex the written content (moves also deindex the source path and reindex every backlink-rewritten note). The m3 periodic / m4 tasks / m5 capture / m6 bulk writers get the same treatment in part 2 (their deps interfaces need threading).
- **Dropped one payload serialization per tool call (THE-294).** The dispatch pipeline stringified every successful result for the byte governor and the transport formatter stringified the same object again. The governor's string is now memoized by result-object identity (take-and-delete WeakMap) and consumed by the formatter — removing the formatter's pass (the JSON-RPC envelope still serializes `structuredContent`, so this is one of three passes, not a halving). Idempotency replays reuse the cached blob string the same way. Wire bytes are identical. The remaining THE-294 item — caching the assembled HTTP `Server` across requests — is closed as wontfix: the MCP SDK enforces one transport per `Protocol` instance (`connect` throws on a second transport), the stateless Streamable-HTTP mode needs concurrent per-request transports, each `Server` captures the per-request auth context, and the formerly-expensive per-request work (schema conversion) is already memoized module-level.
- **Periodic cache.db maintenance sweep (THE-292).** Expiry was lazy-only — expired `idempotency_keys` / `elicit_tokens` rows were rejected on read but never purged, and the `event_log` retention config (`observability.retention.eventLogDays`, default 30) had no enforcement — so cache.db grew without bound. An hourly (configurable via the new fully-defaulted `maintenance` block: `enabled` default true, `intervalMinutes` default 60) unref'd sweep now DELETEs expired rows, trims `event_log` to retention, and runs `PRAGMA optimize`; each run emits a `tc.maintenance.sweep` MORGIANA event (new additive event type with a `rows_dropped` per-table breakdown) and a `sweep_run` event_log row. The sweep is deliberately expired-only for idempotency rows — crashed in-flight reclaim stays on the dispatch path (`idempotencyReclaimSeconds`, THE-293) where a fresh claim cannot be cross-attached to a stale completion. No automatic VACUUM. External MORGIANA consumers pinned to an older shared schema must tolerate the new event type before consuming a server that emits it.
- **Index-on-write coverage extended to the m3–m6 writers (THE-291, part 2).** `create_periodic_note` / `find_or_create_periodic_note` / `append_periodic_note`, `update_task`, the m5 capture commit, `bulk_create_notes`, `bulk_set_property`, and `bulk_move_notes` (moves deindex the source and index the destination) now fire the same best-effort index-on-write hooks as the M1 tools, completing the part-1 sweep. Residuals documented on the ticket: `bulk_move_notes` backlink rewrites and Templater-expanded periodic notes (written by the companion, not the server) still rely on the boot reconcile.
- **Notes metadata table + FTS5 substrate (THE-291, part 3A).** cache.db gains a versioned `notes` table (per-note title / tags / frontmatter / content-hash / stat metadata) and a runtime-provisioned `notes_fts` FTS5 virtual table (trigram tokenizer — candidate generation stays a superset of substring matching), populated on the index-on-write path and the boot reconcile in the same transactions as the chunk store. Design per the adversarial review: the FTS copy derives from the RAW note (secret-flagged chunk contents excised) so heading lines and hard-split boundaries cannot create silent false negatives; the notes/FTS pass flushes independently of the embed pass and reports `notes_ready` in `server_health` (a broken embedding backend no longer blocks metadata readiness); the stale-path sweep runs only on unscoped reconciles and diffs against the unfiltered walk; a sync detector reconverges `notes`/`notes_fts` after sessions written without FTS5. Deletes/moves clear metadata via a new one-transaction `deindexNote`. `server_health` reports `fts_enabled`; `index_vault` stats gain `fts_enabled`/`notes_upserted`/`notes_deleted`. The query layer (accelerated `search_text`, DB-backed `list_tags`/`list_properties`/`find_notes_by_*`) lands as part 3B on this substrate.
- **`search_text` is FTS5-accelerated (THE-291, part 3B).** When the notes/FTS pass is ready, `search_text` and `search_vault(mode:text)` generate trigram BM25 candidates from `notes_fts` and read ONLY the candidate files for the exact line/col verify — instead of `readFileSync`-ing every note in the vault per query. The disk scan remains the automatic fallback for sub-trigram queries (<3 chars), candidate-cap overflow, FTS-less adapters, and pre-reconcile boots, so behavior floor and hit shape are unchanged; scores become FTS bm25 values (never contractual). ACL filtering stays query-time on the caller's readable set.
- **Metadata tools read the notes table (THE-291, part 3B-ii).** `list_tags`, `find_notes_by_tag`, `list_properties`, and `find_notes_by_property` walked the vault and `readFileSync`'d every `.md` per call; once the boot reconcile's notes pass commits they aggregate from the `notes` table instead (ACL + folder filtering stay query-time; `tagMatches`/`typeOf`/`valueMatches` semantics reused verbatim in JS). The disk scan remains the automatic fallback pre-reconcile and in harnesses without the index. Two documented drifts: the `max_notes`/`limit` caps now apply in `ORDER BY path` order (the disk path used directory-walk order), and YAML-native dates surface as ISO strings via the JSON round-trip (matching the wire format).
- **Obsidian Bases expression DSL subset evaluator (THE-281).** `query_base` now EVALUATES bases written in the real Obsidian Bases expression language instead of refusing them (THE-284's honesty guard): a documented subset covering literals/lists, `file.*` (`name`/`path`/`folder`/`ext`/`tags`/`links`, `hasTag`/`inFolder`/`hasLink`), `note.<prop>` + bare-identifier shorthand, `formula.<name>`, the standard operators with `&&`/`||` short-circuit, string/list methods (`contains`/`startsWith`/`endsWith`/`isEmpty`/`lower`/`upper`/`trim`/`length`/`join`), globals (`if`/`date`/`now`/`today`/`min`/`max`/`list`/`number`), date±duration arithmetic, and `and`/`or`/`not` filter combinators. A pure-string top-level `filters` now selects the note set (real Bases has no `source` block). The honesty contract is unchanged where it matters: constructs OUTSIDE the subset (lambdas, bracket access, unknown methods/functions), trees MIXING DSL strings with JSONLogic objects, and unparseable string formulas all refuse with the typed `unsupported_base_filter` — never a silent match-all or a silent null column. obsidian-tc's own JSONLogic base model is untouched.
- **Bases model realigned to shipped Obsidian 1.12 syntax, additive-with-deprecation (THE-280).** `query_base` now HONORS the real per-view keys it previously round-tripped but ignored: `order` (namespaced `file.*`/`note.*`/`formula.*` ids project the columns when the deprecated `columns` alias is absent — `columns` wins in v1.x for back-compat), `sort` (strings or `{property, direction}` multi-key, stable), `limit` (caps the result set), and `groupBy` (or the deprecated `group` alias — rows gain an additive `group` key and group-major ordering). The document model declares the real top-level `filters` (the note set — real Bases has NO `source` block) and `properties`; `update_base` can now patch `filters`/`properties` (applied, not silently accepted), with `filters` HITL-gated exactly like the deprecated `source` alias; `create_base` surfaces `deprecations` notes when the obsidian-tc aliases (`source`, per-view `columns`/`group`) are used — all three are scheduled for removal at v2.0. Behavior note: a base that carried real Bases keys was previously queried as if they were absent; those keys now take effect (e.g. a stored `limit: 2` caps rows).
- **Companion installable-product hardening (THE-282).** (1) A server↔companion API-version floor: the companion's `/probe` already reports `obsidianTcApiVersion`; the server now compares it against `EXPECTED_COMPANION_API` and an incompatible companion degrades EVERY bridge tool with a new non-retryable `plugin_incompatible` error (+ update hint) instead of silently diverging — the companion's independent version cadence (deliberately excluded from version coherence) is unaffected. (2) `packages/plugin/versions.json` (version → `minAppVersion`, community-store requirement) now exists and is asserted by `check-version-coherence.mjs`; the plugin README documents that store submission needs the file at a plugin-repo ROOT. (3) The companion runs a startup shape self-check over the Obsidian internals it duck-types (`app.commands.listCommands`, `app.plugins.plugins`) — drift produces one `console.warn` and is surfaced on `/probe` as `shape_ok`/`shape_warnings`. (4) The README gains a reviewer-facing private-API inventory.
- **Live-Obsidian write coherence contract documented (THE-283).** A new `docs/COHERENCE.md` states the sole-agent-writer invariant (obsidian-tc's CAS gates are the defense against the remaining human-writer concurrency), the honest limits of Obsidian's external-change watcher (an open pane may not refresh until navigated; detection degrades on OneDrive/network drives), and the Windows rename-over-open-file semantics of the atomic temp+rename write (`MOVEFILE_REPLACE_EXISTING`; Obsidian holds no persistent note handles, so the residual risk is a transient `EPERM` surfaced as a visible write error, not silent loss). The opt-in companion refresh nudge is designed but deferred (private-API + needs a live app to verify).
- **Per-vault ACL (THE-295).** Each `vaults[]` entry may now carry its own `acl` block (same shape as the root `acl`: `readOnly`, read/write/delete glob whitelists, rules, `strictReadDefault`); the root ACL remains the inherited default, so existing configs are unchanged. Enforcement happens at dispatch: once the input names a vault (after the THE-267 vault-binding guard), the read-only kill switch and every handler-side `enforcePathAcl` run under that vault's ACL — "agent may write vault A but only read vault B" now works in ONE process. The advertised tool surface (per-caller `tools/list` filtering) deliberately keeps the caller's default ACL; enforcement is per-vault at dispatch.
- **SleepTime plane scheduler wired (THE-296).** The consolidation plane's synthesis + audit jobs existed and were tested but were never invoked from the server — two of three consolidation paths were dead runtime code. A new fully-defaulted `plane` config block (`enabled` default true, `intervalMinutes` default 240) starts an unref'd scheduler that runs every registered job, gated on the inference gateway being configured (the jobs degrade without it, but scheduling them then is pure DB churn). The README's retrieval-intelligence framing is de-scoped to match reality: machinery present and now scheduled; the GraphRAG ship-gate eval (recall@10) still needs an out-of-band run against a live embedding backend.
- **Asymmetric JWT verification — RS256/ES256/EdDSA + JWKS + kid rotation (THE-297).** `auth` gains optional `jwks` (inline JWKS document), `jwksFile` (loaded once at transport boot — file/inline only, deliberately no URL fetch), and `algorithms` (asymmetric allowlist, default RS256/ES256/EdDSA). The token's protected header routes verification: HS256 goes ONLY to the shared secret, asymmetric algs ONLY to the JWKS — the classic alg-confusion attack (public key as HMAC secret) is structurally impossible. Key rotation is `kid`-based inside the JWKS (publish old + new together). HS256-only deployments are byte-for-byte unchanged; `auth.mode: "jwt"` now accepts a JWKS in place of `jwtSecret`.
- **Sole-interface cutover guide (THE-279).** `docs/CUTOVER.md` documents replacing the LRA-MCP surface, mcp-tools, and obsidian-headless with obsidian-tc as the single agent interface: a verified capability map (every cited obsidian-tc tool grep-checked against the tool tree; UI-coupled gaps stated honestly — no active-file tools exist, `generate_uri` builds but never launches URIs), step-by-step cutover (install → per-vault ACL config → companion install via `obsidian-tc plugin install` → `server_health` verification → repoint Claude → retire the old plugins, keeping LRA only as the companion transport), config-only rollback, and the Sync story (obsidian-tc is filesystem-native and does not replace Obsidian Sync).
- **Docs, legibility + metadata polish (THE-299).** The README is reframed to lead with the actual problem (agents can wreck or leak a vault → governed access) and the triad facade as the headline UX (3 advertised tools, ~103 governed capabilities); absolutist claims are softened to dated/bounded phrasing; the competitor table's cyanheads row is corrected to its current shipped surface (~14 tools, folder-scoped paths, read-only, HITL, JWT/OAuth, 2025-11-25 pagination); the native module is honestly framed (cosine is the native win; tokenize/BM25 are the fallback scorer — the primary lexical rank is FTS5 `bm25()`); and a "when NOT to use obsidian-tc" section names honest alternatives. New `docs/QUICKSTART.md` (5-minute path) and `docs/WHY.md` (threat model + what governance means concretely). SECURITY.md gains a prompt-injection / hostile-vault-content section (mechanical ACL ≠ semantic obedience; retrieved content is untrusted; deny by ACL, not prompt). Metadata: `server.json`'s meaningless localhost `remotes` block is removed; the stale "domain is reserved" facade comment now reflects the shipped mode; the publish workflow gains CycloneDX SBOM artifacts (non-blocking with explicit warnings) beside the npm provenance attestations. The dev-dep audit freshen landed earlier (#113).
- **ARCHITECTURE.md truth pass (THE-298).** The 56KB architecture document no longer states superseded design as current: the Python ML sidecar (former component 14) and its IPC contract are DELETED (no sidecar code, config, or helper exists in the tree), the storage section documents the SHIPPED shared cache.db with logical vault_id isolation — including the exact table-by-table truth (which tables carry vault_id, that chunk_embeddings/vec_chunks are chunk-keyed with the THE-287 SQL-side vault scoping, and that vault_edges has no vault_id yet) — per the locked decision, with per-vault DB files documented as the planned V2 storage rewrite, and every stale site the adversarial review enumerated is fixed (per-vault-isolation bullets, HITL policy location, the companion probe apiVersion behavior now matching THE-282 reality, Docker entrypoint flags, component counts, dependency-chain rows). The auth, search, scheduler, and config sections are reconciled to everything shipped this cycle (THE-286..297).
- **Relicensed from Apache-2.0 to AGPL-3.0-only (THE-260).** Reciprocity on network re-hosting: anyone may run, modify, and self-host, but offering a modified obsidian-tc to others over a network requires releasing the source under the same terms. Prior tags (through v1.2.1) remain available under Apache-2.0; AGPL applies from this commit forward. Every license declaration updated (the four LICENSE files, all `package.json`, `Cargo.toml`, `manifest.json`, the README badge, and the image OCI labels).

### Security

- **`execute_template` honors `overwrite` — no more silent clobber (THE-289).** The Templater bridge tool forwarded `overwrite` but neither the server tool nor the companion `/templater/execute` route checked whether the target existed, so `create_new_note_from_template` (which writes `<target>.md`) could overwrite or duplicate an existing note with no confirmation. The server now refuses with `note_exists` when the resolved `<target>.md` already exists and `overwrite` is false (authoritative, independent of the companion version), and the companion route enforces the same as defense-in-depth. `overwrite: true` is unchanged.
- **HTTP tokens are now bound to a single vault (THE-267).** A bearer token may carry a `vault` claim; the HTTP edge binds the caller to that vault (or the server's default vault when the claim is absent), and `registry.dispatch` rejects any tool call whose `vault` argument names a different vault with `forbidden` — the same invariant `resources/read` already enforced. Previously any valid token could read, write, or delete every configured vault by passing its id, because the JWT carried no vault claim and the folder ACL is a single global instance. The trusted stdio transport is unaffected and retains full multi-vault access. Multi-vault HTTP deployments must now mint one token per vault (add a `vault` claim); a claimless token is confined to the server's default vault.
- **Fail-closed ACL defaults (THE-268).** The folder ACL now hard-denies `.obsidian/**`, `.git/**`, and `.trash/**` for read, write, and delete regardless of the allowlist (the two config files the bookmark/workspace tools use are exempted), so `read_note('.obsidian/plugins/*/data.json')` no longer leaks plugin API keys or Obsidian Sync passwords. `strictReadDefault` is now honored on the request path (`read_note` et al.), not just bridge enumeration, and was added to the config schema so setting it takes effect (it was previously stripped by validation). An undefined read/write whitelist otherwise remains allow-all by default (M0 back-compat).
- **DNS-rebinding / cross-origin protection on the HTTP transport (THE-271).** The Streamable-HTTP edge now rejects (403) a request whose `Host` is neither loopback nor operator-allowed, or whose `Origin` (browsers always send one; server-to-server MCP clients do not) is not the request's same origin or operator-allowed. Previously a malicious web page could POST to `http://127.0.0.1:<port>/mcp` and, under the `auth.mode:'none'` loopback default, receive full wildcard scopes. Configurable via `transports.http.enableDnsRebindingProtection` (default true), `allowedHosts`, and `allowedOrigins`.
- **Bridge tools fail closed under a read whitelist (THE-270).** `tasks_filter` no longer spreads its bridge `...result` (whose `groups` aggregate is computed over the UNFILTERED task set and leaked counts of notes outside the whitelist); `makemd_query` likewise drops its unfiltered `...result` siblings; both return only the ACL-filtered `items`. `list_templates` (template paths + parsed user-function bodies, plugin-defined and not reliably path-attributable) now refuses wholesale under a read whitelist, matching the `search_dql` fail-closed contract. No change when no read whitelist is configured.
- **Folder ACL checks are canonicalized through symlinks (THE-269).** The folder ACL matched the lexical request path while the filesystem followed in-vault symlinks, so a symlink under an allowed folder pointing at a denied (but in-vault) folder passed the ACL. `resolveVaultPath` now also exposes the real (symlink-resolved) vault-relative path, and every request-path `enforcePathAcl` call threads the vault root so the ACL gates the canonical path. Vault-root escape was already blocked; this closes the intra-vault read/write ACL-scope bypass. No effect on non-symlinked paths.

## [1.2.1] - 2026-06-26

Post-1.0.2 work, now versioned. Two strands landed on `main` after 1.0.2: a
security-audit remediation pass plus a dependency-currency sweep, and the
agent-ergonomics + distribution feature set merged 2026-06-26. `package.json` had
been bumped to 1.2.1 by the programmatic version path while this changelog,
`server.json`, and `manifest.json` lagged at 1.0.2; 1.2.1 is the first coherent cut
across all four. (1.1.0 and 1.2.0 were skipped by the bump path; release coherence is
tracked by THE-256.)

### Added

- **Tool-visibility scoping (THE-219):** config-driven `allowed` / `hidden` /
  `disabled` / `disabledTags` / `hiddenTags` / `requireReadOnly` filtering at the
  `tools/list` chokepoint, with `requireReadOnly` derived from existing mutation
  scopes. One build can serve a lean per-deployment surface without consolidating the
  tool set.
- **Per-caller tool-visibility filtering (THE-250):** the visibility layer also drops
  tools the authenticated caller lacks scopes for, composing with the static config
  rather than duplicating verdict logic.
- **Headless VaultBackend, lean v1 (THE-255):** a single filesystem `VaultBackend`
  (read / write / delete / exists / list / walk) serving reads and writes in both live
  and headless modes; `resolveMode` (probe-once, per vault) and `assertLive` returning a
  typed `requires_live_obsidian` for action-firing tools when Obsidian is closed.
- **Distribution artifacts (THE-220):** `server.json` (MCP registry,
  `io.github.The-40-Thieves/obsidian-tc`), `manifest.json` (MCPB 0.3), `.mcpbignore`, and
  `scripts/bundle-mcpb.ts` for one-click `.mcpb` install, plus Cursor / VS Code deeplinks
  in the README.

### Security

- **Read-ACL bypass closed:** `search_dql` / `search_vault(mode:dql)` returned whole-vault
  Dataview rows with no read-ACL intersection; now refused under a read whitelist
  (fail-closed), mirroring the other bridge tools.
- **ReDoS guard hardened:** the regex guard now also rejects a quantifier applied to an
  alternation (e.g. `(a|a)+`), closing the previous bypass.
- **Delete-class tools are now rate-limited** (a `delete` throttle tier was missing).
- **Internal errors no longer leak the absolute vault path** to MCP callers.

### Fixed

- **Frontmatter fidelity:** writes preserve untouched YAML keys byte-for-byte, so
  leading/trailing-zero values (zip codes, ISBNs, semver) survive any write, including
  body-only `patch_note` edits.
- **`bulk_move_notes`:** in-batch destination collisions and chained moves are rejected
  instead of silently clobbering/losing content.
- Tokenizer parity (Rust `is_alphanumeric` vs JS `\p{Alphabetic}`), `reset_vault_cache`
  drops orphaned sqlite-vec vectors, a corrupt idempotency cache self-heals, jsonlogic
  has a depth cap, and embedding vectors are finite-checked.

### Changed

- **Dependency-currency sweep:** Zod 3 → **4** (dropped the deprecated `zod-to-json-schema`
  for native `z.toJSONSchema`), Biome 1.9 → **2.5**, napi-rs 2 → **3**, better-sqlite3 11 → **12**,
  @types/node 22 → **24**, esbuild 0.24 → **0.25**.
- **Standardized on Node 24 LTS:** `engines.node >=24` and CI on Node 24 across the board.

## [1.0.2] - 2026-06-21

Security patch. Closes the unauthenticated-bind exposure present in 1.0.1 and
rolls up the post-1.0.1 rate-limiter and housekeeping work already on `main`.

### Security

- **F2: the HTTP transport now refuses to bind a non-loopback host when
  `auth.mode` is `none`.** Enforced fail-closed at config load with no insecure
  override; loopback detection is centralized in a shared `net-host` helper with
  strict IPv4 octet validation and bracket-normalized IPv6 binding. 1.0.1 could
  serve an unauthenticated vault on a non-loopback address. (THE-113 audit, F2.)

### Fixed

- **F1: the native build no longer clobbers its prebuild output directory.**
- **F4 / F8 and audit hygiene** from the THE-113 end-to-end audit; the committed
  audit report is removed from the tree.
- Rate limiter: single deletes tier at the `delete` scope class (THE-212) and
  idle buckets are reclaimed (THE-213).

### Changed

- Docs reconciled to the access-only V2 framing and freshened post-1.0.1;
  tool-surface count corrected to 103 across 28 domains (THE-217).

### CI

- Pure-JS native fallback test job (THE-216) and a decoupled `release-image`
  workflow for GHCR-only image re-releases.

## [1.0.1] - 2026-06-19

First public release: a comprehensive, model-agnostic, agent-ready Obsidian MCP server —
the full v1.0 tool surface (G2.1 Domains 1–28, 103 tools) plus the M7 hardening gate.

### Added

- **Tool surface (Domains 1–28)** — notes / metadata / links, search + embeddings, structured
  formats (bases, canvas, periodic), plugin-bridge tools, memory + capture, bulk operations,
  URI generation, and the server-admin surface.
- **Observability (G2.4)** — OpenTelemetry traces (conditional; a no-op until an OTLP endpoint
  is configured), the Prometheus catalog (8 counters / 2 histograms / 4 gauges) exposed via an
  optional `/metrics` scrape endpoint, and a MORGIANA CloudEvents 1.0 JSONL spool (9 event
  types). All export streams fail soft and never block tool execution.
- **Dispatch-wide rate limiting (THE-210)** — a deterministic token-bucket policy gate across
  every scope class (read / write / bulk / execute / admin) with the G2.4 tiered defaults.
- **Security model (G2.4)** — HS256 JWT auth, scope + folder ACLs, HITL elicitation with
  hardcoded floors, a shared response-byte governor, and a localhost-only-by-default posture.
- **Native module** — napi-rs vector / BM25 primitives with a pure-JS fallback. v1.0 ships
  prebuilds for 4 platforms (linux-x64-gnu, darwin-x64, darwin-arm64, win32-x64-msvc).
- **Distribution** — a tag-triggered release workflow (npm with `--provenance`, standalone Bun
  binaries, plugin zip, multi-arch Docker image), Apache-2.0 licensed, with an Astro Starlight
  documentation site.

### Deferred to v1.1

- `linux-arm64` native prebuilds (the pure-JS fallback covers arm64-linux), cosign binary
  signing, and CycloneDX SBOM generation.
- The richer `obsidian-tc serve / init / auth / …` subcommand CLI (G2.5 §5); v1.0 ships a
  config-path launcher.

[1.0.0]: https://github.com/The-40-Thieves/obsidian-tc/releases/tag/v1.0.0
