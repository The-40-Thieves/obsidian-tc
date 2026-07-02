# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
- **Unicode-normalization-insensitive folder ACL (THE-272).** ACL glob matching and the default-deny check now normalize both the rule and the path to NFC before comparing, so a deny/whitelist rule authored in NFC still matches the same name stored on disk as NFD (notably on macOS) instead of silently failing to match. Residual path-hardening items remain open on THE-272 (hardlink / TOCTOU, which needs non-portable `openat`/`O_NOFOLLOW`, and case-folding, which cannot be applied blindly without breaking case-sensitive filesystems); the symlink canonicalization landed earlier in THE-269.
- **Relicensed from Apache-2.0 to AGPL-3.0-only (THE-260).** Reciprocity on network re-hosting: anyone may run, modify, and self-host, but offering a modified obsidian-tc to others over a network requires releasing the source under the same terms. Prior tags (through v1.2.1) remain available under Apache-2.0; AGPL applies from this commit forward. Every license declaration updated (the four LICENSE files, all `package.json`, `Cargo.toml`, `manifest.json`, the README badge, and the image OCI labels).

### Security

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
