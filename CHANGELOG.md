# Changelog

All notable changes to obsidian-tc are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the spirit of
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Catalog discovery on the triad facade (#884, THE-937; issue #877).** `find_capability` is query-only — it answers "which tool does X" but not "what exists", and an external report measured 97 of 163 tools never called in one deployment against 79% of calls spent on `resources/list`/`prompts/list` chatter. Two additions close the enumeration gap without a fourth meta-tool or changing what `tools/list` advertises: `instructions` (both legacy `initialize` and `server/discover` under MCP 2026-07-28) now carries a 13-domain category summary — one line per domain plus its three or four most-used tool names from a static allowlist, capped under 500 tokens (~2,000 chars) — and a new resource, `obsidian-tc://catalog`, returns the full caller-visible catalog as `{domain, name, summary}` JSON grouped by domain, listed first in `resources/list` ahead of the paginated vault notes and cached an hour (`ttlMs`/`cacheScope: private`). Both surfaces are filtered to the caller-visible catalog exactly the way `find_capability` is — a caller never sees a name it could not call — and `find_capability`'s own description now names the resource.
- **`egress.excludePaths` withholds vault-relative folders from every gateway and embedding call the server makes, plus `obsidian-tc consolidate --once [--dry-run]` (#886, THE-934; issues #876, #880).** Reported: `readPaths` is a read-visibility whitelist, not a deny list, so keeping two private folders out of ambient model calls meant whitelisting every other folder for every caller — the wrong tool for the job, and the plane's own jobs did not even apply the folder ACL. `egress.excludePaths` (gitignore-style globs) is enforced at the PORT: `createGatewayClient`, `createEmbeddingProvider(Async)`, and (fix round 2) the reranker port (`guardReranker`, wired into both `resolveReranker` and `wireGatewaySeams`'s fallback) — the three factories in the tree that ever construct one of these clients — refuse a request that does not declare which vault paths its text came from, or that names an excluded one, so a call site that forgets to filter fails loudly instead of leaking, not only the ones audited in the first pass. Covers contradiction judging, synthesis, citation inference (the scheduled job and the `citation-infer` CLI), index-time embedding on BOTH the batched reconcile and the single-note write path (`write_note`/`append_note`/`patch_note`, the filesystem watcher, and a move into an excluded folder), `reflect` and `knowledge_challenge`, the note- and cluster-level summarizers (`obsidian-tc index`/`cluster`), `densify-llm`, the hosted `/rerank` passthrough, and the scheduled proactive-advisory sweep. Each consumer still filters its own candidates first (a contradiction pair or reflect evidence set with an excluded side is dropped, a summarizer skips the note and reports it, a reranker sends only non-excluded docs, and an excluded doc is APPENDED after the reranked set on return — fix round 2 found the original synthetic-score merge outranking real cross-encoder scores and promoting excluded docs to the top) — the port is the backstop that catches what a filtering bug or a forgotten call site misses, not the primary mechanism. Index-time embedding withholds a vector entirely for an excluded chunk (still chunked, stored, and text/regex-searchable — only semantic search is affected) and marks it with a new `chunks.embedding_excluded` column so the audit job's null-embedding check does not flag it as a defect. Not covered: lexical/regex search over an excluded chunk stays local and searchable by design. Paths are re-evaluated every pass — a folder renamed into or out of the exclusion takes effect on the very next reconcile, write, or consolidation pass, not retroactively. `obsidian-tc consolidate --once [--dry-run]` (CLI-only, no MCP tool, so no agent-callable trigger for unattended whole-vault model calls) runs one synthesis + one audit pass — exiting non-zero if either genuinely fails, not merely degrades for lack of a configured gateway — or with `--dry-run` reports the candidate counts and estimated gateway call count with ZERO calls made. Fix round 3 closed a cross-vendor review's findings against the squashed PR: a literal exclude pattern with no glob metacharacters (`Private` or `Private/`) now also matches everything nested under it as a folder, identically to writing `Private/**` explicitly — previously it compiled to an exact-string match that excluded nothing real, the most natural config an operator would write. A note transitioning to excluded now has its `note_summaries` row and embedding deleted, not merely its chunk vectors — a stale summary used to stay searchable and kept feeding the k-means clustering pass that produces cluster summaries. The advisory sweep's contradiction and synthesis candidates now declare the real vault paths their text was drawn from (a contradiction's `[source_path, conflict_path]`, a synthesis's parsed `evidence_paths`) instead of an opaque row id the filter could never match, and a synthesis row with no provable provenance is treated as excluded rather than passed through. A cluster-summary search result also now applies the same exclusion filter as its ACL filter (its own `.path` is a cluster_key, not a real vault path, so a downstream check on it could never see an excluded member). `episode-search.ts`'s semantic channel — a genuine regression this PR introduced — declares `sourcePaths: []` (episode summaries are Tier-0 deterministic metadata that can never quote note content) instead of leaving `work_search`'s semantic arm silently always-empty. Every content-bearing catch that could swallow the port guard's refusal into an ordinary failure (summarize-notes, summarize-clusters, densify-llm, citation inference, contradiction judging, and the reranker's own fallback) now rethrows it — and the reranker's fallback on a genuine outage falls back over the already-filtered candidate set, not the original unfiltered one. `EgressViolationError` now extends `ObsidianTcError` (a new `egress_excluded` code, never retryable) so a per-leg fan-out isolation layer's `isLoudRefusal` check recognises it too, not only an explicit `instanceof` check at one layer. Fix round 4 generalised two of those fixes from the instance to the CLASS. Exclude patterns are now NORMALISED before compilation — a leading `/` or `./` is stripped and repeated separators collapse, so `/Private`, `./Private` and `Private//` all mean the same root-anchored folder — and EVERY pattern (not only a metacharacter-free one) also matches everything beneath it, so `Private*/`, `*/Private/`, `Private/*` and `**/Private` stop silently matching nothing; `**/Private` additionally matches a `Private` folder at any depth, root included. The safe direction is outward throughout: `Private/*` covers the whole subtree (gitignore never descends into an excluded directory either) and a folder-shaped pattern also matches a file of that exact name. Two spellings are now REFUSED at config load rather than compiled — one that normalises to nothing (`""`, `/`, `./`, whitespace), which would silently protect nothing, and `**`, which would withhold the whole vault from every plane job (set `plane.enabled: false` for that instead). The `note_summaries` cleanup likewise moved from the exclusion TRANSITION to the whole class: an excluded note's summary row is now deleted on every reconcile (including a note already stamped excluded by an earlier pass, and a note with no chunks at all), on the single-note write path, and by the summarizer itself when it runs with no reconcile in front of it — and `searchNoteSummaries` applies the exclusion filter at query time, the backstop `searchClusterSummaries` already had. The advisory sweep now treats an empty or whitespace-only declared path as MISSING provenance (fail closed) rather than as a path that simply matches nothing, and its fail-closed rule fires only when the filter actually carries a pattern — on a default install, where the wiring compiles an empty filter unconditionally, nothing is dropped.

## [1.24.0] - 2026-09-03

### Added

- **`agent_episodes.task_result` gets an on-demand writer (THE-726).** `work_result` had exactly one caller (itself): measured on the live store 14 days after deploy, 2 stamped rows (the operator smoke test) against 620 unstamped tool rows, 128 of them post-deploy — the pre-registered kill condition. The server now derives a verdict from a closed session's tool-call log (a terminal error, a retried args_hash that never recovers, or a search followed by a read that ends cleanly) and writes it through the same `stampOpenWindow` window rule the operator tool uses, on the scheduled reflect tick and the CLI `reflect` command. New `verdict_source`/`verdict_policy` provenance columns on `agent_episodes` distinguish a first-person `operator` stamp from a `derived` one. New flag `experiential.derivedVerdictHold` (default off) controls whether a derived `-1` can hold an episode out of promotion the way an operator `-1` always does; off, a derived `-1` is still written and still feeds `preferred.search_mode` evidence, it just does not hold. Dependency (owner-settled after review): the derivation acts only on sessions that exist and end — HTTP with `sessions.autoOpen` (default off), or an explicit `start_session`/`end_session` pair; on stdio with no session concept in play it is inert by design. Measured on the live Cave deployment: 44 ended sessions carrying 249 derivable unstamped tool rows, so the trigger fires on real traffic. Review round 1 fixes: S1 ("browse") no longer counts an ERRORED search as seeding it (a failed search followed by an unrelated read used to derive `+1`); tied `ts` values now break deterministically on episode id; the derive step is wrapped in its own try/catch in both callers and no-ops cleanly against a cache.db with no `workspace_sessions` table; a session whose window can never resolve now gets a neutral terminal stamp instead of starving the oldest-first scan forever; the candidate scan is bounded in SQL. `DERIVATION_POLICY_VERSION` bumped to 2. Review round 2 fix: the terminal-drain stamp (the neutral `0` written when a session's window can never resolve) now writes `verdict_policy = TERMINAL_DRAIN_POLICY` (0) instead of `DERIVATION_POLICY_VERSION`, and counts under a new `stamped.drained`, not `stamped.zero`, since it was previously indistinguishable from a rule genuinely deriving neutral and contaminated any live-store query grouping derived windows by outcome; such a query must now filter `verdict_policy >= 1`. Review round 3 fixes (cross-vendor findings on PR #882): S1 ("browse") now also requires the READ that follows an ok search to itself end `ok`, not just the search; tied `ts` values now break on `seq` (the row's SQL `rowid`, real capture order) instead of the episode id, which was stable but not causal; the candidate session scan now excludes sessions cache.db still shows open (they used to fill the entire candidate cap and starve every ended session forever) and orders what remains by oldest debt first, so the cap is now deterministic; `DERIVATION_POLICY_VERSION` bumped to 3. Also: the CLI `reflect` command now opens cache.db inside the guarded derive step rather than unconditionally before it, so an unreadable or corrupt cache.db no longer aborts the whole command before the eligibility pass runs.

## [1.23.6] - 2026-09-01

### Changed

- **A point-in-time (`as_of`) retrieval query no longer reads chunk content it discards (#874, THE-932).** `filterChunksAsOf` selected the large `content` column (and `path`) for every chunk existing at the cutoff, but the `as_of` pre-filter only ever builds an `id → changed_since_d` lookup from the result — so the content was fetched purely to be thrown away. The query now returns id + timestamps only. Behavior is byte-identical; only the wasted I/O on an `as_of` query is removed.

## [1.23.5] - 2026-09-01

### Fixed

- **The v1.22.0 point-in-time filter (#824, THE-635) was announced as shipped but had zero production callers** — `search/point_in_time.ts`'s `filterChunksAsOf`/`changedSinceD` were fully unit-tested (`test/point_in_time.test.ts`) yet unreachable from any tool, an over-claim the module boundary gate had to allowlist as "genuinely unreachable, tracked work" rather than catch as a defect. **`knowledge_search` and `vault_graph_search` now accept optional `as_of`/`since` (epoch ms) (#872)**; when `as_of` is given, `graph_search_stages/candidate_assembly.ts` PRE-filters the merged candidate set (before fusion/ranking, not a post-hoc drop of ranked results) by calling `filterChunksAsOf` directly, and every surviving result carries `changed_since_d` so a chunk edited after the cutoff is never silently served as the historical state. Composes with ACL (the pre-filter only ever removes candidates, never readmits one ACL already excluded) and forces the lexical-route short-circuit off for an `as_of` query, since that route bypasses `candidateAssembly` entirely. Absent `as_of`: byte-identical to before this change. `point_in_time.ts` is no longer in the boundary gate's unreachable allowlist.

### Internal

- Maintainability and CI-reliability pass from the v1.23.4 whole-repo health analysis: an honest coverage floor added to `packages/plugin`, which had none (#869); real-timer test flakes removed — `perf-isolate` gets a platform-aware timeout and event-wait tests poll with `vi.waitFor` instead of racing fixed sleeps (#870); knip config false-positives trimmed and four confirmed-dead internal exports demoted (#871). No runtime behavior change.

## [1.23.4] - 2026-09-01

### Fixed

- **The fetch cause was preserved only at `doFetch`, so a TLS-untrusted companion still misdirected every other transport (THE-923, #865).** v1.23.3 (THE-922) fixed the bridge `doFetch` and `doctor`, but a security audit found the same cause-discarding `catch` on four more live paths: the plugin-proxy tool gate `requirePlugin` (which runs before `doFetch` on every tool call), the `openCompanionBridge` gate behind `list_commands`/`execute_command`, the shared embeddings/rerank transport `postJson`, and the LiteLLM gateway client. All now attach a pattern-guarded `cause_code` via a shared `extractCauseCode` util, so a certificate-trust failure gets a cert-aware remediation instead of "reload the plugin" on every surface, not just `doctor`. End-to-end tests now assert `cause_code` on the wire error for the actual tool-call path — the regression that let the original fix ship incomplete.
- **Four introspection tools leaked cross-vault identifiers to a vault-bound HTTP caller (THE-924, #864).** `list_vaults`, `server_health`, `get_server_config`, and `get_metrics` each returned every configured vault's id, filesystem path, plugin inventory, or per-vault counters regardless of the caller's vault binding — `list_vaults`/`get_server_config` because they take no vault argument for the dispatch gate to police, `server_health` because it gated on `authenticated` alone, and `get_metrics` because its vault argument was optional (omitting it skipped the gate). Each now scopes its output to the caller's own vault when the caller is vault-bound; unbound trusted callers are unaffected. This is the THE-563/564 tenant-isolation class on surfaces the binding gate could not reach.
- **A note edit during a full `index_vault` reconcile could silently revert that note's index to stale content (THE-925, #866).** `index_vault` and the `write_note`/watcher path were uncoordinated writers to the same chunk rows on the single cache database connection; the batched reconcile applied an in-memory plan computed earlier, overwriting a concurrent write or pruning freshly-created chunks. The batch now re-reads each note's current chunk state under the write lock before applying and skips a note whose rows changed underneath it (re-planned on the next pass), and records the skip in a new `obsidian_tc_index_stale_skipped_total` metric.
- **Retrieval fan-out silently swallowed a deliberate index-integrity refusal, and a valid search regex could be rejected as a ReDoS (THE-926, #867).** Multi-query and federated search caught every per-leg error into an empty result, hiding the `chunk_fts` pre-migration refusal that should fail loudly; loud refusals are now rethrown and swallowed transient legs are surfaced via new `failed_variants`/`failed_vaults` output. The regex search guard rejected safe sequential quantifiers (`\w+\s+\w+`, `a+b+c+`) as catastrophic; it now flags only identical repeated quantified atoms, the real backtracking signature. Also: scheduled maintenance jobs now honor the shutdown abort signal instead of racing the database close, a transient regex-worker probe failure no longer disables the worker permanently, and plane job errors record a real message for a non-`Error` throw.

## [1.23.3] - 2026-08-31

### Fixed

- **A TLS trust failure was reported as "reload the plugin inside Obsidian" — the bridge transport discarded `e.cause`, collapsing every fetch failure into one indistinguishable state (THE-922, #861).** Externally reported (#860): `doctor` prescribed a plugin reload while the companion was answering the same URL in 69 ms; the real cause was `DEPTH_ZERO_SELF_SIGNED_CERT` on a hand-run CLI that lacked the `NODE_EXTRA_CA_CERTS` an MCP client's env supplies. `doFetch` now attaches a pattern-guarded `cause_code` to the `plugin_unreachable` error the way the non-2xx branch attaches `http_status` (the code lands on `e.cause.code` under Node and directly on `e.code` under Bun; both shapes are read), the probe carries it onto the capability snapshot as `unreachableCause`, and `bridgeState` classifies the TLS/trust class (`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_`/`ERR_TLS_` prefixes) to a new `companion-untrusted-cert` reason whose remediation points at the certificate. The cert classification outranks the reload advice only when the plugin is enabled on disk (or the hint is unavailable) — a TLS handshake proves something is listening, not that it is the companion, so `absent`/`disabled` keep their install/enable remediations. Every unreachable report now surfaces `causeCode` verbatim, so even an unrecognized code collapses diagnosis to one line.

## [1.23.2] - 2026-08-21

### Added

- **`native-contract` CI lane + a real-binding contract test, closing the blind spot #855 exploited (THE-905, #857).** Every prior server test lane ran without the compiled native addon — `ci-server.yml`'s `build-test` installs `--ignore-scripts`, and `ci-native.yml`'s `fallback-test` job forces the JS fallback on purpose — so a caller violating the native's strict Rust signature passed CI on the lenient JS fallback and crashed on every real install (#855's `cosineSimilarity` type mismatch). The new `native-contract` job in `ci-server.yml` (deliberately not `ci-native.yml`, which is path-filtered to `packages/native/**` and would never have run on #855's server-only diff) builds the addon for real, asserts `nativeLoaded === true` before trusting anything downstream, then runs the server suites that reach `loadNative()`-backed code paths. `packages/server/test/native-contract.test.ts` calls the compiled binding directly with the exact types `NativeOps` declares and pins the negative case — a plain array where the native requires a `Float32Array` must throw — documenting the fallback's remaining leniency rather than silently tolerating it.

### Fixed

- **The boot ready line, `doctor`, the capability profile and `server_health` could all report `native=on` / "native acceleration module loaded" while actually running the pure-JS fallback (THE-906, #858).** `#857` closed this blind spot for CI's own load-assertion but left every operator-facing surface reading `search/native.ts`'s old `nativeLoaded`, which only checks that requiring `@the-40-thieves/obsidian-tc-native` produced the right function *names* — true even when `packages/native/index.js` silently substitutes its own bundled `fallback.js` under those same names, which it does on every host with no local `.node` and no published platform prebuild (every `--ignore-scripts` checkout). `search/native.ts` now exposes `nativeResolved` (the old, ambiguous meaning) and `nativeBindingActive` (true only when the resolved module's own `nativeLoaded` export confirms the real napi binding is serving — the same signal `#857`'s contract test already trusted). The boot line prints `native=js-fallback` instead of a misleading `native=on` when the fallback is serving; `doctor`'s `native.availability` check, the capability profile's `runtime.nativeModule`, and `server_health`'s `native_loaded` all now read `nativeBindingActive`. Vault I/O's `nativeVaultIo` already used this pattern correctly and needed no change.

## [1.23.1] - 2026-08-21

### Fixed

- **Semantic `work_search` and the advisory sweep crashed on any install with the prebuilt native addon** — both passed a plain `number[]` where the native `cosineSimilarity` binding requires a `Float32Array` (#855). The JS fallback tolerated the wrong type, so the defect was invisible wherever the addon wasn't built — including the CI test lane. Callers fixed, and the `NativeOps` interface tightened to `b: Float32Array` so the compiler now rejects this class.

### Added

- **`check:comment-style` CI gate enforcing the inline-commentary policy** (#854). Dated
  ticket-thread banners and first-person narrative in `packages/*/src` comments are now hard CI
  errors, and a comment-density ratchet (`scripts/comment-style-baseline.json`, 33 files ≥120
  comment lines at introduction) prevents regression toward the old register without failing
  history. String literals are stripped before matching, so code that merely mentions a banner
  keyword cannot false-positive.

- **Inline commentary policy + a generated, drift-gated decisions index** (#850). Ticket-thread-
  register comments (dated `CORRECTED`/`VERIFIED`/`MEASURED` banners, first-person narrative,
  measurement tables) are knowledge-dense but read as insider notes to an outside contributor, and
  hundreds of source files cite a `THE-xxx` id into this project's private Linear tracker with no
  way to resolve it publicly. CONTRIBUTING.md's new "Inline commentary" section states the policy
  going forward — invariants and why, present-tense, ≤~6 lines, deep rationale relocated to
  `docs/design/`, `docs/adr/`, or `docs/superpowers/specs/` with a one-line pointer left behind —
  with explicit exemptions for migrations, `docs/`, `CHANGELOG.md`, and test fixtures.
  `docs/decisions-index.md` (`scripts/gen-decisions-index.mjs`, same generate/`--check` drift-gate
  shape as `just map`) resolves every `THE-xxx` cited under `packages/*/src` to the CHANGELOG entry
  or design/ADR/spec doc that shipped it, or an explicit internal-reference placeholder — never a
  guess. Wired into `ci-docgen`'s drift gate alongside the other generated docs.

- **Inline commentary policy enforcement gate (`check:comment-style`).** #851/#852 swept the tree
  clean of the register #850's policy bans; this is the mechanized guard against it regrowing.
  `scripts/check-comment-style.mjs` scans every TypeScript file under `packages/*/src` for two
  hard-fail patterns in COMMENT CONTENT ONLY (string/template literals are walked and skipped
  before comment extraction, so a fixture asserting on comment text is never in scope) — a dated
  ticket-thread banner (`CORRECTED`/`VERIFIED`/`MEASURED`/`DECIDED`/`RE-CHECKED`/`RETARGETED`/
  `SUPERSEDED`/`UNPARKED` attached to a year) and first-person narrative (`"I found"`, `"we
  measured"`). Both patterns were tuned against the real tree until they read cleanly at 0 hits:
  the banner rule excludes an adjectival `-era` year suffix (`transport-VERIFIED 2026-era`, not a
  banner), and the first-person rule blanks quoted prose first so a comment glossing someone
  else's voice (`("I looked and found nothing")`) is not mistaken for the author's own. A ratchet
  (`scripts/comment-style-baseline.json`) caps the count of files carrying >= 120 comment lines at
  today's measured 33 — a file may still carry a long comment block, but that count may not grow —
  mirroring `.jscpd.json`'s duplication threshold. Generated files (this repo's `GENERATED` header
  convention) are skipped entirely. Wired into `ci-server`'s lint job alongside `check:config-paths`.

## [1.23.0] - 2026-08-21

### Added

- **THE-891 item 2 (#845) — the capture mitigation profile every accepted local-persistence
  precedent ships (bounded retention + first-run notice + location guard),
  `experiential.captureContent` stays on (behavior change: retention).** Researched what
  separates an accepted on-by-default local capture default (VS Code Local History, JetBrains
  Local History, Go's telemetry-in-local-mode) from a scandalous one, and it is never the
  default itself — it is three structural
  properties shipped together. `captureContent`'s own default is unchanged (still `true`); what
  changed is the mitigation set around it:
  - **Bounded retention on the raw content (behavior change).** New
    `experiential.captureRetentionDays` (default **30**, `0` = unlimited). The maintenance sweep
    now **redacts** `args_json` to `NULL` on every `agent_episodes` row older than the window —
    live or dead — rather than deleting the row: action-axis history (tool, status, duration,
    sizes, hashes, attribution, eligibility) survives untouched, only the raw parsed arguments age
    out (`redactAgedEpisodeContent`, `packages/server/src/db/maintenance.ts`, wired into the
    existing hourly sweep via `runtime/maintenance-wiring.ts` and `scheduler-wiring.ts`).
    Deliberately independent of `maintenance.episodesRetentionDays`, which governs row *deletion*
    for already-dead episodes only — this is a content-axis, EDPB storage-limitation question, not
    a work-memory one. Session trace files (`sessions.traceContent`) were checked and need no
    equivalent change: `observability.retention.tracesDays` (default 30, already wired into the
    same sweep) already deletes the whole trace file past its window, which already bounds any
    captured content inside it — redacting only the content portion of a JSONL trace would mean
    parsing and rewriting every line, which is not the "cheap plumbing" this item scoped in.
  - **A one-time boot notice, per install rather than per boot** (`runtime/capture-first-run-
    notice.ts`): the first boot with `captureContent` on writes one stderr line naming the storage
    path, the retention window, and the two ways to turn it off
    (`experiential.captureContent=false` or `securityProfile: "hardened"`), then records a marker
    file (`<cacheDir>/capture-notice-shown`) so restarts stay silent — deliberately the opposite of
    `plane-opt-in-notice.ts`'s every-boot repeat, since re-nagging an operator who already saw the
    notice trains "skip the boot banner."
  - **A doctor check against vault-adjacent storage** (new `experiential.capture-location` check,
    `packages/server/src/doctor/capture-location.ts`): warns when `cacheDir` resolves inside a
    configured vault root, since a vault commonly lives inside a synced folder (iCloud Drive,
    Dropbox, Syncthing) that would silently replicate captured content off the machine. The
    **shipped default is already safe** — `config/load.ts`'s `finalizeConfig` anchors a relative
    `cacheDir` (the schema default, `.obsidian-tc`) to `homedir()`, resolving to `~/.obsidian-tc`,
    which sits outside every vault by construction — so this check exists for the *misconfigured*
    case (an explicit `cacheDir` override), not the default install.

  `retrieval.schema.ts`'s `captureContent` comment is rewritten accordingly: the old justification
  ("the deployment is single-principal" — an owner, not a control) is replaced with the precedent-
  class argument above. Deliberately **out of scope**: a metadata-only capture mode (real schema
  churn, not attempted here) and changing `captureContent`'s own default value.
- **`obsidian_tc_acl_walk_pruned_total` — the graph-walk ACL filter's recall cost is now observable
  (THE-891 item 3, #847).** The filter itself has been unconditionally on since v1.22.0
  (THE-695/THE-852): an ACL-denied note can never serve as a bridge between two readable ones, for
  every caller, with no config flag to disable it. What was missing was a way to SEE what it costs —
  a restricted caller's search silently returning fewer notes than an unrestricted caller's would,
  with nothing distinguishing "the walk found less" from "the filter pruned a path." The new counter
  fires once per graph-expansion call that excluded at least one path a caller's own re-walk (over
  the same seed frontier, unfiltered) would otherwise have reached, labeled by `vault` only. It is
  zero by construction for an unrestricted caller — their permitted set is the whole corpus, so the
  join is a proven structural no-op and the prune-detection re-walk never even runs for them, which
  keeps the common single-principal deployment exactly as cheap as before this ticket. SECURITY.md
  gained a "Graph-walk ACL filter" entry explaining why the filter applies uniformly rather than
  conditionally (fail-safe defaults: a recall miss is detectable, a bridge-inference leak is not),
  and the THE-694/695 design doc that originally proposed shipping this dark now carries a dated
  banner pointing at THE-852's supersession.
- **THE-707 — experiential-tier benchmark applicability assessment (no adapter built).**
  Researched the three public "experiential memory" benchmarks named in the ticket
  (LongMemEval, LongMemEval-V2, BEAM) against what obsidian-tc's experiential tier
  (`agent_episodes` + `preference_profile` + `work_search`) actually is: episodic memory of the
  agent's own MCP tool-call history, plus one closed-vocabulary revealed-preference counter
  (`preferred.search_mode`) — not a chat-conversation or web-browsing-trajectory memory. All
  three benchmarks' "history" is either multi-turn chat dialogue (LongMemEval, BEAM) or
  multimodal WebArena/ServiceNow web-agent trajectories (LongMemEval-V2); none maps onto
  tool-call episodes without writing synthetic rows that bypass every real producer in the
  system, which would measure the general retrieval plane's text search (already covered by
  `eval/run.ts`'s golden set) while mislabeling it as experiential-tier performance. Verdict:
  genuinely poor fit — documented in `packages/server/eval/THE-707-experiential-benchmark-applicability.md`
  rather than forced into a misleading adapter.
- **Source-agnostic highlight-import format + Readwise adapter, staged via `capture_queue`
  (#839, THE-650).** Read-later highlights (Readwise Reader, the live canonical source now that
  Omnivore's API and data are shut down) never reached the vault before this, so nothing about
  them was retrievable. `import-highlights` (a new CLI command) fetches from Readwise's classic
  v2 export endpoint (`GET /api/v2/export/`, `Authorization: Token <token>`, cursor-paginated via
  `pageCursor`/`updatedAfter`), maps the nested book→highlights response onto a source-agnostic
  canonical shape (`packages/server/src/capture/highlight-import.ts`), and lands each highlight in
  `capture_queue` via the existing `enqueueCapture` contract with `source: "import"` — inheriting
  THE-855's poison scan and the human `commit_capture` gate the same as every other capture
  producer; nothing here writes to the vault directly. Deduplicates on a per-highlight hash of
  `(source, source_id, text, location, highlighted_at)`, carried as an `import-dedupe:<hash>` tag
  and checked against every prior `source: "import"` row (pending AND committed) before
  enqueueing, so re-running a sync never re-enqueues an already-staged highlight — the dedupe tag
  itself is filtered out of `list_capture_queue` and a committed note's frontmatter (both now go
  through `tools/m5/capture-tools.ts`'s new `visibleTags`), so this machine identity never reaches
  a reviewer or the vault. Ships INERT: the
  new `readwise.token` config key is absent by default, and with no token the command no-ops with
  NO network call — the same degradation contract `plur`'s optional endpoint already establishes.
  Readwise is the first adapter of a format designed for others (Instapaper/Matter, which Readwise
  itself already aggregates) to reuse without a new canonical shape.
- **Source-agnostic ambient-capture import format + Pensieve adapter, staged via `capture_queue`
  (#841, THE-175).** Sibling to THE-650's highlight-import format (same pattern, different domain):
  passively-recorded screen activity — OCR'd screen text, active app/window, optional browser
  URL — never reached the vault before this. `import-ambient` (a new CLI command) polls a
  Pensieve instance's `GET /api/search` (verified against github.com/arkohut/pensieve @ v0.37.0,
  Apache-2.0; `q=""` lists entities newest-first, `start=<epochSeconds>` scopes to `--since`),
  maps `metadata_entries` (`active_app`/`active_window`/`url`/`ocr_result`, filtering OCR lines
  below the plugin's own 0.5 confidence score) onto a source-agnostic canonical shape
  (`packages/server/src/capture/ambient-import.ts`), and lands each observation in `capture_queue`
  via the existing `enqueueCapture` contract with `source: "ambient"` — the channel
  `experiential/poison.ts`'s frozen `CHANNEL_TRUST` table already reserved by name for this ticket
  — inheriting THE-855's poison scan and the human `commit_capture` gate the same as every other
  capture producer; nothing here writes to the vault directly. Unlike highlight-import, ambient
  text is redacted for secret-shaped substrings (`experiential/redact.ts`'s shared scanner) BEFORE
  enqueue, since a passively-captured screen is far more likely to catch a credential in frame than
  a deliberate highlight. Deduplicates on a hash of `(source, machine, app, text)`, carried as an
  `ambient-dedupe:<hash>` tag and checked against every prior `source: "ambient"` row (pending AND
  committed) before enqueueing, so a repeatedly-polled static screen never re-enqueues — the dedupe
  tag itself is filtered out of `list_capture_queue` and a committed note's frontmatter via
  `tools/m5/capture-tools.ts`'s `visibleTags` (now shared with THE-650's own dedupe tag), so this
  machine identity never reaches a reviewer or the vault. Every fetch is capped
  (`PENSIEVE_DEFAULT_LIMIT`, clamped to the API's own `le=200`) so a first sync against months of
  unprocessed screenshots can't flood the queue in one run. Ships INERT: the new `pensieve.baseUrl`
  config key is absent by default, and with no baseUrl the command no-ops with NO network call —
  the same degradation contract `readwise.token` already establishes. Screenpipe is explicitly out
  of scope for this OSS-clean slice (licensing).

- **`experiential.citationPreferences` folds retrieval-level citation outcomes into learned
  preferences (#836, THE-644).** `extractPreferences`'s deterministic `preferred.search_mode` counter
  previously learned only from `agent_episodes.task_result` — the episode-level verdict. The
  retrieval-level signal (which CHUNKS actually got cited) lives on `chunk_retrievals.citation_state`
  / `cited_in_response` and was never wired in: the ticket's original target, `feedback`, has zero
  producers, but `citation_state` does (THE-717's citation-inference pass). A search-family tool
  (`search_text`/`search_regex`/`search_vault`/`vault_graph_search`/`search_omnisearch`) whose
  retrievals are CONFIRMED cited now strengthens the same key an episode-level success already
  strengthens; one whose retrievals are REJECTED weakens it — one delta per `event_group` (one
  search call), not one per returned chunk, mirroring the episode-side one-window-one-observation
  rule. `chunk_retrievals` carries no `vault_id`, so scoping is a ground-truth join against the
  target vault's own `cache.db` `chunks` table (the same cross-store pattern `note-quality.ts` and
  `metrics.ts` already use). Ranking-adjacent, so **off by default** like `activationRerank` — the
  golden-set eval (`~/obsidian-tc-eval/`) has no citation-labeled preference corpus to exercise this
  mechanism against today, so this ships dark with unit tests proving the deterministic
  citation-to-delta mapping rather than a golden-set result; a future run once such a corpus exists
  would check for a detectable, non-inferior effect before defaulting on.

### Fixed

- **Client identity now reaches `tools/call` handlers (#834, THE-861).** The pinned SDK
  (`@modelcontextprotocol/server@2.0.0`) reserves `io.modelcontextprotocol/clientInfo` as
  per-request envelope material and lifts it out of `params._meta` before any handler runs — on
  every message, in both spec eras — surfacing it instead at `extra.mcpReq.envelope`. `server.ts`
  was reading `req.params._meta` directly, so a client's declared name/version never reached
  `ctx.clientInfo` and `workspace_sessions.client_name`/`client_version` were always NULL. The
  `tools/call` handler now reads `extra.mcpReq.envelope` first, falling back to `req.params._meta`
  for any path that still legitimately carries it there.
- **`client-features.ts`'s `logging/setLevel` comment now matches what the SDK actually does under
  legacy (#835, THE-862).** The header comment (and a duplicate in `server.ts`) claimed the method
  "is not a routable method in SDK v2 ... a handler registered for it answers -32601, measured." True
  under 2026-07-28 (SEP-2575 removed the method; the modern route refuses it by name before any
  `Server` handler runs), but not under 2025-11-25: declaring the `logging: {}` capability makes the
  pinned `@modelcontextprotocol/server@2.0.0` SDK auto-register its own built-in `logging/setLevel`
  handler, reachable under legacy because nothing pre-filters the method the way the modern route
  does — it succeeds, returning `{}`. `docs/MCP-CLIENT-COMPAT-MATRIX.md` and
  `mcp-client-compat-matrix.test.ts` (THE-725) already asserted this true behavior; only the source
  comments were stale. Kept the SDK's built-in `{}` handler as-is (the level it stores is never
  consulted on this stateless transport, so it is harmless) rather than pre-filtering the method
  under legacy too, and fixed the two comments plus a cross-reference note in the matrix doc/test so
  code, comments and matrix all agree.
- **`/makemd/spaces` no longer silently degrades to an empty list (#837, THE-860).** make.md's
  published `IAPI` has had neither a `spaces()` nor a `query()` method since at least v1.0.1
  (2024-12-27) through the current v1.3.5 — a THE-749 contract fixture caught `/makemd/spaces`
  answering `ok:true, { spaces: [] }` when handed the real, current API (its sibling `/makemd/query`
  already failed loud). Both bridge routes are dead against every make.md version this bridge could
  plausibly target, so `/makemd/spaces` now checks `typeof api.spaces === "function"` and returns a
  typed `plugin_unreachable` when absent, matching `/makemd/query`'s existing guard, instead of a
  silent wrong-value result. The routes stay in place (dropping them is a product decision, not a
  correctness fix) with a comment documenting the finding.
- **Five deployment-bias leaks from the THE-891 product-lens audit, corrected (#843, THE-710's
  recorded-lesson pattern: "single-user is not single-vault").** Each was a numeric default or
  justification calibrated on the maintainer's own ~1,150-note, single-principal deployment and
  shipped as though it were a product truth:
  - `gaps.ts`'s coverage-gap threshold now prefers a vault's own `score_calibration` (`gaps
    --calibrate`) over `DEFAULT_GAP_THRESHOLD` whenever one exists with enough samples
    (`resolveGapThreshold`, wired into both the CLI and the scheduled gap-sweep); the constant is
    now documented honestly as a last-resort fallback from one vault's dead nomic-768
    representation, and both callers log when they actually fall back to it uncalibrated.
  - `search/note-summaries.ts`'s brute-force note-summary scan now states a concrete, measured
    ceiling (`NOTE_SUMMARY_SCAN_CEILING`, derived from a benchmarked ~2us/row cosine cost) instead
    of an unstated "stays small enough," and a new `search.note-summaries-scale` doctor check
    (`doctor --probe`) warns per-vault when a vault crosses it.
  - The synthesis job's `plane.maxPromptChars` default moved from 60,000 to 45,535 characters,
    recomputed from the SAME worst-case density (2.5 chars/token, code/CJK) the module already
    documented rather than from the maintainer's own prose density (3.294) — every vault shape now
    keeps at least the same ~14,554-token output reserve the old default only gave prose-like
    vaults.
  - `citation.ts`'s `judgeConcurrency` default (unchanged: 3) is now justified as a conservative
    floor safe for the weakest gateway behind the judge role, not "a burst this deployment has no
    reason to send" — `--judge-concurrency`'s CLI help now says when to raise it.
  - The arm-first-class CI rationale in `docs/.../mcp-clients.md` no longer cites "the maintainer's
    production runs Ampere"; the tie-ordering nDCG divergence measured directly above it is the
    actual evidence and now stands alone.

### Security

- **Per-key preference scoping — human vs caller (#846, THE-891 item 6).** `preference_profile` /
  `preference_deltas` gain a `scope_caller` column (migration `20260820_001`, PK now `(vault_id,
  scope_caller, key)`), and `PREFERENCE_KEYS` (`reflect.ts`) now declares a scope per registered
  key: `"human"` keys stay shared by every caller of a vault (the human's preference, whichever
  agent is asking); `"caller"` keys are partitioned per principal, because a telemetry-derived
  preference encodes the *observing agent's* workload and must not steer a different agent's
  retrieval. `preferred.search_mode` — the one registered key — is now caller-scoped. New keys
  default to caller-scoped; sharing is a per-key opt-in reviewed at registration. Reads go through
  `preferenceProfile(edb, vaultId, caller, opts?)`: a caller sees the human partition (`''`, where a
  NULL caller — the single trusted principal on an unauthenticated stdio transport — lands too)
  UNION its own; `opts.anyCaller` crosses every partition and is authorization-enforced, not
  filtered, mirroring `agent_episodes`' P1.7 treatment (`admin:workspace`, refuses rather than
  silently narrowing). Existing `preferred.search_mode` rows were purged, not backfilled — same
  THE-563/THE-710 precedent: no row ever recorded a caller, and the deterministic extractor
  (THE-673) reproduces them with correct per-window attribution from retained episodes. SECURITY.md
  and `reflect.ts`'s own comments are rewritten in the same change (the earlier "all callers are the
  same person" wording conflated one human with one working context — the supported topology is one
  human running many agents through one server, and cross-caller preference bleed is a real
  contamination channel even with a single trusted human).
- **`sentence-transformers`'s floor bounded below its new major (#840).** The bge-m3 service's
  `>=5` floor admitted the just-released v6.0.0 (2026-08-18, requires `transformers>=5,<6`) on any
  pyproject-only install — unvalidated against this service, the same unbounded-`>=X`-forces-a-major
  class the `sharp` override was bounded against in #750. Now `>=5,<6`; the compiled
  `requirements.txt` already pins deployments and is unaffected.

## [1.22.0] - 2026-08-20

### Added

- **`get_index_status` reports in-flight `index_vault` progress (#807, THE-645 item 4).** The tool call
  itself carried no progress seam — `index_vault` returned once, at completion, and the longest
  recorded call on a live deployment ran 7m11s with no observable output in between. `indexVault`
  now fires an optional `onProgress` callback once per completed `flush()` batch (never per note,
  never per chunk — `index.chunks_per_s` is a gated perf metric a per-chunk callback would cost),
  carrying cumulative notes-processed/chunks-upserted counts and a `startedAt`. `get_index_status`
  surfaces it as an additive, optional `in_flight` field — absent when no `index_vault` call is
  running for this process, present with the vault id and progress while one is. Cleared on both
  normal completion and a rejected run, so a failed pass never leaves a stale "still running" entry.
  `in_flight` is a single shared slot, not a per-vault map, and both clear sites are guarded on
  `inFlight.vault === vaultId`: dispatch has no cross-call serialization, so two `index_vault` calls
  on different vaults can genuinely overlap, and an unguarded clear let one vault's completion null
  out a different, still-running vault's entry (caught in review before merge). The slot reports
  "an" in-flight run, not "all" of them, when two overlap.

- **A bundled `local` cross-encoder reranker — `gatedRerank` with no gateway and no external service
  (#806, THE-705).** A new `local` reranker provider runs the int8 ONNX export of
  `cross-encoder/ms-marco-MiniLM-L6-v2` (~23 MB, Apache-2.0) via `@huggingface/transformers`,
  lazy-loaded and memoized on the first `rerank()` call so resolving it at boot costs nothing beyond
  a small dynamic import. It ships as a separate optional package
  (`@the-40-thieves/obsidian-tc-reranker-local`, deliberately outside the root workspace so its
  ~230 MB `onnxruntime-node` never reaches a root `bun install`); model weights are downloaded and
  sha256-verified by `bun run fetch-model`, not committed. Absent the package, the registry surfaces
  an actionable `bun add …` error and retrieval degrades to RRF-only. No default changes —
  `retrieval.gatedRerank` stays dark.

- **Federated multi-vault search with per-vault ACL (#809, THE-630).** `vault_graph_search` gains an
  optional `vaults[]` field (max 8) that fans one query across multiple vaults and fuses the
  per-vault ranked lists by rank-based RRF, keyed on `(vault, path)` so two vaults sharing a
  relative path never collapse. ACL is enforced **per vault** — each leg resolves its own
  `FolderAcl` and is fingerprinted under its own vault's ACL in the query cache, never once-for-all
  — and a vault-bound (HTTP-token) caller is refused the moment it names any vault outside its
  binding. Single-vault callers are unaffected.

- **Note-level and cluster-level summary tiers, dark by default (#817, #818, THE-628).** An
  index-time leaf summarizer writes one CURRENT summary per `(vault, path)` keyed on the existing
  `content_hash` (`retrieval.summaries.enabled`, default false), and a RAPTOR-style tier-2 clusters
  those note summaries and summarizes each cluster on the offline `obsidian-tc cluster` cadence
  (`retrieval.summaries.clusters.enabled`, default false, independent of the note flag). A cluster
  summary is derived from multiple notes, so a caller sees it only when **every** member note is
  readable — the note tier's per-path check is insufficient there. Neither flag is flipped on and no
  retrieval-quality result is claimed yet.

- **Point-in-time `since`/`until` retrieval filter (#824, THE-635).** A deterministic filter over
  `chunks.created_at`/`updated_at` reusing the existing temporal range shape: a chunk created after
  the cutoff did not exist yet and is excluded, and every surviving chunk is flagged
  `changedSinceD` so current content is never silently served as if it were the historical state.
  This is the narrow v1 — full past-content reconstruction is explicitly out of scope.

- **`work_search` gains an opt-in `semantic` mode (#820, THE-642).** A cosine channel over
  `agent_episodes.summary` fused with the existing lexical match by RRF: lexical stays the
  exact-match failsafe for names/dates/ids, semantic recovers paraphrase-only matches. It is a
  query-time brute-force cosine over a bounded, already-filtered candidate pool (no persisted vector
  index, no migration); episodes with no summary are simply absent from the semantic stream rather
  than an error.

- **A writer for `agent_episodes.summary` — Tier 0, deterministic (#819, THE-752).** The column had
  readers and no writer since 2026-07-11 (0 of 510 rows populated). `evaluateEpisodes` now templates
  a compact provenance receipt — intent, verdict (`task_result`), a tool-call tally over the
  session window, and parsed tags — into `summary` on every row it evaluates. Zero-LLM by design:
  every field is copied or tallied from columns already written at capture, so there is no
  summarizing-of-summaries.

- **The task-verdict producer for `agent_episodes.task_result` (#804, THE-726).** The column had had
  readers (reflect's bad-result hold, the preference-evidence gate) and no writer since it was
  renamed, inert at 0 of 630 live rows. New `work_result(result, as_of?)` takes **no** `session_id`
  — it resolves the caller's own open session from the server-observed principal, so THE-838's
  cross-principal hole cannot exist here by construction; `as_of` is clamped into the session's own
  span. One stamp at close covers a session.

- **Preference counters are now deterministic over typed evidence (#805, THE-673).**
  `extractPreferences` replaces its LLM judge with a deterministic counter reusing THE-726's
  window-grouping, deriving `preferred.search_mode` strengthen/weaken deltas from `task_result`
  signs and the majority search-family tool per window — no free-form proposal, no parse-failure
  mode. A TypeScript allowlist gates every delta; it ships with the one key that has a real producer
  today, the other four staying unregistered until their inputs exist. `reflect` no longer
  constructs a gateway client for this path.

- **Proactive advisory surfacing, off by default (#779, #810, THE-634).** A scheduler job gathers
  candidates (changed notes, open contradictions, recent syntheses), scores them against open goals
  per vault, and selects per open session; each selected advisory writes a `chunk_retrievals` row
  (`surface_type` `advisory`) so `record_retrieval_feedback` stamps dismissals unmodified, and
  publishes over a new `subscriptions/listen` extension (silently no-op for legacy LiteLLM-fronted
  clients). Activation's `chunk_retrievals` reads exclude `surface_type='advisory'`, so a
  pushed-but-never-retrieved note cannot gain fake ACT-R activation. New
  `experiential.proactive` block, `enabled` default false.

- **A sanctioned, poison-scanned path for agent-synthesised notes (#814, THE-639).** `write_note`
  and `append_note` gain an optional `provenance: "authored" | "agent_synthesis"` field (default
  `"authored"`, byte-identical for callers that omit it). When `"agent_synthesis"`, the content runs
  through `assessPoison` (THE-238) before any write: high risk is refused with a new
  `content_rejected` code, lower risk writes and surfaces `{risk, signals}` as `poison_assessment`.
  This closes a real gap — these tools previously ran no poison scan at all.

- **Actionable quality data (#813, THE-643).** Three read-only additions over existing schemas:
  `write_note`/`append_note`/`patch_note` return an optional `quality_warning` (a single indexed
  point read after the write; `null` means the rollup never ran, never a false all-clear);
  `obsidian-tc note-quality --suggest` prints one plain-text remediation line per flag without ever
  writing to the vault; and the per-note report gains an `activation_conflict` flag when a note's
  `stale_access` and its aggregate activation score disagree.

- **Vendor-neutral export/import of the derived plane (#808, THE-636).** New CLI-only
  `obsidian-tc context-export`/`context-import` over the nine `experiential.db` tables, producing a
  versioned JSON bundle. Export refuses a destination inside any vault root and always excludes
  blocked/tombstoned episodes; import validates every row against the current schema before any
  write, refuses a `format_version` mismatch, is idempotent via natural-key dedup, and enforces
  forget-wins-over-import in both directions. No new MCP tool and no new migration.

- **Memory entities get a lifecycle — retire, rename, unlink, delete (#795, THE-833).** Entities
  could be created but never removed or renamed. `memory_entities.status`
  (`active`/`retired`, migration `20260814_001`) is the primary reversible path: `get_entity` and
  `query_entity_graph` filter retired entities out by default with an explicit `include_retired`
  opt-in. `rename_entity` moves the materialized note (preserving frontmatter) and re-materializes
  every other entity with a relation to it so their `[[links]]` follow; free-text mentions of the
  old name elsewhere are not rewritten. The append-only philosophy is preserved.

- **`obsidian-tc elicit` — a way to satisfy the confirmation gate (#796, THE-826).** THE-824 made the
  16 conditionally-gated tools advertise their `elicit_token` without giving anyone a way to
  complete it, and MCP elicitation is unimplemented by several clients (Claude Code among them), so
  those operations were unreachable. `obsidian-tc elicit --hash <args_hash> --tool <name>` mints a
  single-use, TTL-bound token bound to the args_hash, vault and caller the gate checks. It is a CLI
  subcommand and deliberately **not** an MCP tool — wiring it as a tool would hand the agent under
  the gate a way to clear its own gate. Minting requires opening the same `cache.db` the server
  reads, which already grants strictly more authority.

- **A root `gateway` config block (`baseUrl`/`token`) (#792, THE-832).** The inference gateway was
  reachable only via `OBSIDIAN_TC_GATEWAY_URL`/`_TOKEN`; a reporter's host app rewrote its MCP
  config on restart and dropped env keys it did not author, silently reverting the URL and leaving
  every generative seam unavailable with no error. `obsidian-tc.config.json` can now set
  `gateway.baseUrl`/`token`, which take precedence over the env vars. An absent block behaves
  exactly as before, and `token` is never threaded into `get_server_config`, so it cannot leak
  there.

- **Differential `vault_context` and persona scoping (#811, THE-647).** `vault_context` now floors
  its `since` against a server-stored watermark rather than trusting the client-supplied cutoff, so
  a client using its own clock (or replaying a stale `since`) can no longer silently and permanently
  lose a changed row past its cutoff.

- **`indexing.chunkTokens` gives the chunk-size budget a config handle (#765, THE-424).**
  `chunkNote()` was always called with no options, pinning the budget at an inline 512 editable only
  in source. It is now threaded from config through every supply point (CLI index, both
  server-runtime and both tool-wiring sites), mirroring `chunkContext`. It also **joins the
  representation fingerprint** and that is the load-bearing half: it is the first axis that changes
  what a chunk *is* rather than what its vector means, so a mixed-budget index must compare unequal —
  otherwise the vec-index refill would repopulate with vectors for chunks that no longer exist.

### Security

- **`end_session` now refuses to end a session belonging to another principal (#803, THE-838).** It
  validated only that the session existed and matched the requested vault — it never compared
  `workspace_sessions.principal` to the calling principal. So any caller holding `write:workspace`
  on a vault could end any session in that vault, and because the handler appends a `session_end`
  record carrying the caller's unconstrained `end_metadata`, could write attacker-controlled JSON
  into **another principal's JSONL trace** — a file that feeds `inferCitations` and session replay.
  Closing someone's session also silently detaches their subsequent retrievals and episodes from
  it, degrading the correlation without erroring.

  The rule is not new; it was applied one verb over and not here. `activeSessionFor` (PR #691)
  resolves a session only on the server-observed `principal`, never the caller-declared `caller`,
  precisely because "a session id is the correlation key for that principal's retrieval history".
  `end_session` never called it and so inherited none of that protection.

  **Affected:** a multi-principal deployment where one caller passes another caller's `session_id`.
  Obtaining the id was a cost rather than a control — ids surface in traces, in error details, and
  in any `admin:workspace` read. **Not affected:** a single-principal deployment, and any caller
  ending its own session.
  **Behaviour change:** such a call now returns `forbidden` instead of succeeding. A client that
  relied on ending another principal's session must stop; there was no legitimate path to it.

  A **NULL** `principal` means *unowned* and stays closable by anyone. That is deliberate: an
  unauthenticated transport writes NULL rather than fabricating a value, and
  `closeStaleImplicitSessions` skips those rows (`principal IS NOT NULL`), so strict equality would
  have left them open forever with no way to close them.

  Reads are unchanged and remain a deliberately different posture: `get_session_traces` is
  `read:workspace`-scoped and does not filter by principal, mitigating the content axis instead by
  stripping captured arguments. See SECURITY.md's store-scope table.

- **The graph-walk ACL filter is now wired into every M7 surface and defaults on (#815, THE-852).**
  THE-695 built and proved the recursive-CTE ACL join but shipped it with zero non-test callers —
  `buildGraphSearchOptions` never set `aclWalkFilter`/`aclSetId`, so `vault_graph_search`,
  `knowledge_search`, `vault_context`, `reflect` and `diagnose_retrieval` all ran the graph walk
  **unfiltered**. That left two live issues: `via_edge.source_path` leaking an ACL-denied
  predecessor path, and an unreadable bridge note acting as a membership/rank oracle. The filter is
  now threaded through every call site by construction rather than by a knob remembered per site.
  **Affected:** any multi-principal deployment using folder ACLs with graph expansion. **Not
  affected:** single-principal or ACL-less deployments.

- **The adaptive-RRF IDF path is ACL-partitioned, closing a cross-ACL term-presence oracle (#830,
  THE-853).** `querySpecificity` computed corpus size and per-term document frequency over the whole
  vault with no ACL partition, so a restricted caller's adaptive-RRF tilt was driven by term
  statistics from notes they cannot read. Fusion now threads the resolved `aclSetId` (or the
  fail-closed `blocked` signal) into it: blocked disables adaptive RRF to neutral weights, a
  resolved set joins `acl_path_members` for the counts, and an unrestricted caller is unchanged. The
  same threading closes two more `bm25Chunks` call sites that always took the over-fetch-then-filter
  fallback and its residual length-interference channel.

- **Captured content is poison-scanned at enqueue, and at commit (#823, #827, THE-855, THE-858).**
  `capture_queue`'s `enqueueCapture` — the stable write contract the ambient capture worker targets
  — ran no poison scan, so untrusted screen text and audio transcripts landed unscanned with no risk
  surfaced to a reviewer. `assessPoison` now runs on every enqueue (the content-derived verdict
  persisted and surfaced in `list_capture_queue` — a caller-spoofable channel-trust score was
  dropped on review); there is no reject-on-high path there because
  `commit_capture` is the gate a human pulls. `commit_capture` then re-scans, because it assembles
  the note from title + tags + caller-supplied frontmatter overrides + content and previously wrote
  those extra channels unscanned: it honours the stored `content` verdict, scans the metadata (title,
  tags, override keys/values, and the target path) on its own, and does so in **separate** passes so
  a single concatenated payload cannot hide one channel behind the 64 KiB scan truncation.

- **`nanoid` floored to ≥3.3.17 (GHSA-2v37-7h3g-55p8, CVSS 8.2) (#766).** A newly published advisory,
  not a regression. The override pins `nanoid` itself (resolving to 3.3.18), not the `postcss` that
  pulls it in — pinning the dependent only hopes it keeps dragging a fixed transitive along. Applied
  in **both** install roots, since a root `bun install` does not reach `docs/`'s separate lockfile.

- **`datasets` floored past PYSEC-2026-3716 (5.0.0 → 5.0.1) (#821).** A newly disclosed Medium
  advisory on the transitive `datasets` pin (via `flagembedding`) in the **optional** bge-m3 reranker
  service. Only `datasets` moves; `requirements.in` is unchanged, since `datasets` is transitive and
  must not be declared there.

### Deprecated

- **The `ollama` embeddings built-in is deprecated (THE-837), and still fully functional.**
  obsidian-tc is provider-agnostic: `providers/registry.ts` registers eight embedding entries and
  the schema resolves `embeddings.provider` against that registry at startup. This built-in is a
  vendor-specific adapter whose wire format the generic `openai-compatible` entry can already
  serve, since Ollama exposes `/v1/embeddings` (OpenAI-shaped, middleware over the same handler as
  `/api/embed`). `doctor` now reports the notice as a **note**, not a warning — a deprecated
  provider is working correctly, and raising the check's status would make a healthy install read
  as faulty.

  **Nothing changes for you yet, and do NOT switch on the strength of this notice alone.**
  `chunk_embeddings.model` stores `provider.id`, which is the vec-index fingerprint, so moving from
  `ollama:<model>` to `openai-compatible:<model>` re-embeds the whole vault. Removal will be a
  major with a migration note; the notice ships first so the decision is not sprung with the
  release.

  `embeddings.provider` still **defaults** to `ollama` (with `nomic-embed-text`, 768) — that is
  unchanged, and it is a config default rather than special-casing.

### Changed

- **The shared embedding transport no longer names any vendor (THE-837).** `embeddings/http.ts` is
  used by every embedding adapter, both reranker adapters and both model-tier service clients, and
  its `providerHint` carried a `provider === "ollama"` branch inside the credential-less slot — so
  one provider of ten got first-run advice ("is it running, is the model pulled") the other nine
  did not. That branch had grown back once already: an earlier revision short-circuited on the same
  name *above* the credential-slot check, reintroducing the wrong-config-block bug the function
  exists to prevent.

  An adapter now supplies its own advice via `credentialLessHint`, and `PostJsonOptions` is a
  discriminated union so that field is reachable only on the `none` slot and typed `never` on the
  other three — the invariant is enforced by the typechecker rather than restated in a comment.
  **Operator-visible behaviour is unchanged**: the Ollama hint still reaches you on a
  credential-less failure, now with the configured model name interpolated rather than a hardcoded
  `nomic-embed-text`. A new standing gate (`check:embedding-transport`) derives its provider set
  from the registry — so a provider added later is covered without editing the gate — and ignores
  comments, which may name a vendor freely.

### BREAKING

- **`plane.enabled` now defaults to `false` (was `true`) — ambient sleep-time consolidation is
  opt-in (#797, THE-825, GH #786).** `plane.enabled` gates the scheduled synthesis/audit passes and the
  per-index-write contradiction judging — every unattended LLM call this server makes over vault
  content. It is inert without an inference gateway configured, so this only changes behaviour for
  **deployments that have a gateway configured (`OBSIDIAN_TC_GATEWAY_URL` or `gateway.baseUrl`)
  and never set `plane.enabled` explicitly.** That is exactly the population that must not be
  switched off silently: a gateway is commonly wired up for an unrelated feature (`reflect`), and
  configuring it is not consent to unattended, whole-vault model calls over what may be private
  content. The reporting operator's vault held personal health and psychological material with no
  ACL restricting it.

  **Affected:** a gateway-configured deployment whose config never mentions `plane.enabled` now
  runs with the plane off, where it previously ran with it on.
  **Not affected:** any deployment that already set `plane.enabled` (`true` or `false`) explicitly,
  and any deployment with no gateway configured (the setting was already inert there).
  **Fix:** add `"plane": { "enabled": true }` to `obsidian-tc.config.json` to restore the previous
  behaviour. A deployment in the affected population gets a one-line notice on the server's stderr
  at boot naming this exact fix — the flip is loud by design, specifically so "why did
  consolidation stop" does not become a silent support path.

  `reflect` (both the tool and the `obsidian-tc reflect` CLI) and `knowledge_challenge` are
  **unaffected** — they read the gateway directly and were never gated by `plane.enabled`.

### Fixed

- **The eval harness's `--gated-rerank` flag now builds the SAME reranker and hardness gate
  production would (#812, THE-806 step 2).** Before this it had exactly one route to a reranker —
  `RERANK_URL`, a Cohere/Jina-shaped `/rerank` HTTP probe — while production selects one from
  `config.reranker` via the provider registry (`cohere-compatible` / `model-tier` / `gateway` /
  `local` / `module`); a golden-set `--gated-rerank` result could only ever describe an HTTP backend
  nothing in a real deployment runs. It also built its hardness gate from a hardcoded
  `{ hardZ: 1.0 }` literal, ignoring `retrieval.gatedRerankHardness` — the config surface THE-806
  step 1 (PR #778) built specifically so the two could construct the same object, a promise that was
  never kept on the harness side. `buildEvalReranker` and `resolveGatedRerankOptions` (both
  `eval/run.ts`) fix both seams: `RERANK_URL` still wins when set (unchanged behaviour for existing
  TEI/vLLM setups), and otherwise the harness resolves `config.reranker` and
  `retrieval.gatedRerankHardness` through the exact functions `runtime/tool-wiring.ts` and
  `retrieval-runtime.ts` call at boot. Measured against THE-705's bundled local reranker for the
  first time: `zMargin@1.0` (the harness's long-standing default) is a **structural no-op** on the
  live bge-m3 corpus — its z1 floor is 1.57, above the threshold — and `cosine@0.55` (production's
  default) shows no significant effect either, well inside a 0.009 nDCG MDE at n=250. No default
  changes; `retrieval.gatedRerank` stays dark. See `packages/server/eval/README.md`'s "gatedRerank
  hardness — calibration and the mode decision" section for the full calibration table and A/B.

- **The MCP error `content[0].text` block now names the offending field, not just the error code
  (#784, #789, THE-823).** Real MCP clients discard `structuredContent` on an `isError` result and render
  the text line alone, so `Error [validation_error]: input validation failed` — with the Zod issues
  that name the offending field living only in the dropped `structuredContent` — was a caller's
  entire diagnostic surface, with nothing to act on. The text now appends the issues (capped at the
  first 5, "…and N more" beyond that) via `z.prettifyError`, which is also the one zod4 formatter
  that renders `unrecognized_keys` usefully (its `path` is always `[]`; prettify reads `issue.keys`
  instead). `structuredContent` is unchanged — still emitted, still carries the full error object.
  Separately, `vault/frontmatter.ts`'s bare `catch` was discarding the YAML parser's own error —
  including the line/column it already computed — before `parseNote` ever threw; it now carries
  that detail into the message. Threading the note's *path* into that same malformed-frontmatter
  error — scoped out of #784 because `parseNote(raw)` had ~19 non-test call sites and none passed a
  path — now lands too (#794, THE-823): the offending note is named, not just the parser's
  line/column.

- **`plane.enabled: false` now also stops the per-index-write contradiction path (#788, THE-822).**
  Disabling the plane already stopped the scheduled consolidation pass, but not the two other
  roles-only consumers — the per-index-write contradiction enqueue and the
  contradiction/synthesis/audit handler registration. So with any gateway configured, a *disabled*
  plane still enqueued and ran unattended per-chunk LLM calls over the whole vault on every index
  write. Both now route through a single `planeGatedRoles()` helper that mirrors the schedule's
  existing gate. `task-call`, `note-quality` and the citation job keep their own separate
  conditions, and `reflect` stays ungated as before.

- **The 16 conditionally-gated tools now advertise their confirmation gate (#790, THE-824).** Tools
  that conditionally demand an `elicit_token` (crossing a folder boundary, an overwrite, a bulk-cost
  floor) advertised none of it: `describe_capability` showed no `elicit_token` input and reported
  `destructive: false`, contradicting the MCP spec's own default of `true` for a mutating tool that
  can demand confirmation. Each now declares `elicit_token` optional and a display-only
  `conditionallyDestructive`. The gate itself is untouched — only what a caller is *told* about it
  changed.

- **`episode_type` is a structural value, not a rendered literal (#802, THE-839).** The dispatch path
  now records `episode_type` structurally (migration `20260816_001`) so a predicate reading it —
  including THE-726's task-verdict window — cannot disagree with the value the code writes; it aligns
  the code with the THE-726 v2 spec's `episode_type = 'tool'`.

- **`rerun` reports `served_from_cache` for an idempotent replay instead of spurious divergence
  (#828, THE-741).** `rerunSession` re-issues each recorded call through the real dispatch, whose
  idempotency gate serves a completed claim's cached result without running the handler — and carried
  no marker, so a cache-served replay matched the recorded outcome and rerun reported it as
  `runnable`, a call that executed nothing. Dispatch now stamps `meta.idempotent_replay` at every
  replay path and rerun classifies such a call under a new `served_from_cache` verdict, excluded from
  both `runnable` and `diverged`.

- **Superseded `cluster_summary` rows are garbage-collected (#829, THE-854).** A pass that changes a
  cluster's membership or a member note's content mints a new `cluster_key` and orphaned the old row
  forever, accumulating garbage in a table that also feeds retrieval's candidate pool.
  `buildClusterSummaries` now deletes this vault's `cluster_summaries`/`cluster_summary_members` rows
  whose key is absent from the current pass — vault-scoped (never another vault's rows) and
  transactional so a crash mid-GC cannot desync the two tables.

- **The coverage-gap sweep scopes its query source per vault (#776, THE-804).** `recentQueries` took
  no `vaultId` yet was called inside the sweep's per-vault loop, so every vault was swept with every
  *other* vault's raw query text — and `GapItem.query` persists that text verbatim into one vault's
  `gap_reports`, so on a multi-vault deployment one vault's queries were readable through another's
  report. Latent rather than live: `gapSweep.enabled` defaults false and `gap_reports` is empty, so
  no shipped report is affected, but the query source is now vault-scoped at the read.

### Changed

- **The three facade triad schemas (`find_capability`, `describe_capability`, `call_capability`) now
  reject an unrecognized envelope key instead of silently dropping it (#784, #789, THE-823).**
  `CALL_CAPABILITY_SCHEMA`'s `args: z.record(...).default({})` was the trap this closes: a caller
  that wrote `arguments` instead of `args` had that key silently stripped (plain `z.object` drops
  unknown keys), `args` fell back to its `.default({})`, and the TARGET tool was dispatched with an
  EMPTY object — so the error the caller saw named the target's own missing required fields, never
  its actual typo. All three schemas are now `z.strictObject`, validated at the top of the `tools/call`
  handler before the old ad hoc `args.name` / `args.args` extraction runs.
  **Compatibility:** a caller currently sending extra top-level keys to any of the three triad tools
  — previously dropped silently — now gets a `validation_error` naming the key instead.

## [1.21.0] - 2026-08-07

### Changed

- **Capture is ON by default under `trusted-local` (#759, THE-540).**
  `experiential.captureContent` and `sessions.traceContent` both moved `false` → **`true`**. Both had
  been held off "until the THE-238 poisoning defence lands"; that defence landed 2026-07-11, and
  THE-238 never contained the red-team the comments named — so the gate was an event no ticket had
  ever owned. The controls that do exist all shipped: layer-1 poison scan on every capture, secret
  redaction, size caps, and traces held in `cacheDir` rather than the vault. The cost of leaving
  them off was concrete: `args_json` NULL on every episode, and `rerun` — 16 commits and 99 tests —
  exiting 2 on every production record because nothing had arguments to re-issue.
  `securityProfile: "hardened"` pins both back to `false`; so does setting either explicitly.
  **This release is what makes that flip real.** The default lives in the published tag, and
  production deploys the tag, not `main` — the change has been on `main` since 2026-08-07 and inert
  in production the whole time.

- **`experiential.activationRerank` now applies a ranking change (#762, THE-424 Part A, THE-535).**
  The flag built the ACT-R cached-activation-score lookup and threaded it to every M7 `graphSearch`
  call site while changing no ranking: the bubble pass fires only when BOTH `activationFor` and
  `opts.bubbleSafe.enabled` are set, and nothing under `src/` set the latter. The M7 options builder
  now sets both together, so one flag governs the whole feature.
  **It still ships `false`** — Part B's A/B (paired permutation surviving BH-FDR **and**
  ΔnDCG ≥ 0.010) is what would move the default. Turning it on closes a
  `chunk_retrievals → recomputeActivation → cached_activation_score → ranking → chunk_retrievals`
  loop, which damps rather than amplifies because the bubble pass is a single pass that moves any
  item at most one position and the multiplier is bounded to `[0.8, 1.2]` at the default `k`.

### Added

- **A ticket-drift gate that can actually fail (#761, #760, THE-540).** Weekly workflow cross-checking
  every `THE-nnn` reference in tracked files against Linear in **both** directions — including the
  closed direction, which nothing had ever checked and which is where THE-238 and THE-222 went
  wrong. Verified end to end across 484 tickets.
- **vec0 KNN latency measurement (#744, THE-419).** The gate could not fire without it.
- **`knip` and `@ast-grep/cli` declared and wired to scripts (#743, #742).**

### Fixed

- **Read-only consumers refuse a stale `chunk_fts` instead of silently mis-joining it (#755, THE-750).**
- **Synthesis reported "(none)" while 159 contradiction checks had no verdict (#740).** Absent and
  negative had been the same rendering.
- **`doctor` misclassified three derived tables (#737),** and the spec is now pinned.
- **`where-symbol` reported `DECLARED 0` for nearly every typed declaration (#739).**
- **`--path-dedup` widened only the graph arm (#752).** The unreproducible headline eval figures are
  withdrawn rather than restated.
- **Densify baseline re-recorded on the CI runner (#745, THE-534).**

### Security

- **`js-yaml` override floor was one patch BELOW the fix for CVE-2026-59870 (#749).**
- **The `sharp` override was the last unbounded one in the repo (#750)** — an unbounded `">=X"`
  forces dependents across majors.
- **Excluded the `lob` secret detector (#748)** — it verified a pytest name as a live key.

### Removed

- **`@modelcontextprotocol/node` (#751)** — never imported, and the docs claimed it was load-bearing.
- **`tslib` and `deleteChunkFtsRowsForVault` (#746)** — two genuinely dead surfaces.

### Documentation

- **The public-corpus eval result is published, and the stale-index diagnosis corrected (#758, #753).**
  An earlier −0.110 "failure" was a stale-index artifact; a public link-structured corpus does exist,
  correcting a "None exists" claim.
- **The LoCoMo column is scored against a key with known errors (#757)** — 6.4% of the key is
  score-corrupting, and the column now says so.
- **The MCP-client compatibility row is re-verified at 1.20.0 (#756),** with why traffic cannot fill
  the rest (the gateway hides `client_name`).
- **Two perf claims went stale when #745 merged (#754); `sync-facts --check` is documented as an
  eval-host step (#747); `reconcile-backlog` keys on blocker GRAMMAR rather than STATE (#741); the
  outcome-axis claim is retired and two dead eval references repointed (#738).**

## [1.20.0] - 2026-08-06

### Added

- **`rerun` — re-run a recorded session against current vault state (#722, #721, #720, THE-645 item
  3, THE-736, THE-737).** A session trace records what was dispatched; `rerun` replays it and
  reports divergence. `sessions.traceContent` gates whether arguments are captured at all and is
  **off by default** pending the THE-238 poisoning red-team, so on a default deployment every
  recorded call classifies `no_capture` and nothing is re-executed — that is the designed state, not
  a failure. Session traces also moved out of the vault into `cacheDir`, because `.obsidian-tc/` was
  not in `DEFAULT_DENY_ROOTS` and traces were readable through `read_note`.

- **`explain_answer` — the retrieval → chunk → citation → episode lineage chain (#705, THE-646 item
  2).** What an answer actually used, rather than what was retrieved.

- **`inspect_visibility` — why a tool is or is not offered (#718, THE-645 item 2).**

- **Per-vault score calibration, and the confidence it makes possible (#711, THE-733, THE-631 item
  1).** `gaps --calibrate` printed a distribution and returned, so no percentile existed at query
  time and the only number reachable from the request path was a global constant from an n=136
  calibration on one vault. The distribution is now persisted with provenance (engine version,
  config fingerprint) — a distribution is only valid for the engine that produced it.

- **Note staleness on the coverage estimate (#704, THE-631 item 2).**

- **The citation pass finally has a producer (#708, #709, #707, THE-717).** A JSONL transcript seam,
  a durable scheduled job, and a run log so "the pass never ran" and "the pass ran and stamped
  nothing" stop being the same observation.

- **Operation-aware authorization (#697, THE-727).** Policy resolves from the CALL, not only the
  definition — the prerequisite for merging read+write tools.

- **The vault watcher is enabled on Windows (#715, THE-657).** The crash was an 8.3 short path
  reaching libuv, not recursive `fs.watch`.

- **`ToolAnnotations.idempotentHint` (#733, THE-743).** Emitted only for mutating tools, from an
  explicit per-tool declaration — never inferred from `acceptsIdempotencyKey`, which is a different
  claim (a retry is safe *when the caller supplies a key*, and the key is optional).

- **Per-decision eligibility reasons (#733, THE-746).** `evaluateEpisodes` records which rule
  produced each verdict, plus a versioned policy id so a later rule change is distinguishable from a
  data change. Held rows record a reason too — they stay `pending`, so without one "never evaluated"
  and "evaluated and held" are indistinguishable.

- **`experiential.activationDecay` (#733, THE-644 item 3).** The ACT-R decay exponent, finally
  reachable from configuration. Every layer below already accepted a `decay` and nothing supplied
  one. Weight falls as `days ** -decay`, so higher means faster forgetting: ~0.3 for a reference
  vault, 0.5 default, ~0.8 for a journal.

- **Two developer lookups (#726, #735).** `where-symbol` separates a symbol's declarations and uses
  from prose that merely mentions it; `migration-impact` lists the hand-built test migration chains a
  new migration affects, because 62 test files build their own chain and nothing gated them.

### Changed

- **`chunk_retrievals.outcome` is RETIRED (#731, THE-718).** It asked a task-level question of a
  response-level row, so one task's verdict was attributed to every chunk a search happened to
  return — no denominator, no estimand. Measured 0 stamps across 108 rows, and the tool was
  unreachable until 2026-08-03, so the zero was never evidence about adoption.

  `agent_episodes.outcome` is **kept and renamed `task_result`** — an episode *is* the task, so the
  axis is coherent there; only the name was wrong.

  **`note_quality` scoring changed as a consequence.** It divided citations by *all* retrievals, so
  an unjudged retrieval entered the average as a citation of zero — the "call every unread note bad"
  failure its own docstring exists to prevent. The denominator is now `observed_retrievals`, and
  zero observations scores NULL rather than mid-range. `SCORE_VERSION` is 2; rows scored under the
  old formula keep version 1.

  **`record_retrieval_feedback` no longer accepts `outcome`**, and `feedback` is now required. Under
  `.strict()` a client still sending the retired field gets a hard rejection rather than a silent
  drop.

- **Sparse weights are stored PACKED, not as JSONB (#727, then #729, THE-711).** Both landed in this
  release and the second replaces the first: #727 stored weights as JSONB on the reasoning that
  `json_extract` got faster, but `sparseSearch` never calls `json_extract` — it selects `weights`
  and `JSON.parse`s them, so JSONB added a binary→text render and measured **12.6% slower**
  (207.1ms → 233.3ms). #729 replaced the representation entirely with a packed
  `[u32 count][u32 id×n][f32 w×n]` blob scored by merge-intersection. Anyone reading #727 alone
  would have the wrong picture of the shipped state.

- **`chunk_fts` is contentless, keyed on the chunks rowid (#728, THE-711).** The FTS index carried a
  second copy of every chunk body. It now stores none, resolving matches back through the rowid.
  Note the shape change is invisible to a naive test: under `content=''` a query like
  `SELECT count(*) FROM chunk_fts WHERE path = ?` matches zero **unconditionally**, so an assertion
  written that way passes vacuously whether or not the index works.

### Fixed

- **A judge that did not ANSWER is no longer counted as one that answered unparseably (#732, #734,
  THE-717, THE-613).** `parse_failures` merged transport failures with unparseable replies, which
  have opposite remedies. Both live citation passes logged 3/3 "parse failures" that were every one
  of them an HTTP 404 from a retired inference deployment — the log sent an operator to debug prompts
  for three days. The kill switch still trips on the SUM, because splitting the counters without
  that would let an all-404 pass compute 0/N and abort nothing. The same conflation is fixed in the
  contradiction judge, which shares the role.

- **An invocation that plans zero passes now records that it ran (#733, THE-744).** `openCitationRun`
  is per-entry, so a pass over an empty transcript index wrote nothing at all and
  `SELECT * FROM citation_runs` — the documented way to ask "did it ever fire?" — answered no.

- **`busy_timeout` is installed before any pragma that can contend (#723, THE-745).** A WAL
  conversion under contention needs an EXCLUSIVE lock; applied after `journal_mode=WAL`, the timeout
  could not protect the very statement that most needed it.

- **`--acl-allow` silently dropped 53% of ground truth on a path separator (#710, THE-695).**

- **The stage-2 judge fan-out is bounded and the kill switch has a floor (#703, THE-621).**

- **`reflect --max-judged` outlived the judge it capped (#724, THE-747).** Parsed, validated,
  advertised in `--help`, consumed by nothing.

- **A nameless job spec is refused at registration (#701, THE-715 item 3).**

- **Rerun hygiene: WAL staging, audit attribution, policy refusals, exit codes (#730, THE-738,
  THE-739, THE-740, THE-742).** `--sandbox` copied a live WAL database without its sidecars, so the
  staged copy lagged the real one; it now uses `VACUUM INTO`. Replayed calls are marked in the audit
  log rather than being indistinguishable from real traffic, and "refused by rerun's own policy" is
  no longer reported as "vault state diverged".

- **doctor: the entity tables have a writer (#702, THE-629); `job_schedule` orphans are pruned and
  the experiential charter is stated (#700, THE-715, THE-713).**

- **Release and CI: draft-release no longer races itself on the plugin zip, and the release is
  verified whole (#695, THE-731); the quiet-host perf calibration is keyed by CPU architecture
  (#699, THE-510).**

## [1.19.0] - 2026-08-04

### Added

- **The HTTP transport can now carry a workspace session, and optionally opens one itself
  (#691, #692, #693, THE-726).** `session_id` was NULL on 100% of live rows — 0 of 97
  `chunk_retrievals` and 0 of 365 `agent_episodes` — and three tickets read that as a client
  problem: nothing calls `start_session`. It was not.

  ```
  grep -c "sessionId\|activeSessions" packages/server/src/transports/http.ts   ->   0
  ```

  The HTTP transport never populated a session at all. Only the stdio context factory read
  `ActiveSessionTracker`, and that tracker's own docblock describes it as *"process-local and
  best-effort: not persisted"*. Deployments reached over HTTP therefore could not produce a
  non-NULL `session_id` no matter what any client called — adoption was structurally incapable of
  fixing it.

  Three changes, in order:

  - Migration `20260804_001` adds `workspace_sessions.principal`, and `activeSessionFor` resolves a
    principal's open session durably from SQLite rather than from an in-memory map. `principal` is
    the server-**observed** `ctx.caller`, deliberately distinct from the existing `caller` column,
    which is the caller-**declared** `input.caller`. Resolving on the declared column would let any
    client holding `write:workspace` name another principal and inherit its session id — and a
    session id is the correlation key for that principal's retrieval history.
  - An end-to-end suite over a live server proves a dispatch actually lands a non-NULL
    `session_id` in `chunk_retrievals`, asserting the stored row rather than the context object.
  - **New config block `sessions`.** With `sessions.autoOpen` on, the first authenticated dispatch
    from a principal with no open session opens one, so correlation no longer waits on a client
    change. The maintenance sweep closes server-opened sessions older than `sessions.windowSeconds`
    (default 1800) and reports them as a new `sessions_closed` count; a session a client opened
    deliberately is never closed by the sweep.

  **`sessions.autoOpen` defaults to `false`, and enabling it is a deliberate decision.** Session
  correlation changes what this server retains about who read what. A config that says nothing gets
  the non-correlating behaviour, and nothing about this release changes existing deployments'
  observable behaviour until the flag is set.

  **Operator note:** a server-opened session is a bounded *activity window*, not an idle timeout. A
  task spanning a window boundary splits across two sessions. That is the deliberate trade for
  needing no `last_activity_at` column and no write in the read path.

  Pre-migration rows have `principal` NULL, which makes them unresolvable rather than
  resolvable-as-someone. Nothing is backfilled: copying `caller` across would manufacture exactly
  the collapse the new column exists to prevent. stdio behaviour is unchanged.

## [1.18.0] - 2026-08-04

### Fixed

- **The scheduler's backoff cap had become a global 5-minute ceiling on every background job
  (#687, THE-723).** `effInterval` computed `Math.min(intervalMs * 2 ** failures, maxBackoffMs)`.
  That is a backoff cap only while `intervalMs <= maxBackoffMs`; above it, and with zero failures,
  it reduces to `min(intervalMs, 5min)` — and `effInterval` computes *every* next-run, including the
  success path. A backoff cap shorter than the base interval does not slow a failing job down, it
  speeds every slow job up.

  Measured on a live store via the scheduler's own `job_schedule` table: `plane-enqueue` (configured
  240 min), `maintenance-sweep`, `activation-recompute`, `note-quality-enqueue`, `goal-expiry` and
  `episode-evaluation` (all 60 min) were every one of them running at ~300s. Only
  `job-queue-runner` (15s) was correct, because it sits below the cap.

  Now `Math.max(backoff, intervalMs)`: backoff still grows exponentially and is still bounded by
  `maxBackoffMs`, but can never schedule a job sooner than its own interval.

  **Operator-visible:** background jobs now run at the cadence you configured, which is *less often*
  than 1.17.x ran them — up to 48× less for the consolidation plane. That is the documented
  behaviour being restored, not a regression. `job-queue-runner` is unchanged, so queued work still
  drains every 15s and nothing user-facing gets slower.

  It survived since THE-462 because every test in `scheduler.test.ts` registers `intervalMs: 1000`,
  entirely below the cap — the region where `Math.min` always picks the interval and the clamp
  cannot fire. The new gate deliberately registers a 60-minute interval and says so in a comment.

- **The plane re-ran its own completed once-per-period work on every tick (#687, THE-723).**
  THE-700 set `replaceIfTerminal: true` on the two period-keyed plane jobs so a failure would not
  cost the whole period. But `enqueue()` treats `complete` as terminal too, so each tick deleted and
  re-enqueued work that had already succeeded, and the ISO-week and per-day idempotency keys
  throttled nothing in either direction. This regressed a contract the option's own docblock states:
  *"a completed weekly synthesis must block re-runs"*.

  Compounded with the clamp above, `audit_reports` went from 2 writes/day to **243**. New
  `EnqueueOptions.replaceIfFailed` is the narrow form — replaces a `failed` row, still dedups against
  `complete`. `synthesis` and `audit` use it; `contradiction` keeps `replaceIfTerminal`, where its
  key is content-hashed and replace-on-complete is deliberate.

## [1.17.1] - 2026-08-04

### Added

- **`audit.kbHealth` — a reader for the 302 audit reports nothing could read (#684, THE-722).** The
  `audit` plane job had written `kb_health` reports since the plane shipped, and no code path
  anywhere read one back. A table that is written and never read is indistinguishable from a table
  that is broken, so the reports were both useless and unfalsifiable. `doctor` now surfaces the
  latest report, its age, and whether it flagged issues.

- **`check:table-readers` — a CI gate for write-only tables (#683, THE-722).** The blind spot that
  let the above persist: every existing liveness check asks whether a table is *written*, and none
  asked whether anything *reads* it. This gate fails when a table has a writer and no reader,
  carrying an explicit allowlist for tables that are deliberately write-only. Watched failing
  against `audit_reports` before it was trusted, and it holds a non-empty floor so a scan that
  matches nothing cannot report success.

### Fixed

- **`job_runs` was empty while 128 jobs had completed (#685, THE-716).** `wrapPlaneJob` stopped
  calling `recordRun` during the THE-625 durable-queue migration, so the plane's own run ledger
  recorded nothing for every job that ran through the queue — which, after that migration, was all
  of them. The recorder was still there, still correct, and simply on a path nothing used any more.
  Runs are now recorded before a handler can throw, so a *failed* pass leaves a row too; a ledger
  that only records successes cannot answer the question it exists for.

## [1.17.0] - 2026-08-04

### Added

- **Liveness reporting: three new `doctor --probe` checks.** A feature can have a config key, a
  migration, an implementation and passing tests and still have never written a row in *this*
  deployment, and until now nothing reported that. A census on 2026-08-03 found four empty derived
  tables in production, none of them visible from inside the system.

  - **`derived.liveness` (#672)** — is each derived table actually being written? Classified, not
    counted: `rows > 0` is live, empty-and-disabled is expected, empty-and-enabled is a warning,
    and empty-with-no-writer is a different warning again. The classification is the whole feature —
    a first pass that warned on every empty table produced eleven warnings on a healthy install.
  - **`entrypoints.liveness` (#674)** — the verb-side companion: which scheduled passes actually
    succeed, and how much of the tool surface has ever been invoked. `derived.liveness` cannot tell
    "nothing enabled the writer" from "the writer runs and loses every time"; only the schedule row
    separates those, and they need opposite fixes.
  - **`derived.column-liveness` (#680, THE-720)** — the half a row count structurally cannot see.
    `chunk_retrievals` held 97 rows for 18 days and reported `live` the entire time while `outcome`
    and `feedback` were NULL on all 97. On its first run against the live store it found two columns
    with no producer at all (`agent_episodes.outcome` and `.summary`, 0 of 363 each).

- **Five new tools (157 total).**

  - `work_episode_chain` and `episode_stats` (#673, THE-655/THE-642) — the experiential read
    surface: walk an episode's amendment chain, and an aggregate view that does not require
    `admin:workspace`.
  - `set_goal` / `list_goals` / `close_goal` (#675, THE-633) — stated goals. The experiential plane
    had preferences but no goals, so nothing could be retrieved or surfaced against what the user is
    actually trying to do.

- **The coverage-gap sweep can be scheduled (#675, THE-719).** `detectGaps` was reachable only from
  the CLI, so `gap_reports` was empty and THE-631's percentile confidence had no per-vault baseline.
  Behind `experiential.gapSweep`, default off.

### Fixed

- **`record_retrieval_feedback` was unreachable, and failed silently (#677, THE-718).** Measured
  against the live store: `session_id` is NULL on 97 of 97 retrieval events, because nothing calls
  `start_session` (THE-714). The handler appended `AND session_id = ?` for any non-elevated caller,
  so the narrowing matched **zero rows** — `admin:workspace` was the only principal that could stamp
  anything, and a client doing everything correctly received `{ available: true, updated: 0 }`: the
  response shape of a successful write, with no error and no reason.

  A retrieval logged outside any session belongs to no session, so `session_id IS NULL` is now in
  scope and ownership is carried entirely by `caller`. Rows that *do* carry a session stay reachable
  only from that session, and the THE-568 caller partition is untouched. A no-op now names its
  reason (`session_scope` / `no_owned_retrievals`), computed only over rows the caller already owns
  so it cannot become an existence oracle.

- **`preference_profile` / `preference_deltas` are namespaced by vault (#675, THE-710).** The
  derived-plane namespacing of THE-563/564 skipped them, so with two vaults configured one vault's
  learned preference silently overwrote the other's under the same key, with no column to filter on.
  Migration `20260803_001` rebuilds both with `vault_id` leading the primary key. Existing rows are
  **purged rather than backfilled** — a preference's originating vault was never recorded, and
  inventing one would be indistinguishable downstream from a real attribution.

### Security

- **`NULL` is no longer accepted as a principal identifier (#677, THE-718).** `CallerContext.caller`
  is `string | null`, and a *valid* JWT with no `sub` claim yields `caller: null` with
  `authenticated: true`. Since SQLite's `IS` binds NULL as a value, `AND caller IS ?` matched every
  row predating the THE-568 caller column — 81 of 97 on the live store, retrievals no principal is
  attributable for. A non-elevated caller whose identity is not a non-empty string is now refused;
  `admin:workspace` remains the way to touch unattributed rows deliberately.

  This reverses a branch-coverage assertion that read "a null-caller principal stamps only
  null-caller retrievals it owns". `session_id` is caller-supplied and unvalidated, so "its own
  session" reduced to "only if it guesses the session id" and was never a boundary.

- **Seven dependency advisories cleared across both install roots (#679).** `fast-uri` host
  confusion (high, both roots), three `ip-address` SSRF/trust-boundary misclassifications (one high,
  two moderate), PostCSS arbitrary `.map` read, and a Hono CORS ReDoS. All are floor bumps inside
  existing bounded overrides, except `ip-address` which gains one — bounded `<11` rather than a bare
  `">="`, which would drag dependents across a major to satisfy a patch advisory.

### Changed

- **`record_retrieval_feedback` says when to call it (#678, THE-718).** Its description opened on
  storage mechanics and spent most of its length on an authorization model the caller cannot act on;
  it told an agent what the tool did and never that it was expected to use it. It now leads with the
  trigger, asks for `-1` on a confidently-wrong chunk because a negative beats silence, and
  documents the `reason` field. One clause is added to the `server/discover` instructions too — a
  client in triad/domain facade mode never sees individual tool descriptions, because `tools/list`
  advertises three meta-tools.

## [1.16.0] - 2026-08-03

### Fixed

- **Consolidation jobs get a per-attempt gateway timeout (THE-709).** Weekly synthesis had never
  once succeeded on a live deployment: `syntheses` sat at 0 while jobs died at **370.435 s and
  370.423 s** — 12 ms apart, which is 6 x a 60 s client budget expiring, not a varying cold start.
  The endpoint answered a small completion in 360 ms throughout. `plane.gatewayTimeoutMs` (default
  300 s) now bounds each attempt rather than the whole run.

  This matters more than a timeout usually would because the synthesis job is `max_attempts = 1`:
  every week that timed out was lost permanently rather than retried.

### Changed

- **Citation stage-1 is ~24x faster (#669).** Three fixes to `inferCitations`, all measured on real
  vault content (60 chunks x 6000 transcript tokens):

  - The transcript was **re-tokenized for every chunk** — a lowercase pass plus a global regex over
    the whole transcript, per chunk, producing the identical array each time. `prepareTranscript()`
    does it once.
  - The ROUGE-L DP compared **JS strings** in its innermost cell. Interning to `Int32Array` takes it
    from 62.6 to 41.0 ns/cell.
  - The cosine leg called `cosineSimilarity` once per **(block, chunk) pair** — up to 48 native
    crossings per chunk, and that export marshals a fresh `Vec<f64>` each call. This is the exact
    shape THE-420 measured as *slower* than the JS fallback, sitting inside the per-chunk loop. One
    `cosineBatch` crossing per chunk instead: **55.60 ms -> 3.51 ms, crossings 2880 -> 60**.

  End to end: **3381.8 ms -> 141.0 ms**, with 0/60 scores differing (maxDelta 0). Note the TS-only
  portion of that is 1.26x; the rest is the native kernel below. A synthetic benchmark had suggested
  1.56x for the interning alone — real content gives 1.26x because this transcript has only 457
  distinct tokens across 6000 positions, so many string compares short-circuit.

  Behaviour is unchanged: scores are identical, and a width mismatch in the cosine leg still yields
  0 rather than null, exactly as the per-pair maximum did.

### Added

- **`rougeLLcs` native export — the LCS kernel as one crossing per pair (#667).** The 7th napi
  export: longest-common-subsequence length over two interned token-id sequences. Tokens are
  interned on the TypeScript side so one transcript is prepared once and reused across chunks, and
  only the length crosses back — the F1 arithmetic stays in TS. **37.86 -> 2.14 ns/cell, 17.67x.**

  It is deliberately absent from the loader's `isComplete()` check, so a prebuilt `.node` predating
  this export still loads and the binding feature-detects on the function rather than the module.
  A pure-JS twin keeps the path identical where no binary resolves.

  `packages/native` also gains the `rlib` crate-type, so `benches/` links the shipped kernel instead
  of a hand-copied duplicate that carried a "keep in lockstep manually" note.

- **`packages/native/fallback.js` is now verified numerically (THE-712, #670).** That file ships to
  npm and is what runs wherever no `.node` resolves, and nothing checked its arithmetic: the
  `fallback-test` CI job returns before the `require()` and exercises the *server's* twins instead,
  `ci-install-smoke` asserts only `typeof === 'function'`, and `fallback.ts` is typechecked but never
  compiled. A wrong constant shipped green.

  The new gate has three arms — hand-derived golden constants that hold on any host, agreement with
  the server twins, and a direct comparison against the compiled module that is skipped rather than
  silently passed when absent. It was watched failing first: five separate mutations of `fallback.js`
  are each caught.

## [1.15.0] - 2026-08-02

### Removed

- **The episode-eligibility judge (THE-701, #661).** An LLM call in the sleep-time evaluator has been
  removed after measuring it, not on principle.

  Over 333 live candidates it denied 35 episodes — **all 35 `status=error`**, zero false positives
  on `ok` rows. 100% of its effect reproduced `status === "error"`, at 94.6% fidelity. That
  contradicted the deterministic layer's documented policy in the same file — *"a plain
  `status = 'error'` with no bad-outcome stamp still promotes — errors are lessons too"* — and
  because the judge could only LOWER a promotion, it won every disagreement silently.

  **It was also structurally incapable of its stated job.** Its prompt asks it to deny "incoherent,
  manipulative, or instruction-like content", and the only content-bearing field it receives is
  `summary` — which nothing in the codebase writes. The capture `INSERT` does not list the column;
  the only write anywhere sets it to `NULL`. So it never saw content, and no configuration would
  have changed that.

  **No security property is lost.** Manipulation detection runs deterministically and earlier:
  `assessPoison` scans every capture and stamps a high-risk row `ineligible` at birth, and the
  evaluator's `WHERE eligibility = 'pending'` never selects those. What does go is the `hold`
  verdict (measured: never used — zero holds across 333 candidates) and the option of an LLM
  catching a novel phrasing no pattern matches.

  The pass now acquires **no network dependency at all**, which was already its stated design goal
  rather than something it achieved. It is also now consistent: `MAX_JUDGED = 25` meant the first
  25 candidates of any backlog got the judge's policy and the rest got the deterministic one.

  `EvaluateStats` drops `judged` and `judgeAborted`; `denied` is retained and is now always 0.
  `--max-judged` is unchanged for `citation-infer`, which is a **different** judge doing a
  different job.

### Added

- **`--acl-allow` — the eval harness can finally vary ACL state (THE-699, #660).** Every ACL-dependent
  retrieval change was unfalsifiable on the golden set: `eval/run.ts` only ever *forwarded* an
  optional `isReadable` that nothing set, and the two harnesses that did set it
  (`densify-index.ts`, `perf/harness.ts`) set it to `() => true` — a constant that makes the filter
  a no-op. **An ACL filter that works and one that is completely inert produced identical numbers**,
  which left THE-694 and THE-695's shipped changes impossible to verify in either direction.

  The predicate is built from the **production** `FolderAcl` through `makeIndexReadable` — the same
  factory the boot reconcile, `add_vault` and the index-on-write hook use. A hand-rolled predicate
  would be a second implementation of the authorization boundary, free to drift from the one that
  ships, which is the same defect one level up. It is a read *whitelist* rather than a deny list
  because that is what `readPaths` actually is, and comma-separated because `readPaths` is an array.

  **The ground truth is restricted by the same predicate.** Metrics score against expected PATHS, so
  running retrieval under an ACL while leaving the qrels alone collapses recall — the expected set
  would name documents the caller may not see, and that reads as a catastrophic regression rather
  than a broken measurement.

  Queries left with no reachable target are **excluded, not scored zero**. `metrics.ts` computes
  `expectedTotal > 0 ? found/expected : 0`, so an empty expected set scores a guaranteed 0 that is
  indistinguishable from genuinely missing everything. Measured on the live corpus: including them
  reported recall@10 0.667 and bridge recall 0.310; excluding them reports **0.830** and **0.724**
  over n=87. Same run, ~20 points apart. Dropping them is also standard practice — a topic with no
  relevant documents in the collection is excluded from evaluation, not scored against it.

  A run is **refused** when fewer than a third of queries keep a reachable target. The first real
  run of the flag left 185 of 216 (86%) empty and would still have emitted a full report — a number
  that reads as a measurement and is not one.

### Fixed

- **The model service answered 500, not 401, for an `Authorization` header carrying a raw byte
  `>= 0x80` (THE-704, #663).** `hmac.compare_digest` refuses a `str` with any non-ASCII character —
  it raises `TypeError` rather than returning `False` — and Starlette decodes header bytes as
  latin-1, so one high byte on the wire became an unhandled exception on a path any unauthenticated
  caller can reach. Fail-closed throughout (the raise preceded any comparison, so nothing leaked and
  no timing signal existed), but a 401 is the honest answer. It compares bytes now.

  A conventional client cannot reach it — `httpx` encodes header values as ASCII and raises
  client-side — which is why it sat unnoticed. Raw bytes on the wire are another matter.

  The same fault also meant a **non-ASCII `auth_token` in config could never authenticate at all**,
  since the `TypeError` fired on the matching path too.

  Nine tests now cover the bearer comparison, six of which fail against the old code. Before this,
  the only auth assertion in the suite sent no header at all, so `compare_digest` itself — the one
  line here carrying a security rationale comment — had never been exercised.

- **The documented companion-plugin route table was 11 routes and 3 verbs behind the code
  (THE-703, #662).** `ARCHITECTURE.md` §3.1 listed 17 routes across 9 families; the companion
  ships **28 across 15**. `git` (5 routes), `remotely-save` (2), `omnisearch`, `datacore`,
  `metadata-menu` and `daily-notes` were absent entirely, and `/commands/list`, `/templater/list`
  and `/quickadd/actions` were documented `GET` while shipping `POST` — they take a JSON body, so
  anyone integrating against the block as written would have gotten a 404 on three endpoints.
  `CAP_IDS`' documented location and key set were stale by the same margin (7 keys, at a path it
  had moved from; it has 12).

  The wiki pages covering the same surface were already correct, which is why this survived: the
  drift was confined to one file that nothing checked.

  A `check:plugin-routes` gate now runs in CI's `lint` job. It derives both sides — the `RouteDef`
  literals and the documented table — and diffs them in both directions, so a new route family is
  covered rather than silently exempt and a verb-only change is caught. Both sides are floored: a
  moved directory or a reworded heading fails loudly instead of comparing two empty sets and
  passing.

- **Every scheduled consolidation pass died on a serverless cold start, and one failure cost the
  whole period (THE-700, #659).** Two independent single-shot budgets stacked badly. The gateway client
  allows 3 attempts x 60s; the models behind the gateway roles scale to zero and a cold start was
  measured at **over 180s**, so the whole budget expired before the endpoint woke. The same request
  against a warm endpoint takes **4.8s** — this was never about the workload.

  Worse, `enqueue()` dedups against a *terminal* row unless `replaceIfTerminal` is set, and the
  plane schedule did not set it. So the `failed` row kept `synthesis:<iso-week>` and every later
  enqueue that week was a **silent no-op**: a single cold-start timeout locked out the entire
  week's consolidation, and clearing it required deleting the row by hand.

  `plane.gatewayMaxAttempts` (default 6) now gives the background plane its own retry budget —
  365s, past the observed cold start — while the interactive seam keeps 3 attempts, because a
  six-minute budget is right for a weekly pass and absurd for a user-facing call. More **attempts**
  rather than a longer per-attempt timeout: each attempt still fails fast while the endpoint warms
  between them, whereas widening the per-attempt budget would hold the caller through the entire
  wake-up. The plane's enqueues now set `replaceIfTerminal`, so a failed period is retried on the
  next tick instead of being locked out until the key rolls.

  **Not** a `ping()`-based pre-warm, which was the obvious idea and is wrong: `ping()` hits
  LiteLLM's `/health`, and LiteLLM health-checks *every* configured model — measured at 60.8s
  across 470 models spanning 9 providers. Warming one endpoint that way would issue real billable
  calls to every unrelated vendor.

## [1.14.3] - 2026-08-02

### Fixed

- **The weekly synthesis job stopped producing anything — its prompt had no aggregate bound (#657).**
  `RECENT_LIMIT` (200 chunks) x `CONTENT_TRUNCATE` (1000 chars) is a **per-item** cap, not a budget:
  200 chunks each under the per-item limit is still 200,000 characters. In production the built
  prompt reached 169,258 chars and every run failed with
  `litellm.ContextWindowExceededError` — measured at **51,380 tokens against a 32,768-token serving
  window**, 1.57x over. `syntheses` sat at 0 rows as a result, and the failure was terminal by
  design (`maxAttempts: 1`, because a 4xx is an answer and retrying identical oversized input only
  burns quota), so it could never self-heal.

  `plane.maxPromptChars` (default 60000) now caps the **whole request**, system prompt included.
  Contradictions are filled first — the output schema requires the model to cite
  `contradiction_ids`, so dropping them silently would ask for citations of evidence never supplied
  — and chunks take the remainder, since they are already a "newest 200" sample where using fewer is
  a smaller sample rather than a missing input. Whole items are dropped, never half-rendered: a
  partially rendered chunk misrepresents what a note says, and cross-note patterns are drawn from
  exactly that content. The per-chunk trim now uses `trimToBoundary` (the same helper the shared
  evidence builder uses) instead of a hard slice, because cutting mid-word reads to a model as though
  the source itself is malformed.

  **The drop is reported, not silent.** The job's result carries `chunks_used` / `chunks_dropped` /
  `contradictions_used` / `contradictions_dropped`, and logs a line naming the config key when
  anything is dropped. A pass that quietly used 9 of 200 chunks would otherwise be indistinguishable
  from one that used all 200 — which is the same class of defect as the missing bound.

  Sized in characters rather than tokens because no tokenizer is available on this side. Measured by
  bisection against the live endpoint: **3.294 chars/token** on real vault prose (107,475 chars =
  32,625 tokens). Dense content — code, CJK — runs nearer 2.5, so 60000 is ~18.2k tokens of prose
  or ~24k of code, both leaving room for the model's own JSON output inside a 32,768 window.
  Verified end to end against the endpoint that rejected the old prompt: **HTTP 200, 17,757 prompt
  tokens, 15,011 left for output.**

  **The 32,768 is the server's limit, not the model's.** Qwen3-4B-Instruct-2507 is natively 262,144;
  vLLM's `--max-model-len` is an operator-set memory lever. The ceiling can therefore move without
  the model changing, which is exactly why this side bounds its own prompt rather than inferring a
  limit from a model name — and why the cap is configurable rather than hardcoded.

## [1.14.2] - 2026-08-02

### Fixed

- **The Windows standalone binary now builds at all (#654).** `gen-embedded-vec.mjs` shelled out to
  `npm pack` through `execFileSync`, which cannot work on Windows in either form: `execFileSync`
  does not go through a shell, so `npm` is `ENOENT` (there is only `npm.cmd`), and `npm.cmd` is
  `EINVAL` because Node refuses to spawn `.cmd`/`.bat` without `shell: true` (CVE-2024-27980).
  Setting `shell: true` would fix it by re-joining argv into a single command string — the precise
  thing that CVE was about — so the subprocess was removed instead: the tarball is fetched from the
  registry over HTTPS.

  That is also strictly safer than what it replaced. The registry returns `dist.integrity`, so the
  downloaded tarball is now **verified** (sha512); `npm pack` was checking nothing here.

  This had been broken since THE-663 introduced the script and was undiscoverable: `build-binaries`
  lives in `publish.yml`, which only fires on a tag. On the v1.14.0 tag the Windows job was
  **cancelled** by the darwin failure rather than run, and a cancelled job is not a verdict — so
  v1.14.1 was the first time it ever reached one.

### Added

- **`embed-codegen` — the release-only codegen now runs on every PR, across Linux, Windows and
  macOS (#654).** Both `gen-embedded-vec.mjs` and `gen-embedded-sqlite.mjs` previously executed nowhere
  except a tag build, which is how three independent bugs in that path (the darwin loader, the
  Windows `npm.cmd` resolution, and a `CANCELLED`-masks-everything matrix) all reached a published
  tag before anyone could see them.

  It deliberately does **not** compile — `bun build --compile` costs minutes per target and
  `build-binaries` still covers it at tag time. What actually breaks in these scripts is the codegen:
  npm resolution, platform-package fetching, cross-arch toolchain invocation. Running only that costs
  seconds. It asserts the produced file's **size**, not the exit code, because the checked-in
  placeholder is itself a valid file — and separately asserts that `HEAD`'s copies are still the
  empty placeholders, so a generated binary can never be committed and shipped to every platform.

## [1.14.1] - 2026-08-02

### Fixed

- **The macOS standalone binaries can load `sqlite-vec` at all now — dense retrieval was silently
  off on every darwin release (#652).** `bun:sqlite` uses **Apple's system SQLite**, built without
  extension support, so `db.loadExtension()` fails there no matter how correctly `vec0` is embedded:

  ```
  This build of sqlite3 does not support dynamic extension loading
  ```

  measured directly on `macos-14` and `macos-26` runners. THE-663 fixed the *embedding* (and the
  linux binaries genuinely do report `vec=on`); the *loader* was a second, independent blocker that
  only darwin has. It surfaced in v1.14.0 because that was the first time THE-663's smoke gate ever
  executed — it lives in `publish.yml`, which only runs on a tag, so no PR could have caught it.

  The darwin binaries now carry a universal2 vanilla SQLite 3.53.4, materialized to a private temp
  file at startup, and `Database.setCustomSQLite()` points `bun:sqlite` at it before any database is
  opened. `openBunSqlite` is the only `new Database(...)` in the tree, so that ordering requirement
  is satisfied at one call site. Guarded on darwin *and* a non-empty embedded constant, so linux,
  windows, `bun run`, the npm dist build and every test suite are untouched.

  Universal2 rather than a thin per-target build because GitHub no longer offers an x86_64 macOS
  runner: `bun-darwin-x64` is cross-compiled on an arm64 host and never executed in CI. Both darwin
  targets embedding the same fat dylib means the arm64 slice is runtime-tested every release, and a
  future drift in the host-to-target mapping cannot ship arm64 code inside the x64 binary.

  **Effect on upgrade:** macOS users of the *standalone binaries* gain dense retrieval, which was
  previously falling back to the brute-force cosine scan without saying so. The npm and Docker
  distributions are unaffected — neither goes through this path.

## [1.14.0] - 2026-08-02

### Added

- **`gap_report` — a read-only MCP view over the gap-detector's last pass (THE-611, THE-616,
  THE-644 item 1).** The gap detector (THE-48) now persists its `GapReport` to experiential.db
  after every `obsidian-tc gaps` pass instead of only printing/writing it; `gap_report` reads the
  latest persisted pass back for a vault, filtered to the caller's read ACL (THE-563/564) on every
  `nearest`-hit path it returns. It never recomputes — a fresh reading means re-running the CLI
  pass — because a dispatch-triggered embed-and-graphSearch per query is both expensive and a
  derived-state write, the same reasoning `note_quality_report` (THE-537) already established for
  its own offline-pass sibling.

  Both loops that call the embedding provider one query at a time (`detectGaps` and the
  `--calibrate` path, including the one that runs the full 250-query golden set) now batch into a
  single `provider.embed(queries[])` call per pass instead of N. `graphSearch` itself still runs
  one query at a time — only the embed call batches, so this adds no extra concurrency pressure on
  the gateway. `detectGaps`'s injected search seam is batch-shaped as a result
  (`GapBatchSearchFn`); `singleQuerySearch` adapts a plain per-query function back to that shape
  for simple callers.

- **Pluggable embedding and rerank provider slots (THE-677, #628, #631).** The
  hardcoded `switch` over embedding provider names is now a per-slot registry: `embeddings.provider`
  and `reranker.provider` resolve against it at boot, and an unknown name is a startup error that
  lists every name registered for *that* slot. Eight embedding entries ship (`ollama`, `openai`,
  `voyage`, `cohere`, `bge-m3`, `model-tier`, `openai-compatible`, `module`) and four reranker
  entries (`cohere-compatible`, `model-tier`, `gateway`, `module`).

  `openai-compatible` and `cohere-compatible` are the generic "any web address" adapters — point
  them at LiteLLM, vLLM, Infinity, Jina, Voyage or TogetherAI without a code change. New alongside
  them: `embeddings.apiKeyEnv` / `reranker.apiKeyEnv` (name the environment variable holding the
  key, for generic providers that have no entry in the built-in per-vendor variable map), and
  `embeddings.revision` (a model checkpoint id folded into `vec_index_fingerprint` and
  `provider.id`, so a checkpoint bump at the same model name and width rebuilds the index instead of
  silently serving the old checkpoint's vectors — it applies to `model-tier` too).

  A `module` provider may not impersonate a built-in identity (#631). `chunk_embeddings.model` and
  `vec_chunks.model` store `provider.id`, and `vecFingerprint()` folds `provider` + `model` — so a
  module declaring `{ id: "ollama:bge-m3", provider: "ollama" }` was byte-indistinguishable from the
  real `ollama` provider in both. Swap one for the other and the fingerprint does not move, no
  rebuild fires, and retrieval scores queries embedded by one model against vectors produced by
  another, with no log line: the class THE-460 closed for same-dimension swaps, reachable again
  through the hatch. `assertUsable` now refuses a module whose `provider` is a registered built-in
  **or** whose `id` begins `<built-in>:`. Both halves are load-bearing — a module can declare an
  honest `provider` and still claim a built-in `id`, and `id` is the field the index stores. The
  reserved set is derived from the registry, not hand-kept, so a provider added later is covered
  automatically. Boot is the only place this is catchable: once the wrong vectors are being served,
  nothing distinguishes them from the right ones.

  Existing configs need no migration; the six previously-supported names resolve to byte-identical
  provider ids. The one deliberate exception is the `baseUrl` guard below.

- **`diagnose_retrieval` — ask why an expected note was *not* returned (THE-632, #644).** Re-runs the
  real retrieval pipeline with per-note tracing and reports, per stage, where a note was and the
  first stage that dropped it. A separate tool rather than a debug flag on the hot path. The
  ticket's premise that per-stage scores were "already computed and discarded, ~50 lines" did not
  hold: `StageMetric` carries counts and durations with zero chunk identity, so nothing retained
  could be read back and the seam had to be built.

- **`doctor --probe` — opt-in dense-embeddings liveness (THE-688, #643).** Embeds one short fixed
  string against the configured provider and reports what it *observed*. `ready` is now a word only
  the probed path may use. Off by default and staying that way: a diagnostic that reaches the
  network as a side effect of being run is a different tool from the one people reach for when
  something is already broken.

- **`obsidian-tc index` — the derived-state command that was missing (THE-697, #648).** Every other
  derived-state job (`cluster`, `activation-recompute`, `note-quality`, `gaps`) had a CLI; indexing
  was reachable only through the `index_vault` tool or boot reconcile. Before this, `obsidian-tc
  index` parsed as `{ kind: "serve", input: "index" }` — the word was read as a config path. Unlike
  its siblings it provisions `cache.db`, because it is the one command reached for before the server
  has ever run. Exits non-zero when any note failed to embed: those notes are indexed but *not*
  retrievable.

- **Scheduled episode evaluation (THE-698, #648).** `evaluateEpisodes` had no scheduled caller —
  only the manual `obsidian-tc reflect` — so rows born `pending` stayed pending and `work_search`,
  which serves evaluator-approved rows only, returned nothing. It now runs on the maintenance
  cadence beside `activation-recompute`. A `doctor` signal (`experiential.evaluator`) reports the
  backlog, keyed on *promotable* rows rather than raw pending count, since rows held for cause stay
  pending forever by design.

- **`retrieval.graphStream` config surface (THE-693, #650).** The hub-degree cap was read by
  `graph_expansion.ts` but had zero production assignments — only the eval harness ever set it — and
  was absent from the config schema, so `config validate` accepted `retrieval.graphStream.enabled`
  with exit 0 while the key reached nothing. Now a real config block
  (`enabled`/`expansionSeeds`/`perSeedCap`/`hubDegreeCap`), **off by default**: measured neutral on
  ranking quality at n=250 (0 of 8 metrics significant after BH-FDR) though non-inferior, so it is a
  cost lever — it removes roughly a fifth of the expansion candidate pool — not a quality one.

- **`--max-per-cluster` in the eval harness (THE-692, #646).** The gate THE-692 required and did not
  have; `maxPerCluster` appeared nowhere in `eval/run.ts`, so the ranking decision the ticket asks
  for could not be measured at all. Threading it required four separate places, two of them silent
  on omission — options are forwarded field-by-field rather than spread, and the artifact flag list
  is a second array from the human-readable one.

- **Gateway retry with backoff, and a liveness probe (THE-615, THE-617, #566).** The
  `AbortController` was constructed once *outside* the request path, so its 60s budget was
  per-call, not per-attempt — any retry inherited an already-fired signal and failed instantly.
  Retries now happen only on 5xx and network throws; a 4xx is an answer and retrying it burns quota
  to reach the same one. Bare 429 is terminal; `Retry-After` is honoured. Also extends the gaps
  percentiles past the median and reports malformed JSONL by line number instead of silently
  reinterpreting a truncated fragment as a query.

- **Error catalog, generated config defaults, and an error-envelope gate (THE-470, #561).** The
  error taxonomy had reached no reader since THE-471; it is now rendered, with THE-512 recovery
  hints folded in from the same source. `config-yaml`'s defaults block is generated from
  `ServerConfigSchema.parse()` after five entire defaulted blocks were found missing.
  `api-reference.md` is gated rather than generated — every derivable fact on it was already
  correct, so `check-error-envelope` validates envelope fields against the live taxonomy instead.

- **Contributor tooling and an MCP client compatibility matrix (THE-624, THE-510, #567).** Adds
  `just doctor` / `link-plugin` / DCO-hook installer and a synthetic scratch vault, and pins `just
  test` to the Node vitest path so the default matches CI byte-for-byte. The Node-vs-Bun divergence
  is not cosmetic: `open.ts` branches on `typeof Bun`, so the two invocations can resolve different
  SQLite adapters. The matrix cites passing tests per capability row; every live third-party client
  is labelled NOT TESTED, and the one live probe attempted is recorded as having failed rather than
  omitted.

- **Durable episode amendment chain and two silent-failure signals (THE-654, THE-653, THE-645,
  THE-612, #563).** `prevByCaller` was a process-local `Map`, so the chain silently broke at every
  restart; it now falls back to the caller's most recent episode id in the database.
  `makeActivationLookup`'s bare catch made a corrupt or full database indistinguishable from a cache
  miss. `ensureVecChunks` DROPs and rebuilds `vec_chunks` — a full re-embed of every vault — with no
  log, metric or audit row; it is now counted and logged.

- **A Docker Compose quick start, and the vault-only boundary stated in the docs (THE-638,
  THE-640).** A prospective user can now run the server against their vault with no local install:
  `docker-compose.yml` bind-mounts a vault plus a config *directory* — never a single file, because
  a file bind pins the host inode and an in-place config edit would leave the container reading the
  stale original — and reuses `examples/config.scratch.json` as the template rather than adding a
  second example config. README's Quick start points at the compose file instead of duplicating the
  install instructions. Alongside it, `docs/WHY.md` now states plainly that every retrieval mode is
  vault-only and never reaches web search, and why that is deliberate (THE-640).

- **`RepresentationManifest` has a production producer, and `embeddings.pooling` now moves the index
  identity (THE-683, #636).** `pooling` was a validated, documented config key that reached no
  consumer — its own `.describe()` had to admit it "does not affect the index" — and
  `RepresentationManifest` was a type with a hash and no caller. `representationFingerprint` now
  extends the stored `vec_index_fingerprint` with the axes `VecFingerprint` cannot see (`pooling`,
  the instruct prefixes, MRL `truncate`, the multi-vector heads) as a strict *suffix* extension, so
  an old stored string is a prefix of the new one.

  It also removes a standing hazard. `runtime/indexing-wiring.ts` and `search/indexing/index-vault.ts`
  each hand-built a fingerprint from the same inputs, guarded only by a source-reading parity test,
  and the second carried the warning that divergence makes boot and `index_vault` each DROP and
  rebuild the table the other just built — an unbounded rebuild loop. The manifest is now built once
  at the composition root and passed through `IndexVaultArgs.representation`, so the divergence is
  unrepresentable rather than merely detected.

  **Effect on upgrade: a fingerprint change here does not re-embed.** `ensureVecChunks` handles a
  mismatch by dropping `vec_chunks` and backfilling from the already-stored `chunk_embeddings`,
  filtered on `e.model = provider.id`. None of the added axes move `provider.id`, so the filter
  still matches every stored row and the index refills locally — no provider calls, no billing.

- **`obsidian_tc_rerank_outcome_total` — the reranker's silent fallback is now observable (#621).**
  `rerankWithScores` catches every error and returns synthetic descending scores, which protects
  availability but left six situations emitting identical-looking output: not configured, skipped by
  policy, genuinely produced this order, timed out, returned garbage, provider errored. A reranker
  broken for a week was indistinguishable from one that was working. A `RerankOutcome` is now
  reported through an optional `onOutcome` sink and surfaces as
  `obsidian_tc_rerank_outcome_total{vault,outcome}`. Purely additive — the return type, the fallback
  path and the fallback *scores* are unchanged for every existing caller. `skipped_by_policy` is
  reported one layer up in `rerank_stage.ts`, at each branch that decides not to call the function at
  all, which is a distinction the function itself cannot see.

- **Scheduled `note_quality` recompute (THE-643, THE-625 items 1-3).** `note_quality` (THE-537) sat
  at 0 rows because `recomputeNoteQuality` was reachable only from the `obsidian-tc note-quality`
  CLI, which nothing runs in production. It is now a fourth durable job handler beside
  synthesis/audit/contradiction, fanned out across every configured vault and scheduled on the
  maintenance cadence — gated on `experientialOpen` rather than `roles`, since the pass has no
  gateway dependency. Verifying it end to end is what surfaced the bun:sqlite named-parameter bug
  below.

- **The episode amendment chain is exposed, and `graphSearch` reports coverage (THE-655,
  THE-631).** `agent_episodes.prev_id` was selected in SQL from the original capture bus but never
  carried by `projectEpisode()`; `work_search`/`work_episodes` now surface it. The chain is built
  strictly per-caller, so it cannot cross the caller partition on its own — the one gap was a link
  pointing at a since-tombstoned predecessor, which must stay invisible even by id, so
  `visiblePrevIds()` resolves the referenced batch against `blocked = 0` and nulls out the rest.

  THE-631 adds an additive, non-ranking-affecting `coverage` field on `vault_graph_search` and
  `knowledge_search`, built from three grounded signals rather than a fabricated 0-1 score: which of
  the five source arms actually contributed a hit; whether graph expansion was skipped by the
  seed-strength router versus ran and got truncated; and whether the page came back under the
  requested `finalTopK`. Present only when `graphSearch` actually ran — absent on a query-cache hit
  or the lexical-route arm — and registered in `query_cache.ts`'s `FUNCTION_FIELDS` so the cache-key
  coverage gate stays honest about the new callback.

- **`bearer_methods_supported` in Protected Resource Metadata, and a per-vault audit breakdown
  (THE-661, THE-606, THE-625, THE-614).** THE-661's premise — that RFC 9728 makes
  `authorization_servers` optional, so the `isPrmConfigured` guard wrongly blocks a resource-only
  PRM — does not survive contact with the spec this feature actually implements. RFC 9728 alone does
  treat the field as OPTIONAL, but the MCP authorization spec overlays it and is stricter: the PRM
  document returned by an MCP server MUST include `authorization_servers` with at least one entry,
  word for word in both the 2025-11-25 and 2026-07-28 dated specs. The guard is correct and not
  era-dependent. What was genuinely missing is `bearer_methods_supported` (RFC 9728 §5.2, OPTIONAL);
  the token verifier reads only the `Authorization` header, so it is a fixed deployment fact rather
  than a config knob and ships as a static `["header"]`. Recorded alongside it: obsidian-tc stays
  pre-registration-only, to be revisited when a third-party client needs access with no prior
  relationship, or access becomes multi-user.

  THE-606: `runAudit`'s two health checks had no vault predicate on the null-embeddings `COUNT`, and
  collapsed the duplicate-position `GROUP BY vault_id` back into one global number — so a
  multi-vault deployment saw totals presented as if they described one vault, with no way to tell
  which vault needed attention. `AuditReport.per_vault` adds the breakdown. The existing
  single-vault test could not have caught this: every row belongs to the same vault either way, so a
  correct global total and a mislabelled single-vault one are indistinguishable.

### Changed

- **A `baseUrl` that already contains the path its provider appends is now refused at boot
  (THE-684).** `"baseUrl": "https://api.openai.com/v1/embeddings"` for provider `openai` previously
  *built* and then 404'd on the first embed, because the request went to `/v1/embeddings/embeddings`.
  It now throws at startup, naming the duplicated segment and what to set instead.

  The adapters genuinely disagree about what `baseUrl` means — `openai`/`voyage` append
  `/embeddings` to a base carrying `/v1`, `cohere` appends `/embed`, `ollama` appends `/api/embed` —
  and for a slot whose whole purpose is dropping in an arbitrary endpoint, that ambiguity is the
  likeliest first-run failure. The guard refuses loudly rather than stripping the segment silently,
  which would conceal that the operator is on the wrong convention.

  **Effect on upgrade:** this is the sole exception to the "no config migration" line above, and it
  is narrow by construction — the guard can only fire on a config that was *already* producing a
  doubled path, and therefore already failing at runtime. `model-tier` and `module` declare no
  appended path (neither consumes the descriptor's `baseUrl`) and are exempt.

- **`snapshots.enabled` now defaults to `true` (THE-648, #569).** `trusted-local`'s permissive posture was
  meant to guard against untrusted *callers* — THE-603 showed the real gap was our own write path
  (a `patch_note` replace on a lone H1 silently discarding a whole note), and the default posture
  left no rollback for it. Snapshots are unconditionally pruned inline (newest 10 versions per
  note, content-addressed, orphan blobs GC'd on every prune), so the growth this adds is bounded by
  construction, not by an operator remembering to configure retention.

  **Effect on upgrade:** an existing config that omits `snapshots` (or has an explicit
  `snapshots: {}`) will start capturing a pre-write snapshot on every destructive `patch_note`
  replace, `delete_note`, `write_note` overwrite, and similar op — previously silent no-ops. Disk
  use grows by up to 10 prior versions per actively-edited note until the inline prune catches up
  (immediate, not a background sweep). `hardened`'s own `{ enabled: true, retention: 20 }` is
  unaffected.

  **To opt out**, set `snapshots: { enabled: false }` explicitly in your config. `obsidian-tc
  doctor` now reports the effective policy (`snapshots.policy`) and warns when it is off.

- **`doctor` says "configured", not "ready", for the dense retrieval head (THE-688, #642).** `ready`
  was a literal in a template string with no branch, and `RetrievalHeadsView` carried no liveness
  field at all, so it was structurally impossible for the check to report anything else. The cost
  was real: Ollama was removed from a deployment while the config still named it, and for two days
  every semantic query returned `embedding_provider_error` while `doctor` printed
  `dense: ready (ollama, nomic-embed-text, dim 768)` and exited 0 — actively pointing an operator
  away from the cause. It is a fresh-install failure too, since the zero-config default names a
  provider most new users are not running.

- **Bun's 10-second default request timeout no longer kills long MCP calls (THE-697, #648).**
  `serveHono` passed no `idleTimeout`, so every request the MCP plane served inherited Bun's
  10s default. `index_vault` over a 1,147-note vault returned `RemoteProtocolError: Server
  disconnected` to the caller while the work completed asynchronously — a hard failure reported for
  a successful operation. Now 120s, chosen rather than maxed: Bun accepts up to 255 and `0` disables
  entirely, and this applies per-process to every request.

- **The ACL predicates no longer recompile a glob per rule per path (THE-618, #638).**
  `scopesForPath` called `globMatch` once per rule, and `globMatch` NFC-normalizes *both* operands
  every call — so a path check against a 20-rule ACL paid 20 redundant `normalize("NFC")` calls on
  the same path, plus a defensive copy of the whitelist per check. `FolderAcl` now compiles its rule
  globs once in the constructor, in config order (last-match-wins is load-bearing, so the array is
  never sorted or deduped), and normalizes the path once per lookup.

- **One shared dense query encoder for M2 and M7 (#622).** Both surfaces built a private copy of the
  same four-line encode closure. The duplication is not the problem — the problem is that neither
  copy was reachable from the other's module, so nothing could assert they agreed. Add a query
  prefix, a normalisation step or a retry to one and the two surfaces encode the *same string* into
  *different vectors*, rank the same query differently, and every existing suite stays green.
  `search/query-encoder.ts` is now the single owner, so the assertion has a symbol to be written
  against. Behaviour is unchanged by construction, including the `?? []` degradation: `semanticSearch`
  and `graphSearch` already read an empty dense vector as "no dense arm", so throwing here would turn
  a survivable provider hiccup into a failed tool call. The batch paths (`cli/gaps.ts`,
  `cli/citation-infer.ts`) and the sparse/late-interaction heads are deliberately out of scope — a
  single-query encoder would reinstate exactly the N round trips THE-616 removed.

- **One shared evidence builder for `reflect` and `challenge` (#623).** Three surfaces assembled
  evidence for a model three different ways and two of them fed the *same* judge prompt, with a 2.25×
  difference in how much of a chunk the model saw (800 vs 1800 chars) depending on which tool the
  caller reached. None could dedupe a chunk retrieval returned twice; none could stop one large note
  from consuming the whole context. `search/evidence.ts` now owns that mechanic — dedup (by chunk id,
  else a **length-prefixed** `path+content` key so `{ab,c}` and `{a,bc}` cannot collide), per-note
  quota, item cap, character budget, boundary-aware trimming, and stable citation numbers assigned
  *after* drops.

  Mechanics, deliberately not policy. Rank order in is rank order out; the proposals to prefer
  authored links over derived edges, or to balance supporting against conflicting evidence, change
  *which* evidence is selected, and this repo gates retrieval policy on the golden set rather than on
  a refactor. `vault-context.ts` is untouched — it already packs to a real token budget and is the
  one surface doing this properly. Each path's existing caps are preserved exactly, so the text
  handed to a model is unchanged apart from dedup (strictly an improvement: counting one source twice
  reads to a model as two sources agreeing) and the new, deliberately loose `maxPerNote`, which binds
  only when one note supplies 20-25% of the whole evidence set.

### Fixed

- **`token mint` honours `OBSIDIAN_TC_JWT_SECRET` (THE-662, #562).** `readAuthBlock` bypassed
  `loadConfig` deliberately — boot validation should not stand between an operator and a token — but
  that also bypassed `applyEnvOverlays`, the only thing that injects the secret. So the sanctioned
  mint tool refused on exactly the secret-handling shape the docs recommend, claiming the secret did
  not exist while it sat in the environment.

- **`vec0` is embedded in `--compile` release binaries (THE-663, #568).** Every published standalone
  binary silently lost `vec0` on any machine that was not the CI runner: `vec.ts` resolved
  sqlite-vec through `createRequire(import.meta.url)`, which `bun --compile` freezes to the *build*
  machine's path. `loadVec` degrades rather than throws, so retrieval fell back to brute-force
  cosine and still returned results — nothing detected it for two releases. The smoke gate now wipes
  `node_modules` first, because asserting `vec_enabled` alone passed even on unfixed code (the job
  runs in the same checkout that compiled the binary).

- **QueryCache expiry sweep, `via_edge` deep copy, and two smaller correctness fixes (THE-626,
  THE-620, THE-622, #565).** `set()` ran LRU eviction with no expiry sweep, so a live entry could be
  evicted while an expired one held capacity; and `GraphSearchResult` is not flat, so the shallow
  spread handed out aliased nested objects from a cache on the per-search hot path. The
  `columnExists` probe is now memoized per *connection* rather than per module — a module-level
  cache would leak one database's schema answer into another's.

- **The idempotency-claim release has an error channel (THE-667, #641).** Triaging all 67 strictly
  inert catch blocks against the ticket's own three-condition filter left exactly two that
  qualified, both on a rejection path that releases the idempotency claim so a caller's retry can
  proceed. The other 65 are correct by construction and deliberately untouched: instrumenting
  telemetry sinks in bulk produces log noise that trains people to ignore the log, which reaches the
  same end state as no signal from the opposite direction.

- **`notes_fts` integrity is checkable, and repairable (THE-696, #648).** `ensureNotesFts`
  provisioned with `CREATE VIRTUAL TABLE IF NOT EXISTS` — an existence test a malformed table
  passes — and `health.fts_enabled` reported availability, so a corrupt index that kept answering
  `MATCH` queries with plausible counts was undetectable from inside the system. Adds
  `verifyNotesFtsIntegrity`/`repairNotesFts` (the repair re-verifies rather than trusting
  `rebuild`'s silence), an opt-in boot gate via `OBSIDIAN_TC_VERIFY_FTS=1`, and a
  `doctor --probe` check. On unrepairable damage `ensureNotesFts` now returns false, routing queries
  to the disk-scan fallback instead of serving a corrupt index.

- **Every durable job enqueue was broken under Bun, the production runtime (THE-665).**
  `JobQueue.enqueue()` and the `Scheduler`'s persistence bound named `@param` placeholders against
  bare-key objects. `bun:sqlite`'s `Statement.run()` does not throw on that — it silently binds every
  named parameter to NULL. `node:sqlite` and `better-sqlite3` both accept the bare-key form and the
  whole suite defaults to `node:sqlite`, so CI could never see it. Under Bun, `enqueue()` hit
  `jobs.type`'s NOT NULL constraint and threw; `job_schedule` has no such constraint, so the
  scheduler's writes corrupted silently — every tick failed its `ON CONFLICT(name)` match because
  `name` was NULL and INSERTed a fresh all-NULL row instead of upserting, an unbounded leak on top of
  the silent NULLing.

  Measured across all three adapters this repo supports, positional `?` binds are the only form all
  three apply correctly: a sigil-prefixed object key (`{"@id": …}`) fixes `bun:sqlite` but throws
  "Missing named parameter" on `better-sqlite3`. The two affected call sites are converted; the ~209
  others already used positional binds. `test/param-binding.test.ts` is a conformance gate over the
  real adapters and the real call sites, with `bun:sqlite` exercised through a spawned `bun`
  subprocess since vitest runs under Node. It asserts stored column values, never a row count — a
  count check is exactly what let this through.

  **Blast radius:** the ordinary synchronous MCP request/response path (retrieval, reads, writes)
  never touches `JobQueue`. Only durable and task work was affected — the contradiction, synthesis
  and audit background jobs, and opt-in MCP Tasks.

- **The scheduler's durable-persistence failures have an error channel (THE-666).**
  `ensureTable`/`seedNextRun`/`persistRunStart`/`persist` each had a bare `catch {}`, so a broken
  `job_schedule` table and a healthy one were byte-identical from outside the process. A guarded
  `onPersistError` channel now reports them, throttled to one call per distinct (op, job) failure
  streak — the job-queue runner alone ticks every 15s, so an unthrottled signal would be a log flood
  that trains people to ignore the log. The dedup key clears on the next successful write, so a later
  failure alerts again. `seedNextRun`'s null stays collapsed for both "no stored row" and "a read that
  threw", because the scheduling fallback is identical either way, but the read failure now reports
  through the channel. None of this changes the best-effort contract: persistence stays disabled for
  that write and scheduling continues regardless. The tests induce a real read-only SQLite file and a
  real dropped table rather than stubbing errors.

- **A boot failure no longer leaves the OTEL SDK running (#614).** `buildServerRuntime` composes
  `stores → otel → wireRuntimeCore → … → transports → scheduler`, and two separate unwind stacks
  existed — neither of which covered `otel`, which is constructed *before* `wireRuntimeCore`. A throw
  there left telemetry running with nothing to shut it down; the original `cli.ts` had no unwind at
  all. `otel` is now pushed onto the existing reverse-order stack in its real construction position.
  Its `shutdown()` is deliberately wrapped in a swallowing catch: an unguarded one *replaces* the
  boot error with the telemetry error, so an operator debugging a bad embeddings provider would be
  shown an OTEL shutdown failure instead.

- **`doctor` pre-detects an unbuildable reranker, and names the declared one (THE-679, THE-681,
  #632).** Both gaps shared one cause — doctor answered from provider *names*. `providers.registered`
  validates names only, and `model-tier` and `gateway` are perfectly valid names, so a config naming
  `model-tier` without `embeddings.modelTier.full` hard-failed boot while doctor reported `ok` and
  exited 0: silent about the one configuration guaranteed not to start. `providers/reranker-preflight.ts`
  is now the single source of truth for why a declared block cannot build, consumed by both the boot
  throw and the new `reranker.buildable` check, so a pre-boot verdict and the boot error cannot
  drift. It is offline by construction — a `module` provider is never probed, because diagnosing must
  not execute operator-supplied code.

  THE-681: `retrieval.heads` checked the name-derived `multiVector` branch *before*
  `rerankerConfigured`, so with `model-tier` plus a declared `cohere-compatible` reranker the runtime
  used cohere-compatible while doctor printed "model-tier / ColBERT rerank capable" and never named
  the backend actually wired. Reporting an inference over an explicit declaration is wrong precisely
  when the operator has taken an override.

- **A credential error names the config block that actually holds the key (THE-680, THE-678, #633).**
  A `cohere-compatible` rerank failure routed through the shared `postJson` and told the operator to
  set `embeddings.apiKey`, when the key they need is `reranker.apiKey`. Enumerating `postJson`'s call
  sites rather than trusting the ticket's inventory found **four** distinct credential owners across
  13 production sites, two of which the ticket did not mention: `model/bge.ts` is a second reranker on
  this transport and authenticates with `embeddings.modelTier.full.authToken`, so a binary
  embeddings/reranker split would have fixed the reported case and left this one wrong; and `tei.ts`
  and `embeddings/bge-m3.ts` send no authorization header at all, making "configure a key" a third
  wrong answer pointing at a knob that reaches nothing.

  `credentialSlot` is a **required** field on `PostJsonOptions` rather than a defaulted one — a
  default is precisely what let every adapter inherit the `embeddings` hint silently, and making it
  required turns the typechecker into the gate against the next adapter guessing. That is what
  surfaced the `bge-reranker` site, which no grep in the ticket's terms would have found. Nothing
  asserted the hint text anywhere before this, which is why the wrong prefix survived. THE-678
  documents that `modelTier.dense.revision`/`.full.revision` are provenance-only and redirects to the
  top-level `embeddings.revision`, with both halves of that redirection now pinned by tests.

- **The published container image no longer advertises Bun's commit as its own.** OCI labels are
  inherited from the base image unless overridden, and `oven/bun:1-slim` carries its own
  `org.opencontainers.image.revision` and `.created`. The publish workflow set `source`, `version`
  and `licenses` but not those two, so every image since has shipped
  `revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4` — a commit that exists in no obsidian-tc
  history — and `created=2026-05-13`, Bun's base build date, directly beside our own source URL.
  That pairing is worse than either label alone: a correct `source` lends credibility to a
  `revision` that resolves to nothing, so anyone asking which commit produced an image got a
  confidently wrong answer. `revision`, `created` and `title` are now set explicitly in both
  `publish.yml` and `release-image.yml`.

- **`bun run map` and `check:boundaries` refuse to run against a stale `dist/` (THE-664, THE-607,
  THE-604).** `gen-tree-map.mjs`'s own header already documented the hazard — with `packages/*/dist`
  present, dependency-cruiser resolves workspace packages differently and reports a
  wrong-but-internally-deterministic module count, so `drift-gate` then fails in CI for reasons that
  look unrelated to the developer's change. It was commented, not guarded. Measured at 287 modules /
  1184 dependencies clean versus 286 / 1089 with a real `packages/shared/dist`, which is not merely
  cosmetic: the bare specifier resolves through the published `exports` instead of the tsconfig
  `paths` mapping to `src`. Both guards were watched firing and clearing. THE-607 runs the ACL
  extractor audit in strict mode over real dispatch in CI; THE-604 records, in `docs/README.md`, why
  `docs/` stays on TypeScript ^6.0.3 — `@astrojs/check` declares `^5.0.0 || ^6.0.0` and no released
  version admits TypeScript 7, and `astro check` is on the build path.

### Security

- **The query router's rare-term signal no longer leaks term existence across the ACL (THE-691,
  #645).** `termDf` counted every FTS match with no ACL, and `routeQuery` embeds the result as
  `rare-term:<token>(df=<n>)` — returned verbatim by `vault_graph_search`, `knowledge_search`,
  `vault_context` and `reflect`. Any caller holding `read:notes` could probe a guessed term with one
  ordinary search and read the answer out of a normal successful response. A content-membership
  oracle, not merely a path one: it revealed which *words* appear in notes the caller is denied.

- **The lexical and sparse arms filter by ACL at query time (THE-632, #644).** The dense arm has
  filtered in SQL since THE-287; `bm25Chunks` and `sparseSearch` did not — they queried the whole
  vault and were filtered downstream, which removes unreadable hits from the *results* but not from
  the *counts*. Beyond the disclosure, unreadable chunks occupied slots in each arm's top-k,
  crowding out readable ones.

- **The router's timing oracle is closed, and BM25 no longer leaks its result length (THE-694,
  THE-695, #649).** THE-691 closed the *value* channel; latency still correlated with how much
  denied content matched a caller-supplied term — measured at 72× with non-overlapping
  distributions, both queries returning 0. No in-SQL filter removes that (the plan is a full
  `chunk_fts` scan plus a per-row membership probe, so work tracks *total* matches however the
  predicate is written), so the probe is no longer issued for restricted callers and the paged scan
  is deleted rather than left reachable. Separately, `bm25Chunks` over-fetched and filtered in JS,
  so an underfill meant hidden rows had outranked the caller's and the returned *length* depended on
  hidden content; it now filters in SQL with an exact `LIMIT`.

  **Effect on upgrade:** callers with a restricted read ACL lose rare-term lexical routing and will
  pay an embedding round-trip on those queries where they previously took a lexical short-circuit.
  Quoted-phrase and temporal routing are unaffected.

- **The poison-scan capture path is bounded, and the secret patterns cover more token shapes
  (THE-619).** `assessPoison` had no input size cap, so a large tool-arg payload made every regex
  family walk the full string on every dispatch. `MAX_TEXT_LENGTH` (64 KiB) truncates and scans
  rather than refusing — refusing would drop the episode row entirely through the capture bus's
  best-effort try/catch — and an over-cap payload always carries an `oversized` signal, so it can
  never be graded `none` merely because the truncated prefix looked clean. `CHANNEL_TRUST` and
  `RISK_TRUST_MULTIPLIER` are now `Readonly<>` and frozen; nothing mutates them today, and the
  frozen-table test demonstrated the risk by showing an unfrozen mutation bleeding into a later test.

  The ticket placed `SECRET_PATTERNS` in `poison.ts`; it actually lives in `experiential/episodes.ts`,
  and the gaps were verified empirically by running `redactSecrets` against each candidate rather
  than by reading the table. Redact-before-truncate ordering is now pinned, so a secret straddling
  the truncation point cannot survive as a partial literal.

## [1.13.1] - 2026-07-28

### Added

- **`auth.jwksUri` — a key source that can rotate (THE-658, #556).** Fetches an authorization
  server's JWKS from its `jwks_uri` for asymmetric verification, cached by jose and re-fetched only
  on an unknown `kid`.

  **Opt-in and unset by default.** THE-297 deliberately allowed inline/file JWKS only, reasoning
  that a URL fetch adds network attack surface — that reasoning still holds, so this is not a silent
  reversal. What it buys is the thing that made adopting an authorization server a *code* change
  rather than a *config* change: with static keys, every AS key rotation means an operator
  hand-copying a JWKS and redeploying, so rotation — the entire point of asymmetric verification —
  becomes a manual outage risk.

  A fetch failure **rejects** the token; there is no fallback to the inline/file set, because a key
  source that silently degrades to another key source is how a rotated-out key keeps working.

- **`scope` in the `WWW-Authenticate` challenge (THE-658, #556).** A 2026-07-28 **SHOULD**, emitted
  when `auth.scopesSupported` is configured. A general-purpose MCP client has no domain knowledge to
  pick scopes with, and its documented fallback when `scope` is absent is to request *every* scope in
  `scopes_supported` — so omitting it does not fail closed, it pushes clients to over-ask.

### Fixed

- **`jwksUri` is covered by the audience-binding gate (THE-658, #556).** THE-456 requires an audience
  whenever a JWKS, a non-loopback bind, or an issuer is configured, and its check tested only
  `jwks`/`jwksFile`. A remote JWKS is the *most* external key source of the three — keys fetched from
  an authorization server at runtime — so it would have been the one configuration exempt from
  binding. Audience-optional HS256 on a loopback bind is unchanged and deliberate: a self-issued
  secret unique to a local server has no second service to be replayed from.

## [1.13.0] - 2026-07-28

### Added

- **MCP SDK v2 + the 2026-07-28 protocol revision, alongside 2025-11-25 (THE-583, #543).** The server now
  speaks **both** protocol eras from one endpoint. A 2026-07-28 client can call tools with no
  `initialize` handshake at all (SEP-2575 removed it); a 2025-11-25 client is unaffected and still
  negotiates exactly as before.

  Migrated from `@modelcontextprotocol/sdk@1` to the v2 package split —
  `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, both 2.0.0. The v1 SDK moves to
  **devDependencies**: it is retained deliberately as a *real* legacy client for the roundtrip
  tests, which is stronger evidence of back-compatibility than a hand-written 2025-era request.

  Serving the modern era is **opt-in** — the SDK's shipped `SUPPORTED_PROTOCOL_VERSIONS` is
  2025-only, so an unmodified v2 server answers a 2026 client with `400 Unsupported protocol
  version`. Worth knowing if you vendor this: the opt-in must be set on `ServerOptions`, because
  `Server.connect()` overwrites the transport's copy with the server's — setting it on the transport
  throws nothing and silently leaves the server legacy-only.

  Back-compatibility was verified against the exact client the deployment depends on (LiteLLM's
  `mcp` 1.28.1, protocol ceiling 2025-11-25): negotiated `2025-11-25`, listed tools, called one.
  `test/mcp-protocol-eras.test.ts` pins both eras plus a floor asserting an unadvertised revision is
  still refused.

- **Foundation for the MCP Tasks extension over the durable queue (THE-583, #548).** Tasks left the core
  protocol in 2026-07-28 and was redesigned around polling (`tasks/get`, `tasks/cancel`;
  `tasks/list` removed). The SDK ships **no runtime** for it, so this is an implementation of the
  extension rather than an adoption — verified first that extension methods do route through
  `setRequestHandler` on a modern connection.

  The `jobs` table gains nullable `vault_id` / `caller` columns. **NULL is the meaningful default:**
  a job with no owner is internal maintenance work and is never visible over MCP. Every existing row
  and every existing `enqueue` call site — reconcile, contradiction, synthesis, audit, index writes —
  stays invisible without being touched. Visibility is opt-in at enqueue, not opt-out at read.

  That matters because the queue was never caller-scoped: exposing it as-is would have let any
  authenticated caller read any job by id, including `payload` and `last_error`, which carry vault
  paths and error text. A foreign task id and a missing one now answer identically, so the lookup
  cannot be used to enumerate another caller's ids.

  `tasks/get` and `tasks/cancel` are served on modern connections. They are answered **in front of**
  the SDK handler, not through it: `createMcpHandler` validates an inbound method against the spec
  registry and answers `-32601` for anything unrecognised, extension methods included — a handler
  registered on the `Server` for `tasks/get` is never consulted. (A raw transport *does* route it,
  which is what made the difference easy to miss.)

  A foreign task id and a missing one answer identically, so the surface cannot be used to enumerate
  another caller's ids, and cancelling someone else's work — a write, not a read — is refused.

- **Logging, Roots and Sampling wired (THE-583, SEP-2577 deprecation window, #546, #550).** The 2026-07-28
  revision deprecated these three server→client features but did not remove them, and the SDK still
  implements all three — so a client mid-migration can still use them.

  The server now advertises the `logging` capability and emits `notifications/message`. The first
  real use: when the byte governor **truncates** a response, the client is told. That was previously
  visible only in `meta` and server-side metrics, so a caller could act on a shortened result
  believing it complete.

  `roots` and `sampling` are consulted per connection and gated on the client having advertised
  them — calling either against a client that did not is a protocol error, not a soft miss.
  Sampling is deliberately **not** a fallback for the LiteLLM gateway: the gateway is chosen,
  configured and budgeted by the operator, while the client's model is whatever the caller happens
  to be running, so substituting one for the other would move inference and its data exposure to a
  party the operator never selected.

  **`logging/setLevel` is not routable in SDK v2** — it is absent from both the 2025 and 2026 wire
  registries and a handler registered for it answers `-32601`. The verbosity floor is therefore
  fixed at `info` rather than settable; a handler was written, measured as dead, and removed instead
  of being left in place looking implemented.

- **HITL confirmation now uses the 2026-07-28 multi-round-trip shape (THE-583, SEP-2260/2322, #546).** A
  destructive call from a modern client is answered with `inputRequired` carrying an opaque,
  HMAC-signed `requestState`; the client re-issues the same call echoing it back and the server
  verifies it before any handler runs. Previously this was an `elicit_required` error plus a bespoke
  `elicit_token` argument that only a client written against this server could complete.

  The 2025 token path is untouched and still serves legacy callers, so both eras work. The round
  trip is offered **only** when the client advertised form elicitation — the SDK rejects an
  `inputRequired` naming a capability the client never declared, so offering it unconditionally
  would turn "needs confirmation" into a hard protocol error for clients that cannot prompt a human.

  A confirmation is bound to tool, arguments, vault **and** caller: approving one write does not
  authorize another.

  **Known trade, accepted deliberately:** `requestState` is authenticated and TTL-bounded but *not
  consumed*, where the `elicit_tokens` table it supersedes was single-use
  (`UPDATE … WHERE consumed_at IS NULL`). Within the TTL a captured confirmation can authorize the
  same call more than once. A test asserts this replay behaviour explicitly so it cannot be mistaken
  for the old semantics; restoring one-time use means a consumed-nonce table and does not require a
  wire change.

- **Adopt SDK helpers over hand-rolled equivalents (THE-583, #544).** Three duplicated implementations now
  defer to the SDK, removing second copies of wire constants and validation logic:

  * **`_meta` key constants** — `client-info.ts` and `otel/propagation.ts` had hand-typed literals
    for `io.modelcontextprotocol/clientInfo`, `traceparent`, `tracestate` and `baggage`. They now
    re-export the SDK's. A drifted wire constant does not throw; it yields an absent clientInfo or a
    trace that quietly stops propagating.
  * **DNS-rebinding guard** — `validateHostHeader` / `validateOriginHeader` replace regex parsing.
    The `allowedHosts` allowlist is normalized to both `host:port` and bare-hostname forms first: the
    SDK matches on hostname while our config schema documents "Host header values", and passing those
    straight through would have 403'd every request for anyone who configured a port.
  * **RFC 9728 metadata URL** — now the SDK's derivation. **Behaviour fix:** for a resource carrying
    a path (`https://host/mcp`), RFC 9728 §3.1 inserts that path *after* the well-known suffix
    (`/.well-known/oauth-protected-resource/mcp`). Ours dropped it, collapsing two distinct resources
    on one host onto a single metadata document.

  The rebinding guard gained its first real coverage in the process — 8 tests over Host and Origin
  acceptance, using `node:http` because Node's `fetch` silently drops a custom `Host` header, which
  had made the first draft of those tests pass against loopback while appearing to test rebinding.

- **Full 2026-07-28 conformance (#544): `server/discover`, SEP-2243 routing headers, SEP-2549 cache hints
  (THE-583).** The `/mcp` route is now served by the SDK's `createMcpHandler`, which classifies the
  protocol era per request and serves both from one endpoint.

  This is what makes **`server/discover` (SEP-2575)** work. Hand-wiring `Server` + transport never
  establishes an era on a stateless connection, so every request fell back to the frozen 2025 wire
  registry — which has no such method and answered `-32601` regardless of what the client sent.

  **SEP-2243** routing headers (`Mcp-Method`/`Mcp-Name`) are enforced: a modern request whose
  headers and body disagree is refused, so a gateway cannot route on one method while the server
  executes another. **SEP-2549** adds `ttlMs`/`cacheScope` to cacheable results, on modern
  connections only. `cacheScope` is a security decision — `tools/list` and `resources/*` are
  `private` because they are scope- and ACL-filtered per caller; only `prompts/list` is `public`.

  `fetch-to-node` is **removed as a dependency**: `createMcpHandler` is web-standard fetch in,
  Response out, so the route no longer round-trips through Node req/res. THE-561's keep-alive
  harness still passes 40/40.

- **`obsidian-tc token mint` — reproducible, auditable bearer tokens (THE-658, #539).** There was no mint
  tooling at all, so every token this project runs on came from a Python one-liner in someone's
  shell history — which is how the live tokens ended up with no `aud` claim.

  ```
  obsidian-tc token mint [path] --sub <id> [--aud <uri>] [--vault <id>]
                                [--scopes a,b] [--ttl <sec>] [--json]
  ```

  It reads the config's own auth block, so a minted token matches what that server will actually
  verify: `aud` defaults to `auth.audience` (falling back to `auth.resource`, which is what
  `createHttpApp` binds to when PRM is configured), and `--ttl` defaults to `auth.tokenTtlSeconds`.
  The bare token goes to stdout so it composes — `TOKEN=$(obsidian-tc token mint …)` — with the
  human-readable summary on stderr. The signing secret is never echoed.

  Two refusals, each encoding a failure already paid for: it will not mint **without an `aud`** when
  the config binds one (jose rejects such a token as `missing_claim` on first use, and THE-456 makes
  an audience mandatory for a non-loopback `jwt` bind), and it will not mint a **`--ttl` above
  `auth.tokenTtlSeconds`**, which caps a token's *age* rather than its remaining life — a year-long
  `exp` under a 24h cap dies after a day while still looking valid, which previously took the MCP
  plane down for five days.

- **The MCP Tasks extension, complete (THE-583, #549, #552).** A long-running tool can now run as a
  background task and the client collects the answer later. Task creation is **server-directed**, as
  the revision specifies: a client declares `io.modelcontextprotocol/tasks` in its per-request
  capabilities and the server decides per call — there is no per-request flag (`params.task` was
  2025-11-25 vocabulary). Only tools marked `taskAugmentable` defer; everything else still answers
  synchronously, because a handle is worse than an answer for anything fast. Today that is
  `index_vault`.

  `tasks/get` returns the real result on a completed task and the JSON-RPC error on a failed one —
  deferred retrieval is the point of the extension, and the runner previously discarded what it
  produced. `tasks/update` and `tasks/cancel` acknowledge per the extension schema.

  `notifications/tasks` pushes task state to a subscribed client instead of making it poll. Polling
  remains the default and is fully supported.

  **Isolation:** a task is visible, cancellable and announced only to the caller and vault that
  created it. Internal maintenance work (reconcile, contradiction, synthesis, audit) carries no
  owner and is invisible over MCP by construction. A background task carries exactly the scopes its
  caller held at enqueue — it can never do more than that caller could have done synchronously.

- **`subscriptions/listen` (THE-583, SEP-2575, #551).** The single long-lived stream that replaces
  the removed HTTP GET endpoint and `resources/subscribe`/`unsubscribe`. Clients opt into
  `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` or per-URI resource updates.

  Serving it required making the MCP handler persistent. It was built per request, which was correct
  for isolation but closed any stream the instant its creating request returned. The isolation is
  preserved by a different mechanism rather than dropped: the SDK invokes its factory once per HTTP
  request and hands it that request's pass-through `authInfo`, so a caller context is still built
  per request from that request's identity. Asserted by a test driving two tokens through the same
  handler, interleaved and concurrent.

- **`resources/templates/list` (THE-583, #554).** Previously unimplemented, so a client probing the
  resource surface saw the method as unsupported rather than seeing that we publish no templates.
  Now answers an empty list with a cache hint. Resources here are concrete vault notes enumerated by
  `resources/list`; there is no URI template to expand.

- **A 2026-07-28 conformance suite (THE-583, #554).** Pins the revision on the wire per changelog
  item, including the **removals** — `ping`, `logging/setLevel` and `initialize` are refused, since a
  deleted method still being answered is a conformance failure no feature test would notice.

### Fixed

- **Per-request log level (THE-583, SEP-2575, #549).** The revision made verbosity a per-request
  `_meta` field and requires that a server **MUST NOT** emit `notifications/message` for a request
  that did not carry one. Logging went through a session-keyed path that a stateless server never
  populates, so the byte-governor truncation notice reached clients that never asked for logging.

- **`resources/read` misses answer `-32602` (THE-583, #550).** They answered `-32603`, reporting a
  client mistake as a server fault on the one method the revision names for this code.

- **`forget` audit parity, including on a no-op (THE-609, #542).** `audit_events` now mirrors
  `forget_log` in every case, so a forget that matched nothing is still auditable.

### Changed

- **Protocol surface built for downstream clients, not just this deployment (THE-583, #550).**
  `x-mcp-header` (SEP-2243) is verified end to end so a tool author can declare header-carrying
  parameters; Roots and Sampling are reachable from every tool's context for their deprecation
  window rather than being removed as unused.

- **Request bodies are parsed once, not twice (THE-583, #553).** The body parsed for the Tasks
  extension checks is now handed to the SDK instead of being re-parsed on every MCP request.

## [1.12.1] - 2026-07-28

### Fixed

- **Enabling `observability.prometheus` no longer kills the MCP HTTP server under Bun (THE-659,
  #535).**
  With `prometheus.enabled: true`, every request to the MCP transport — any path, any method,
  authenticated or not — returned Bun's placeholder page (`Welcome to Bun! To get started, return a
  Response object.`) at **HTTP 200**, while the process logged `Expected a Response object, but
  received 'Response (lightweight) { … nativeResponse: undefined }'`. The MCP plane was completely
  dead and every status-code health check stayed green.

  The `/metrics` endpoint served its app with `@hono/node-server` while THE-561 had already moved
  the MCP transport to native `Bun.serve`. Starting the Node-compat server installs its HTTP
  machinery process-wide, after which Hono's responses are the "lightweight" variant that
  `Bun.serve` refuses. Both listeners now go through one `serveHono` helper
  (`src/transports/serve.ts`), because the Bun-vs-Node choice is a **process**-wide decision rather
  than a per-server one — mixing the two implementations is the defect. Guarded by
  `bun-smoke/dual-http-servers.test.ts`, which starts both servers in one process and asserts on
  response **bodies**; a test that starts only one server cannot see this failure, and one that
  checks only status codes reads 200 either way.

## [1.12.0] - 2026-07-27

### Changed (breaking)


- **`generate_uri`'s `vault` input is renamed `vault_name` (THE-589).** **Callers passing `vault`
  must rename it** — the tool's schema is `.strict()`, so the old key is now rejected with
  `validation_error` naming the unrecognized field. This is the only tool affected; no other input
  or tool changes.

  The field is an Obsidian **display name**, not a vault id, and always was. But the central
  vault-binding guard (THE-267) matches on the argument *name*: any string argument called `vault`
  is compared against the caller's bound vault id. So a vault-bound HTTP caller whose Obsidian
  display name differed from its configured vault id got `forbidden` from a tool that requires no
  scope, reads nothing, and only concatenates a string. Reproduced before the fix:
  `{vault: "My Notes"}` with bound vault `main` returned
  `forbidden: vault is not the caller's bound vault`.

  Renamed rather than exempting the tool from the guard, so no bypass is added to a
  security-relevant check. Unbound (trusted stdio) callers were never affected.

  (THE-589, #476.)

### Added

#### Vault change detection

- **The server now watches each vault and reindexes notes changed outside it** (THE-649, #524).
  `docs/SYNC.md` had described this since before it existed, in two places, on the primary
  integration path — there was no watcher. Every sync tier that document describes delivers Markdown
  by writing to disk, so this is a filesystem watch rather than the companion plugin's event stream.
  Changes are read-ACL-gated identically to a `write_note`. Eligibility mirrors `walkVault` exactly,
  and takes **two** guards: `lstat` rejects symlinks (as the walk does), `readNote` rejects hard
  links (`nlink > 1`) — neither covers the other, and the first draft shipped a hard-link bypass.
  **Not started on Windows**: Node's recursive `fs.watch` terminated the test process there, and
  whether a long-lived server is affected is unverified. Configurable via `watch.enabled` /
  `watch.debounceMs`.
- **Periodic vault reconcile** (`maintenance.reconcileIntervalMinutes`, THE-458, #532). Off unless
  set. Covers the watch's blind spots (Windows, `ENOSPC`, network mounts, `add_vault` vaults) and
  refreshes derived graph edges, which single-note writes never densify.

#### Retention — four growth curves bounded

- **Session traces are pruned by age** (`observability.retention.tracesDays`, THE-610, #523). The
  sweep's first filesystem arm. Orphans from a failed `start_session` age out on the same rule.
- **Dead `agent_episodes` and aged `chunk_retrievals` are swept** (THE-610 arm 2, #528). Only
  tombstoned or bi-temporally expired episodes — a live episode is never touched at any age.
  `chunk_retrievals` defaults to a **year**, deliberately: `chunk_access_stats` is a view over it, so
  pruning rewrites activation and note-quality signals.

#### Observability

- **W3C trace context over MCP `_meta`** (SEP-414, #525). A trace beginning in a host application now
  continues through this server instead of starting a second, unrelated tree.
- **Client software identity** (`client_name` / `client_version` on the session row, THE-627, #526),
  read from per-request `_meta` rather than the `initialize` handshake — the shape that works under
  both the current spec and `2026-07-28`. NULL, never a placeholder, when the client sends nothing.
- **SQL write-lock wait, vec fallbacks, coalesced writes, scheduler health, HTTP construct time,
  retrieval stage funnel, content-bytes, ingest counters, query-cache effectiveness, cold-start
  `boot.*`** (THE-585 / THE-507 / THE-515: #472, #474, #475, #486, #463, #446, #461, #458). Includes
  THE-585 items #1 (index-coordinator depth) and #6 (the retrieval stage funnel), and three gauges
  that were catalogued and fed by nothing for many releases.
- **The OTEL SDK no longer rides the tool registry's import graph** (THE-515, #489) — it loaded in
  every process, `serve` or not.
- **Budget deferral is reachable** (`scheduler.eventLoopDeferMs`, #530). It was built, tested and
  unpassable, so `scheduler_deferred_total` read 0 for every release since it shipped.
- **Config provenance** — every resolved value traceable to its source (THE-518, #437).
- **Retrieval policy provenance** logged (THE-538, #434).

#### Tool surface

- **Every registered tool declares an `outputSchema`** — 150/150 (THE-417, #479, #480, #481, #482).
- **Graph analytics**: centrality, communities, path tracing (THE-452, #436).
- **Structured recovery hints on every error response** (THE-512, #427).
- **Idempotency and `vaultArg` declared on the tool surface**; facade domain membership moved onto
  tool definitions (THE-513, #492, #499).
- **`AbortSignal` threaded through the dispatch pipeline** (THE-514, #490).
- **Cross-surface dispatch parity gate** (#512).
- **`note_quality` rollup, offline scorer and read-only report surface** (THE-537, #435).
- **Multi-query fan-out** exposed on `vault_graph_search` and a `decompose_and_research` prompt
  (THE-448, #450, #453) — **measured worse** (−0.047 nDCG@10, p=0.0004) and therefore opt-in.

#### Retrieval and performance

- **Query-product cache** keyed by vault generation + ACL fingerprint (THE-497, #432).
- **Forward vector scope closes the delta-kNN discovery gap** (THE-533, #438).
- **Densify directly instead of a full reindex per cell** (THE-532, #464).
- **Perf harness**: SQLite lock contention (#531), notes/s + embed tokens/s + per-vault denominator
  (#533), densification scenario (THE-581, #452), an I/O contention channel (THE-584, #473), a
  baseline refusal when the workload shifts without a count change (#477), Node portability runs
  (THE-494, #433), and a gate that notices what it was not handed (THE-534, #441). Baselines
  re-recorded on the CI runner (#448, #456, #459). kNN sweep pre-registered (THE-532, #460).
- **Synthetic multi-hop golden slice generator** (THE-652, #529), sized from the measured MDE.

#### Developer experience

- **JSON Schema published for `obsidian-tc.config.json`** (#465).
- **Dependency graph emitted; the plugin package is scanned** (#469).
- **Model service runtime Python deps locked** (#468).
- **Live LangExtract extraction wired in docs-ingest** (THE-444, #487).
- **`check-ticket-drift`** flags open tickets the code already cites (THE-540, #431).
- **Test concurrency bounded to the host** — worker cap, cross-process lock, cgroup backstop (#517).

### Fixed

- **A judge failure is `unjudged`, not `no_conflict`** (THE-613, #522). A gateway outage was
  byte-identical to a clean vault.
- **`patch_note` replace no longer consumes an entire note** (THE-603, #510) — it had truncated a
  912-line note to 30.
- **`work_forget` writes the forget-log audit row** (THE-600, #511).
- **`add_observation`'s read + render + append share one write lock** (THE-573, #484, #445).
- **The one genuinely exposed deferred-`BEGIN` site converted**, not the nine listed (THE-587, #478).
- **Exact KNN ties broken by `chunk_id`** so nDCG is host-independent (THE-582, #451).
- **`vault_generation` bumped by derived-plane writers too** (THE-579, #442).
- **Jobs-table growth bounded** — terminal retention sweep + id-only payload (THE-571, #444).
- **Migration SQL embedded** so standalone binaries actually run (THE-578, #430).
- **`treeDirty` read its own output**, so it was always true (THE-581, #455).
- **Unresolved side of cross-path dedup counted** (THE-588, #491).
- **`recordIngestStats` threaded through the MCP `index_vault` path** (THE-590, #502).
- **Native I/O test asserts what the loaded implementation produces** (THE-608, #521).
- **Docs no longer describe deleted config keys as working** (THE-598, #505); streaming walk and
  `gatedRerank` given a config surface (THE-591, #495).
- **`docgen:facts-check` has a non-empty floor** and the `ci-prose-suggest` firehose is removed
  (THE-601, #527); metrics catalog generated and the marker scan widened (THE-595, #493);
  bidirectional marker guard + docs-ingest CI (#488).
- **Tool-count gate no longer passes while stale** (THE-580, #443); all 38 unmapped tools mapped to
  facade domains and gated (THE-577, #426); G2.1's tool snapshot date-stamped (THE-596, #501).
- **`TREE.md` / `dependency-graph.json` stop conflicting by construction** (#504).
- **`packages/shared` TypeScript pin aligned with root** (THE-597, #500).
- **The vacuous `not-to-dev-dep` rule replaced with a source-scan gate** (THE-593, #494).
- **`SECURITY.md` supported-version table corrected and drift-gated** (THE-562 P0.3b, #483).
- **Release fixes**: version derived from `package.json` rather than the ref name (#429), publish
  straight to the release dist-tag (THE-574, #425), a partially-failed release made resumable
  (THE-575, #424).
- **THE-458 remainders closed** — reachable deferral, dead `registerPlaneScheduler` removed, size
  caps on the two regressed files (#530). Control arm settled and asserted before measurement
  (THE-532, #462). Default-surface decision recorded and the tool count de-duplicated (#476).

## [1.11.0] - 2026-07-24

### Verification and release infrastructure

Six PRs landed after the version was rolled and before the tag was pushed. They are in the 1.11.0
artifact, so they are documented here rather than deferred to 1.12.0. No runtime behaviour changes.

- **Release tags are now signed and CI refuses an unverified one** (THE-528, #421 + #422). The `v*`
  tag triggers the entire release — image build, npm publishes, SBOMs, provenance — and was the one
  input nothing authenticated. A maintainer key is registered and its public half committed to
  `.github/allowed_signers`; `verify-tag` enforces. Two defects were fixed to make that real: the
  job **gated nothing** (no `needs:` edge, so `build-native` ran in parallel and a failing check
  could not stop an immutable npm publish), and adding that edge would have broken every
  `workflow_dispatch` dry run until guarded on `github.ref_type`. Verified in both directions —
  a signed listed signer passes, an unlisted signer and an unsigned tag each exit 1.
- **New gates: `cargo-deny`, `typos`, `lychee`, `actionlint`, `osv-scanner`, `trivy`** (#414, #417,
  #419). Each was configured down to a genuine zero first — unconfigured they report 120, 318 and
  318 findings respectively on correct code, because this repo deliberately contains truncated SQL
  fixtures, homoglyph poison-scanner payloads, and Astro root-relative links. `trivy` scans the
  built image, closing a layer every lockfile scanner is blind to. `knip` is configured but
  deliberately not gated: its remaining findings are invisible-to-static-analysis by design.
- **`docs-ingest`'s web path was dead and is fixed** (#419). It called a metered hosted API whose
  credits are exhausted (HTTP 402) with no fallback, so every `http(s)` and `.html` ingest failed.
  Now renders through a self-hosted crawl4ai server over plain HTTP — no new dependency.
- **TREE.md's dependency graph is generated and drift-gated** (`just map`, THE-470, #418). It
  carried a standing "will drift" warning and had: 232 modules/785 dependencies committed against a
  real 246/978.
- **Dead code removed** (THE-570, #420): the superseded in-memory contradiction drainer, two dead
  exports, and its boundary-gate allowlist entry. Unreachable modules 4 → 3.
- **Four live 404s fixed on the published docs site** (#420), found by link-checking the *built*
  output — three stale `/obsidian-tc/` prefixes left by the move to a custom domain, and a
  `favicon.svg` referenced by every page with no such file. Source-level checking cannot see these:
  a root-relative link has no meaning relative to a `.md` file.
- **An SBOM of the container image** (#420). The existing step runs `npm sbom` — dependency trees
  only — so the Debian base, bun runtime and native binary that actually ship had no bill of
  materials.
- **Pre-commit hooks** (#419): seven gates via `prek`, previously CI-only.

### Added

- **`doctor` surfaces retrieval-head readiness independently** (`retrieval.heads` check; audit #16):
  the health surface reported no per-head status, so a `retrieval.sparse`/`retrieval.colbert` stream
  enabled in config but unbacked by the embeddings provider (only `bge-m3`/`model-tier` emit the
  multi-vector heads) was a silent no-op. `obsidian-tc doctor` now reports **dense**, **sparse**,
  **ColBERT**, and **reranker** readiness separately — each `ready` / `off` / `INERT` (enabled but the
  provider emits no head, a warning with remediation) — so an operator can see which streams are
  actually live. Derived from `config.embeddings` + `config.retrieval`; no runtime probe.
- **Vendor / external-docs read surface (THE-444).** Two read tools over a reserved,
  read-only docs-corpus vault, isolated from the private vault by a new `read:docs` scope
  and surfaced under a new `docs` facade domain:
  - `knowledge_search` — the docs-scoped analogue of `vault_graph_search`, reusing the
    contextual dense + BM25 + RRF graph retrieval bound to the corpus vault. No reranker,
    per the THE-441 re-adjudication (reranking lost decisively on the golden set).
  - `knowledge_get_critical` — a frontmatter `severity == "critical"` pre-filter: the
    breaking-changes / security / production-gotcha set to read before starting work,
    optionally narrowed to one source.

  Tool surface 141 → 143 (registry test + coherence gate + doc headlines in lockstep).
- **`services/docs-ingest`** — the ingestion scaffold for the docs corpus. A smart
  parse-router (Docling for PDF/Office, Firecrawl for web, passthrough for Markdown,
  unknown → Docling) feeding a LangExtract extraction interface and a writer that emits
  Markdown + frontmatter into the corpus vault the server indexes. Live backends are
  lazy-imported; `dry_run` exercises the route-to-write loop with no heavy deps. Live
  extraction and the crawl driver are a follow-up.

Security-audit follow-ups (external review of v1.10.0). No behavior change for a
correctly-configured deployment; these close residual seams and align the docs with
the code. The larger finding — folder-ACL enforcement being a per-handler convention
rather than a dispatch-pipeline stage — is tracked separately as its own change (#280)
because it is an architectural refactor, not a contained fix.

### Security

- **Two HIGH dev-dependency advisories closed, and the override that caused one of them bounded**
  (root + `docs/` `package.json`): `bun audit` reported `postcss <=8.5.17`
  (GHSA-r28c-9q8g-f849, path traversal in source-map auto-loading) in both workspaces, and
  `js-yaml >=5.0.0 <=5.2.1` (GHSA-pm4m-ph32-ghv5, exponential parse time in flow collections)
  at the root. Both are build/test-time only — `postcss` arrives via `vitest`/`astro`, `js-yaml`
  via `@napi-rs/cli` — so no shipped artifact was affected.

  The `js-yaml` finding was self-inflicted: the root override read `">=4.3.0"` with **no upper
  bound**, and an unbounded override does not merely permit a newer major, it *forces* every
  dependent onto it — dragging `@napi-rs/cli` (which declares `^4.2.0`) across a major boundary
  into the vulnerable 5.x line. The advisory's range starts at 5.0.0, so the fix is to stop
  hoisting rather than to chase the patch: the root override is now `">=4.3.0 <5"`, matching what
  the `docs/` workspace already had, and resolution returns to 4.3.0. `postcss` is pinned
  `">=8.5.18 <9"` in **both** workspaces — `docs/` carries its own lockfile and is not covered by
  a root audit, so an override added only at the root would have left it exposed.

  Both workspaces now report `No vulnerabilities found`. Verified beyond the audit: docs site
  builds, the native `napi` build (the actual `js-yaml` consumer) compiles, typecheck + lint clean,
  1901 server tests pass.
- **Per-caller ownership of retrieval feedback** (`migrations/20260724_001_chunk_retrievals_caller.sql`,
  `experiential/log.ts`, `tools/m8/experiential-tools.ts`; THE-568, closing the P1.7 follow-up):
  `chunk_retrievals` carried only `session_id`, so `record_retrieval_feedback` could only scope
  a non-elevated caller to a *session* — a caller who knew a foreign `session_id` could stamp
  that session's feedback/outcome regardless of who actually produced the retrieval. The table
  now carries a `caller` column, stamped by the retrieval logger at every serve-path call site
  (`search_text`/`search_vault` semantic mode, `vault_context`, `vault_graph_search`, `reflect`,
  `knowledge_search`, `knowledge_challenge`); `record_retrieval_feedback` adds an
  `AND caller IS ?` ownership predicate to its UPDATE (mirroring the `agent_episodes` /
  `work_forget` pattern) on top of the existing session scoping, so a non-elevated caller may
  only stamp retrievals it caused itself. `admin:workspace` crosses both. Zero blast radius on
  single-principal deployments; pre-migration rows with a `NULL` caller are simply unclaimable
  by a non-elevated caller (fail closed), same as an unknown id.
- **Experiential poison scanner canonicalizes before matching** (`experiential/poison.ts`):
  NFKC-normalize + strip zero-width/bidi controls before the content families run, so
  homoglyph (fullwidth "ｉｇｎｏｒｅ") and interleaved-invisible ("i​gnore … instructions")
  evasion folds into the existing patterns instead of slipping the scan. ASCII payloads are
  unchanged by normalization, so the red-team corpus stays at 100% with a 0 false-positive
  floor; new regression cases cover the evasion classes. Layer 1 remains a
  precision-leaning pattern scanner, not a complete filter (now documented as such in
  SECURITY.md) — the eligibility contract + reader trust floor are the real guarantee.
- **Prompts run through governance** (`mcp/server.ts`): `prompts/list` and `prompts/get`
  were the last MCP surface bypassing `ToolRegistry` entirely (no rate limit, no audit row).
  They now route through `dispatchResource` like resources did after THE-415 — throttle +
  audit + metrics — with `[]` scopes, so the open static-template semantics are preserved
  while "every invocation is audited" holds for the prompt surface too.
- **Constant-time bearer comparison in the bge-m3 embedding service**
  (`services/bge-m3-service`): the auth check used `!=` on the bearer string, leaking
  match length by timing; it now uses `hmac.compare_digest`.
- **qwen-tei helper binds loopback by default** (`services/qwen-tei/run.sh`): TEI has no
  auth, so the publish now defaults to `127.0.0.1` (override `BIND_HOST=0.0.0.0` behind a
  trusted network) instead of exposing the embedding backend on all interfaces.
- **Table-identifier allowlist on `countRows`** (`tools/m1/registry-tools.ts`): the one
  interpolated SQL identifier (always the literal `"chunks"`) is now gated on a fixed
  allowlist — defense-in-depth against a future caller ever forwarding one.
- **Folder-ACL enforcement is now a dispatch-pipeline stage, not a per-handler convention**
  (THE-414): tools declare the vault paths they touch via a `pathAcl` extractor on
  `ToolDefinition`, and `registry.runDispatch` enforces the folder ACL (the same
  symlink-canonical `enforcePathAcl`) for every declared path right before the handler — so
  containment no longer depends on each of ~120 handler call sites remembering to gate. This
  closes the "a handler forgot to gate" class that produced the v1.9.1 `strictReadDefault`
  regression (silently ignored in 8 tool files). Handler-side `enforcePathAcl` stays as
  defense-in-depth; paths a handler computes at runtime (backlink-rewrite targets, periodic
  resolvers, entity/session paths) remain handler-enforced and are documented exemptions. A
  guarantee test (`acl-extraction-coverage`) fails CI if any mutating tool declares neither an
  extractor nor an exemption, plus a test proves the central gate denies even when the handler
  never calls `enforcePathAcl`. The "central pipeline, folder ACL is a stage" claim in the
  README/ARCHITECTURE is now literally true.
- **Pinned the gitleaks scanner image to an immutable digest** (`ci-security.yml`; THE-426):
  the secret-scan job ran `ghcr.io/gitleaks/gitleaks:latest`; it now pins the `@sha256:` digest
  (refresh instructions in-line). Completes the supply-chain SHA-pinning pass (GitHub Actions
  were pinned in #272).
- **Namespaced the derived-cognition plane** (`migrations/20260724_001_plane_vault_id.sql`,
  `plane/jobs/{contradiction,synthesis}.ts`; THE-563): `contradictions` and `syntheses` carried
  no `vault_id`, so a weekly synthesis blended every vault into one record and path-equal notes
  in different vaults collided on the contradiction readers. Both tables now carry `vault_id`
  (contradiction dedup index re-scoped to `(vault_id, source_content_sha, conflict_content_sha)`;
  `syntheses` PK `(vault_id, iso_year, iso_week)`), the detector folds `vault_id` into the row id,
  and `runSynthesis` runs per vault. Following THE-310's `vault_edges` precedent the migration
  **purges** the unscoped rows (regenerable derived caches with unrecoverable historical vault)
  rather than backfilling a guess. Extends the vault-isolation invariant THE-310 established.
- **All-source ACL on derived objects before return / model egress** (`tools/m7/knowledge-tools.ts`,
  `experiential/forget.ts`; THE-564): a contradiction row exposed — and could send to the inference
  gateway — both contributing sources plus a rationale after checking only the caller-supplied
  side, so the opposite side could sit outside the caller's readable set. `openContradictionsForPaths`
  now drops any row where *either* `source_path` or `conflict_path` is unreadable, at all four call
  sites including the model-egress paths (`knowledge_challenge`, `reflect` challenge-mode) — the
  vault predicate (THE-563) is the first gate, per-path ACL (the THE-543 recheck pattern) the second.
  Also scoped `forget.ts`'s dependency-mention counts to the caller's vault. Syntheses (whole-vault
  aggregates with no per-source list) remain vault-predicate-gated, a documented boundary.
- **Per-path rule-scopes are now enforced** (`vault/acl-path.ts`, `mcp/registry.ts`,
  `tools/m6/admin-tools.ts`, `mcp/resources.ts`; audit P1.4): `acl.rules[].scopes` / `acl.defaultScopes` were computed
  by `scopesForPath` but only fed the cache fingerprint and the `inspect_acl` display — the config
  shape implied a per-path authorization dimension the code never enforced. They are now
  load-bearing (Require semantics): a caller must hold every scope a matching rule declares, on top
  of the tool's own required scopes, to operate on that path. Enforced centrally at dispatch (on the
  symlink-resolved path, so an in-vault symlink can't dodge a scope-gated target). The MCP
  `resources/read` content endpoint honors the same gate (it reads the same bytes as `read_note`, so
  it must not be a bypass); `inspect_acl` applies the same check (`denied_by: "path_scope"`) so the
  diagnostic can't drift from enforcement.
  Empty rule/default scopes add no requirement, so no shipped or live config changes behavior. The
  config docs/schema were reframed from the misleading "scopes granted to a path" to "required".
  Boundary: enforcement covers every tool that declares its paths via a `pathAcl` extractor (the
  central dispatch stage) plus the `resources/read` content endpoint. One surface remains folder-ACL
  only and is a tracked follow-up: search/enumeration *result visibility* (`readableRel`, governed by
  `readPaths`). The periodic-note and memory-entity tools, whose fs access was gated only
  handler-side with no rule-scope check, are closed by THE-567 below.
- **Rule-scopes now reach the periodic-note and memory-entity tools** (`tools/m3/periodic-tools.ts`,
  `tools/m5/memory-tools.ts`, `memory/materialize.ts`; THE-567, closing the P1.4 boundary above):
  `create_periodic_note`, `find_or_create_periodic_note`, `append_to_periodic_note`, `create_entity`,
  `add_observation`, and `link_entities` compute their real vault path from server config (the
  periodic-notes resolver; the memory folder) rather than caller input, so P1.4's central `pathAcl`
  dispatch stage — which only ever sees parsed input — could not reach them; they were folder-ACL
  gated but NOT rule-scope gated. `create_periodic_note`'s `template_override` (which *does* arrive
  verbatim in input) now has a `pathAcl` extractor and is centrally enforced like any other declared
  path. Every other config-computed path in these six tools now threads the caller's granted scopes
  into its existing handler-side `enforcePathAcl` call, so the rule-scope gate applies there instead
  of being silently skipped. Zero behavior change for a config with no rule-scopes (the shipped
  default); a caller lacking a rule-scoped folder's scope is now denied instead of allowed.
- **Experiential caller-partition is now an authorization boundary, not a default filter**
  (`tools/m8/experiential-tools.ts`; audit P1.7): the per-principal partition on the work-memory
  tools could be crossed at will — `work_search`/`work_episodes` `any_caller: true` needed only
  `read:workspace`, `work_forget` tombstoned any episode id with no ownership check, and
  `record_retrieval_feedback` stamped outcomes across sessions. Crossing the partition now requires
  an elevated `admin:workspace` scope: `any_caller` is forbidden without it; `work_forget` scopes its
  UPDATE to the caller's own episodes (a foreign/unknown id is a silent no-op — no existence oracle)
  unless elevated; feedback is scoped to a session (the given `session_id` or the caller's active
  session), and an unscoped cross-session stamp requires the scope. Zero blast radius on
  single-principal deployments. Boundary: `chunk_retrievals` carries no caller column, so feedback
  ownership is enforced at session granularity, not per-caller — a true per-caller feedback owner
  needs a schema column (tracked as a THE-230 follow-up).
- **Vault isolation `kind` is now a code-enforced property** (`config.schema.ts`, `vault/registry.ts`,
  `tools/m7/knowledge-tools.ts`; audit P1.5): the `read:docs` surface (`knowledge_search`,
  `knowledge_get_critical`) resolved *any* vault id, so docs/private isolation rested on token
  provisioning + naming rather than a property — a misprovisioned docs token could read the private
  vault. Vaults gain a `kind: private | docs | system` config field (default `private`), and the docs
  tools refuse any vault whose kind is not `docs` (forbidden), so the read:docs surface is code-bound
  to the docs corpus. `add_vault` accepts an optional `kind`; `list_vaults` surfaces it. Zero blast
  radius: all existing vaults default to `private`, and a docs corpus is opt-in. Boundary at the time:
  enforcement was one-directional — the private `read:notes` tools (`vault_graph_search`, `read_note`,
  `write_note`, …) were not fenced OUT of a `docs`/`system` vault, so a docs corpus was read-only by
  convention, not by kind. The reverse (write/integrity) direction is now closed by THE-569, below.
- **Reverse vault-kind gate: mutation of a docs/system vault is now refused (THE-569, closing the
  P1.5 boundary above)** (`mcp/registry.ts`, `cli.ts`): P1.5 closed the read direction only — a
  misprovisioned `write:notes`/`delete:notes`/etc. caller could still resolve a `docs`- or
  `system`-kind vault by id and mutate it, since the private note tools apply no `kind` check. A
  new central dispatch gate (parallel to the existing `rootResolver`/`aclResolver` stages, keyed on
  the same mutating-scope signal `runDispatch` already computes for the read-only-ACL check) now
  refuses any mutating call — `destructive: true` or a required scope in the `write`/`delete`/
  `bulk`/`execute` family — whose effective vault (`input.vault ?? ctx.vaultId`) resolves to `docs`
  or `system`. Read calls on a docs/system vault are unaffected; this closes only the write/integrity
  direction. No per-tool annotation needed — reuses the existing mutating-scope classification, so
  every current and future write/delete/bulk/execute tool is covered automatically. Zero blast radius
  for the default all-`private` config (the gate no-ops with no `vaultKindResolver` wired, e.g. the
  `prefetch` CLI's standalone registry).

### Fixed

- **No keyed handler duplicates user data on retry** (THE-572, closing the residual #13
  documented but could not reach from the dispatch layer): #13 marks an idempotency claim
  `effect_committed` only when the whole handler *returns*, so a handler that committed effect #1
  and then did more fallible work still had a real window — a throw before the return deleted the
  claim and a retry **re-ran the handler**. Two keyed handlers duplicated user data outright:
  `add_observation` (SQLite append, then note re-materialize) appended the observation twice, and
  `append_note` / `append_to_periodic_note` (note write, then a post-write step) concatenated the
  content twice. Others corrupted bookkeeping rather than content — `start_session` inserted a
  second session row, `enqueue_capture` a second queue row, `write_note`/`copy_note` a second
  snapshot-ledger row consuming a retention slot — and `move_note`, `move_attachment` and
  `bulk_move_notes` answered a retry with `note_not_found` (or a wholly-failed batch) about the
  caller's *own* prior attempt. The fix is two-part:
  - **`ctx.markEffectCommitted()`** — a mid-execution signal that moves the marker to the
    handler's own first durable effect. Deliberately write-ahead: it can only over-report (a
    caller told to verify state when nothing in fact applied), never under-report a silent
    double-apply. The dispatch catch consults the **durable** claim state rather than the
    in-memory flag, so a signal rolled back with the handler's transaction still releases the
    claim for a real retry.
  - **Per-handler ordering/atomicity.** Where both effects are `ctx.db` writes — `add_observation`,
    `start_session`, `enqueue_capture` — the marker joins them in one transaction via a new
    `inTransaction` helper, so the effect and the claim either both land or neither does. Where the
    second effect is a *filesystem* write, no transaction can span it, so `add_observation` instead
    runs its **idempotent** effect first (a full-note overwrite, byte-identical on a re-run) and
    commits the SQLite side after.

  The heading says **user data** deliberately, and the scope is worth stating exactly. What is
  closed: no keyed handler appends, inserts or rewrites *caller content* twice on a retry. What is
  not: two handlers can still leave duplicate **bookkeeping** behind. `start_session` writes its
  JSONL trace before the row, so each failed attempt leaves an orphan trace file — unique per
  attempt, so never mistaken for a duplicate, and first-party readers are row-first and ignore it,
  but not idempotent. `bulk_create_notes` signals before its first worker, which bounds a crash
  mid-batch to a re-written file rather than a re-run batch, but its `overwrite`/`upsert` items are
  not individually idempotent.

  The other limit is the cost of ordering-first. `add_observation` renders the note from the state
  it is about to commit, so the projection can drift from SQLite — and under two *concurrent* calls
  it can end up **behind** it (both render from the same base, the last writer wins the file while
  both appends commit). Nothing schedules reconciliation: the note is corrected only when something
  later happens to rematerialize that entity, which may be never. SQLite remains the source of
  truth and every read path uses it, so this is a stale *projection*, not lost data — but it is not
  self-healing, and calling it that would be wrong.

  Also reconciles the #13 prose, which named a keyed-tool set that was never verified against the
  schemas. `extractIdempotencyKey` reads a top-level `idempotency_key`, the `bulk_idempotency_key`
  alias, **or a nested `options.idempotency_key`** — and every tool taking `WriteOptions` carries
  the nested one, which is easy to miss by grep. The full keyed set is `add_observation`,
  `enqueue_capture`, `start_session`, `create_periodic_note`, `append_to_periodic_note`,
  `bulk_create_notes`, `bulk_move_notes`, `write_note`, `append_note`, `move_note`, `copy_note`,
  `move_attachment`, `create_canvas` and `create_base` — **not** `commit_capture`, `link_entities`
  or `bulk_set_property`, which the #13 prose named but which never entered this pipeline.
- **At-most-once idempotency under post-effect faults** (THE-562 #13, closing the THE-413 residual):
  the dispatch pipeline deleted an idempotency claim on any failure *after* the handler had already
  committed its side effect (a strict-output-schema violation, a `JSON.stringify` failure on the
  payload, or an overflow-finalize fault), so a retry with the same key re-ran the handler and
  double-committed. The claim now advances through an explicit `state`
  (`in_flight → effect_committed → completed | indeterminate`): a post-effect fault records
  `indeterminate` instead of deleting, and a retry returns a typed `indeterminate_outcome` error
  rather than re-executing. A process crash after the effect is likewise honored on reclaim. The
  marker is set when the handler returns, so the residual window — a crash **or an in-process throw
  between a handler's first external effect and that return** (e.g. a multi-step handler that commits
  then does more fallible work) — is pre-existing, unchanged by this fix, and irreducible at the
  dispatch layer without atomic/idempotent handlers; it is documented at the call site.

### Changed

- **Background workloads run on the durable `JobQueue`** (THE-562 #14, extends THE-517): the
  contradiction-detection and plane-consolidation (synthesis + audit) workloads were driven by an
  in-memory queue that silently dropped work under backpressure and a bespoke timer that let a run
  vanish on a transient gateway failure. Both now enqueue durable jobs drained by one generic runner
  (`scheduler/job-runner.ts`) on the shared scheduler, so their work is crash-safe, leased,
  retryable, and dead-letterable. Contradiction jobs retry up to 3× with a content-sensitive
  idempotency key (`vault:chunk:contentHash`, so re-editing a note re-judges it rather than being
  deduped against a stale completed job); synthesis/audit run once per cycle and dead-letter
  immediately on failure (they regenerate next cycle) — a non-throwing `{ ok: false }` from
  `runSynthesis` now surfaces as a dead-letter instead of being marked complete. `server_health`
  gains a `job_queue` block (queued / running / retrying / failed + oldest-queued age) so backlog and
  persistently-failing workloads are visible. Closes the `job-queue.ts` "not yet wired to a workload"
  reachability-allowlist entry.
- **Recurrence guards for the release process** (THE-426): a `tsc` gate now runs at the top of
  `scripts/release.mjs` (shared build + server typecheck) so a type error that vitest/esbuild
  accept can never reach a published tag; and a scheduled `release-lag` workflow
  (`scripts/check-release-lag.mjs`) goes red when `main` drifts past a threshold ahead of the
  latest tag while carrying unreleased Fixed/Security CHANGELOG entries — the THE-285 pattern
  where critical fixes sat unshipped. Advisory (a scheduled nag), not a per-PR gate.
- **`reflect.persist` writes through the governed note-write service** (`vault/persist-note.ts`,
  `tools/m7/knowledge-tools.ts`; audit P1.6): the derived-reflection write used a raw `writeFileSync`,
  bypassing the snapshot, atomic tmp+rename, and index-on-write/generation bump — so a same-query
  same-day reflection silently overwrote its predecessor with no recovery point and left the note
  unindexed. It now shares one `persistGovernedNote` helper with `write_note`, so the two write paths
  cannot drift.
- **Single migration manifest + completeness gate** (`db/migration-manifest.ts`; audit #9): the
  cache.db and experiential.db chains were hand-enumerated in two files, so a `.sql` wired into
  neither chain silently never ran. Both chains now build from one manifest, and a CI bijection test
  fails when a migration file on disk is registered in neither chain.

### Documentation

- **Reconciled the retrieval-quality numbers** (`README.md`): the headline
  nDCG/recall/bridge figures were stated as fact in one place and "pending (THE-296)" in
  another. They are now labeled **provisional** — reproducible only against the private
  (not-checked-in) golden set and pending a live-backend re-run — while the statistical
  ship-rule *machinery* (unit-tested in CI) is what the repo actually ships.
- **Foregrounded the zero-config security posture** (`README.md`): made explicit that
  `obsidian-tc /path/to/vault` boots with auth off and no folder ACL (governance is
  opt-in), safe because the config fail-closes any non-loopback unauthenticated bind.
- **Documented the learned-state namespace model** (`SECURITY.md`,
  `experiential/reflect.ts`; audit P1.8): obsidian-tc's adaptive state is deliberately mixed —
  `agent_episodes` is per-principal (vault+caller+session, P1.7-authorized), `chunk_retrievals` and
  `vault_object_state` ACT-R activation are content/corpus-level by design (a relevance signal about a
  chunk, not a principal — per-caller would fragment it), and `preference_profile` is a single global
  runtime store. A new *Learned-state namespaces* table in SECURITY.md makes the intended scope of
  every store explicit, and the `preference_profile` global scope is recorded as an accepted
  single-user residual (per-caller preference isolation is a multi-principal follow-up). No behavior
  change.

### Performance

- **Cache the indexer reconcile-path statements** (`search/indexer.ts`, `search/vec.ts`;
  THE-316): `applyNoteWrites`, `upsertVec`, and `deindexNote` compiled their static-arity SQL
  with raw `db.prepare(...)` on every note and every re-embedded chunk. Under `bun:sqlite`
  (the production runtime) `db.prepare` is uncached, so a 100-note flush recompiled ~500+
  statements. These paths now use `cachedPrepare(db, sql)` (memoized by SQL text, already the
  sanctioned mechanism for the audit/idempotency hot paths), collapsing the recompiles to a
  handful for the process lifetime. Biggest win on warm `index_vault`. No behavior or schema
  change; dynamic-arity queries stay on plain `prepare`.

### Included pull requests

The narrative sections above cover the changes that alter behaviour or contracts. This is the
complete manifest of the 95 user-visible pull requests in `v1.10.0..HEAD`, so nothing in a
136-commit release is silently absent from the notes — which is exactly what the release gate in
`scripts/release.mjs` exists to prevent.

- #277 — feat(release): fail the cut when a user-visible PR has no CHANGELOG entry
- #281 — fix(security): audit follow-ups — poison canonicalization, prompt governance, service hardening
- #282 — perf(indexer): cache reconcile-path statements with cachedPrepare (THE-316)
- #283 — feat(dispatch): make folder-ACL a dispatch-pipeline stage via declarative path extraction (THE-414)
- #286 — fix(facade): map vault_context to the knowledge domain
- #287 — feat(docs): vendor/external-docs read surface (knowledge_search + knowledge_get_critical)
- #288 — feat(ingest): docs-ingest scaffold with a Docling/Firecrawl parse-router
- #291 — fix(links): treat escaped pipe (\|) as the wikilink alias separator
- #296 — feat(indexer): two-tier content_hash / body_sha cross-path embedding dedup
- #298 — feat(eval): failure taxonomy + BFS reachability probe (eval-only)
- #297 — feat(ranking): config-driven frontmatter metadata prior (authority boost), off by default
- #295 — feat(search): off-by-default bubble-safe activation composition (THE-233)
- #293 — fix(indexer): GC contradiction flags when a chunk is pruned or re-embedded (#280-followup)
- #300 — feat(eval): --diagnose wires the failure classifier into runEval (THE-446)
- #299 — feat(indexer): cross-run body_sha dedup — seed the registry from the persisted column (THE-445)
- #301 — feat(search): pre-plumb bubble-safe on the default graph_rrf/convex path, strictly off (THE-447)
- #304 — fix(acl): resolve per-vault ACL at indexing time (THE-453)
- #305 — fix(auth): bind JWT audience/issuer for remote/JWKS deployments (THE-456)
- #306 — fix(indexer): serialize index-on-write per (vault,path) (THE-455)
- #307 — fix(indexer): copy the vector for cross-path dedup chunks (THE-454)
- #308 — fix(search): rebuild vec index on an embedding-dimension change (THE-457)
- #309 — fix(plane): single-flight guard on the scheduler (THE-457)
- #310 — fix(mcp): optional strict output-schema enforcement (THE-457)
- #311 — fix(cli): continuous contradiction drain + graceful shutdown (THE-457)
- #312 — fix: hygiene — audit-write health + remove stale biome suppressions (THE-457)
- #314 — feat(docgen): config extractor — walk the Zod schema into ConfigDoc[] (THE-471)
- #315 — feat(docgen): tools extractor — full registered surface → ToolDoc[] (THE-471)
- #316 — feat(docgen): renderers + render CLI — model → wiki pages (THE-472)
- #318 — feat(docgen): Astro docs-site integration (THE-474)
- #319 — feat(docgen): metrics, errors + schema extractors (THE-471)
- #321 — feat(docgen): advisory LLM prose suggestion tool (THE-477)
- #329 — feat(index): complete the vec-index fingerprint beyond dimension (THE-460)
- #327 — fix(security): second-pass audit remediation — read-ACL on write, enrichment-safe dedup, auth/index/plane hardening
- #331 — build(docs): upgrade Astro 6→7 + Starlight 0.39→0.41 (THE-498)
- #333 — build(deps): clear the Hono/fast-uri advisories (7 -> 0)
- #332 — fix(acl): stop FolderAcl handing out live config references + bound glob length
- #334 — build(docs): clear the docs-workspace advisories + audit that workspace in CI
- #335 — perf(acl): read the whitelist once in the index-time visibility predicate
- #336 — feat(auth): typed rejection reasons + auth_rejections_total (THE-520)
- #340 — fix(scheduler): apply backoff to the in-memory schedule + honour the AbortSignal (THE-462)
- #341 — fix(vec): filter the rebuild backfill by model, not just dimension (THE-460)
- #342 — fix(perf): report peak RSS honestly instead of extrapolating per 10k chunks (THE-459)
- #343 — feat(perf): HTTP cold/warm handshake collector, family 12 (THE-495)
- #345 — build(release): pin model-service CI deps by hash + report unsigned release tags (THE-528)
- #347 — perf(db): composite dedup index on (vault_id, body_sha, content_hash) (THE-502)
- #348 — perf(indexer): memoize the schema-shape probes per connection (THE-491 item 1)
- #350 — feat(eval): per-category metric slices (THE-449 remaining criterion)
- #354 — feat(capability): environment detection — Obsidian, vaults, plugins, hardware (THE-522)
- #355 — feat(doctor): runtime-health command with a machine-readable report (THE-521)
- #356 — feat(bridge): version handshake + bridge.state + compat matrix (THE-523)
- #357 — feat(tools): refresh_plugin_capabilities — re-probe without restart (THE-527)
- #358 — fix(retrieval): brute-force fallback must filter by active model (THE-530)
- #359 — fix(indexer): re-embed on model swap + deactivate superseded rows (THE-531)
- #360 — feat(config): securityProfile "hardened" — one key for the least-privilege posture (THE-526)
- #361 — perf(indexer): density-aware embed token estimate to cut bisection retries (THE-487)
- #362 — feat(retrieval): stamp note freshness (age_days + stale) on hits (THE-450)
- #363 — perf(indexer): aggregate dedup logging instead of per-duplicate stderr (THE-499)
- #364 — perf(indexer): bulk-load chunk state once per reconcile, not per note (THE-501)
- #365 — perf(indexer): byte-bounded, configurable batch transactions (THE-500)
- #366 — perf(indexer): memoize dedup-vector lookups within a flush batch (THE-488)
- #367 — perf(activation): incremental recompute past a watermark, not a full-log rescan (THE-461)
- #368 — perf(mcp): cache immutable catalog products + extend serialization memo (THE-463)
- #369 — feat(cache): vault-generation counter + ACL fingerprint (THE-496)
- #370 — feat(retrieval): multi-query fan-out fusion engine (THE-448)
- #371 — feat(retrieval): agent-supplied HyDE on vault_graph_search (THE-451)
- #373 — perf(search): delta-only derived-edge densification (THE-486)
- #374 — feat(search): opt-in streaming vault walk for indexVault (THE-490)
- #375 — perf(native): optimize cosine_batch — precomputed query norm, single-pass docs (THE-504)
- #376 — perf(harness): subprocess isolation, contention detection, statistics (THE-503)
- #377 — feat(scheduler): durable job queue with leases and crash recovery (THE-517)
- #379 — fix(retrieval): expose adaptive RRF as config + correct the inert activationRerank description (THE-536, THE-535)
- #382 — feat: get_index_status + list_contradictions reader tools (THE-491)
- #383 — fix(security): bind the vault_context prewarm cache to the caller's ACL (THE-543)
- #385 — fix: replace literal NUL bytes in source with escapes + guard (#378)
- #387 — fix(retrieval): thread every config knob to all four graphSearch sites (THE-545)
- #388 — fix(ci): pass install-mode through env, not run: interpolation (THE-541)
- #389 — fix(scheduler): observe lost leases instead of discarding them (THE-517)
- #390 — fix(capability): bound the hardware enricher so its degrade path can run
- #394 — feat(eval): persistent run history with corpus provenance (THE-560)
- #395 — fix(http): serve natively under Bun to stop keep-alive connection drops (THE-561)
- #396 — fix: audit bucket-A — reflect.persist wildcard scope, prewarm invalidation, SECURITY version (THE-562)
- #397 — fix(experiential): hold known-bad-outcome episodes; state the promotion contract (THE-565)
- #398 — feat(docgen): narrative fact gate + reconcile drift to 146/n=250 + enforce (THE-566)
- #402 — fix(THE-562 tail): cross-platform npx in boundary check (#17) + disclose bm25_weight caveat (#15)
- #403 — feat(THE-562 P1.4): enforce per-path rule-scopes at the central dispatch ACL stage
- #404 — feat(THE-562 P1.7): make the experiential caller-partition an authorization boundary
- #405 — feat(THE-562 P1.5): code-enforce vault isolation kind (private|docs|system)
- #407 — feat(THE-562 #16): surface retrieval-head readiness independently in doctor
- #408 — feat(THE-562 #14): wire the durable JobQueue to its workloads
- #409 — feat(THE-562 #13): durable idempotency claim state-machine
- #410 — feat(THE-562): thread rule-scopes into periodic + memory tool paths
- #411 — feat(THE-562): per-caller ownership of retrieval feedback
- #412 — feat(THE-562): reverse vault-kind gate — reject mutation of docs/system vaults (THE-569)
- #415 — fix(deps): close 2 HIGH bun-audit advisories; bound the js-yaml override
- #413 — fix(THE-562): close the intra-handler idempotency window (THE-572)

## [1.10.0] - 2026-07-17

Minor rather than patch because nothing here is dark: unlike v1.9.1's additions
(all off by default), every change below is live for an existing user on default
config.

### Fixed

- **npm did not ship SKILLS.md (affects v1.9.1 and earlier)** (#270): the agent
  onboarding guide lives at the repo root, which belongs to the unpublished
  `obsidian-tc-monorepo` package, and npm's `files` cannot reference paths
  outside the package directory — so `files: [dist, README.md, LICENSE]` had no
  way to pick it up and it reached GitHub only. It is now vendored into
  `packages/server/` at build time (the same mechanism already used for the
  companion plugin) and listed in `files`. The repo root stays the single source
  of truth; the copy is generated and gitignored, so the two cannot drift.

### Security

- **Latent stale-plugin vendoring hazard closed** (#270): `copy-assets.mjs`
  rebuilt the companion plugin only when `dist/main.js` was ABSENT, so any build
  left over from before a version bump would be vendored verbatim into the
  tarball. **This never affected a published release** — `publish.yml` builds the
  plugin in a fresh checkout, where no stale `dist` exists, so CI always rebuilt
  it (verified: the published 1.9.1 tarball carries a correct 1.9.1 plugin). It
  bit local and developer builds only. The hazard is real regardless, and
  `check-version-coherence.mjs` could not have caught it: it asserts
  `packages/plugin/manifest.json` — the SOURCE, which was always correct — and
  nothing asserted the artifact that ships. The plugin is now always rebuilt
  before vendoring, the vendored manifest is asserted against the server version,
  and a failed vendor drops the directory rather than publishing a mismatch. A
  ci-install-smoke tarball guard packs for real and asserts the published bytes
  on all three OSes.
- **Every GitHub Action pinned to a full commit SHA** (#272): 83 of 89 `uses:`
  lines ran on mutable tags, so each workflow was one upstream retag away from
  running different code with our token. Two upstreams had already moved —
  `dtolnay/rust-toolchain@stable` had DIVERGED from the pinned sha, and
  `Swatinem/rust-cache@v2` was 1 ahead. Version drift reconciled onto the highest
  version already proven in-repo. `actions/upload-artifact` v4/v7 deliberately
  left un-reconciled (publish.yml runs a matched v4 upload/download pair).

### Added

- **Hardened deployment profile + startup security posture** (#269): a
  schema-valid least-privilege `examples/config.hardened.json`, and a
  `security: auth=… readOnly=… strictRead=… requireCas=… http=…` line written to
  **stderr on every startup**, with a warning when the permissive trusted-local
  defaults are active. Governed by default is not least-privilege by default.
- `obsidian_tc_audit_write_failed_total` (labels: `vault`, `tool`) — counts
  security-audit event writes that failed. Audit is fail-open by design (a failed
  write must never break dispatch), so the failure was previously silent and the
  audit trail could go lossy with no signal. Prometheus catalog is now 9 counters,
  2 histograms, 4 gauges. (THE-416)
- Ambient context capture: design spec plus macOS / Windows / Linux phase plans
  land as docs. Design only — no product code (THE-175).

### Changed

- **`resources/read` and `resources/list` are now rate-limited and audited**
  (THE-415, #273): both bypassed `ToolRegistry.dispatch` entirely. They were not
  unguarded — `resources.ts` enforced the `read:notes` scope, vault binding, the
  folder read-ACL, and path containment — but they escaped GOVERNANCE: the
  THE-210 limiter never saw them, so a `read:notes` caller could pull the whole
  vault in a loop with no budget, and no audit row was written. Both now route
  through `ToolRegistry.dispatchResource`, and dispatch's audit closure is
  extracted into one shared `recordOutcome()` so the two surfaces cannot drift
  again. **A heavy resource client that was previously ungoverned can now be
  throttled.**
## [1.9.1] - 2026-07-15

### Added

- **Graph densification (experimental, off by default)** (#250): derived edges
  added to the `vault_edges` graph beyond authored wikilinks — `shared_tag`
  (frontmatter tag co-occurrence), `similar_to` (vec0 kNN semantic neighbours, no
  egress), and `semantically_similar_to` (LLM Pass-3 via the local inference
  gateway, injection-defended, batch-only). The graph walk can optionally traverse
  them, down-weighted vs authored links. Governed by `retrieval.densify.*` (every
  flag off/conservative by default). Derived and rebuildable — never written back
  into notes as wikilinks; hub tags/nodes emit no edges. **Unmeasured and dark**:
  it ships behind flags pending a multi-hop golden-set A/B (the prior THE-135
  virtual-hop hit an 80% bridge-recall ceiling below the champion's 0.831), exactly
  like `retrieval.sparse` / `retrieval.colbert`. See
  `docs/plans/2026-07-13-graph-densification.md`.
- **Densify follow-ups** (#251): `index_vault` threads `retrieval.densify`
  (`tagEdges` / `knnEdges` build derived edges during indexing, full-state per
  kind), and a new `obsidian-tc densify-llm [path] [--vault id]` CLI runner builds
  the LLM Pass-3 `semantically_similar_to` layer via the local gateway (refuses if
  no gateway resolves). Both off by default.
- **Experiential activation recompute on the serve path** (#259): the ACT-R
  activation recompute now runs during `serve` (gated on capture, on the
  maintenance cadence), not only via the CLI, so cached activation scores stay
  fresh as retrieval logs accrue. `activationRerank` remains off by default.

### Fixed

- **Data-loss fix (affects v1.9.0): the FTS divergence repair deleted durable
  note metadata.** `ensureNotesFts` treated an empty or absent derived
  `notes_fts` index as authoritative and ran `DELETE FROM notes` (the durable
  table). Reachable without corruption via the supported `OBSIDIAN_TC_DISABLE_FTS=1`
  flag (or a swallowed FTS error): one run leaves `notes` populated and
  `notes_fts` empty or absent, and the next wipes note metadata (on the
  single-note index path, one file save wiped the vault and re-added one row),
  silently degrading FTS/lexical search until a full re-index. The repair now only
  prunes FTS orphans and blanks the stale `content_hash`; it never deletes from
  `notes`.
- **Read-ACL: `strictReadDefault` was ignored in 8 tool files (affects v1.9.0).**
  Consolidated to a single read-ACL predicate so `strictReadDefault` is honored
  uniformly across the frontmatter / graph-health / links / notes / tags / index /
  search / base / canvas / kanban / periodic / tasks / knowledge read tools; added
  ACL single-source and enumeration regression tests.
- **Idempotency post-effect retry no longer re-executes a committed side effect.**
  When a keyed write's response exceeded the byte budget, the claim was deleted, so
  a retry with the same key re-ran the already-committed effect. The claim is now
  finalized with the terminal overflow outcome and the replay path re-checks the
  budget, so a retry replays the overflow error instead of re-executing.
- **Built-CLI asset resolution** (in the bundle, not source): the migrations
  directory and cache provisioning now resolve against the built `dist` bundle, so
  the shipped CLI boots. The regression was invisible to the source tests and caught
  only by the install-smoke.
- **ReDoS in the vault-leak guard's path regex** removed (`js/redos`).
- **BGE-M3 reranker `device="auto"`** is resolved to cuda/cpu before
  `CrossEncoder` (sentence-transformers 5.x passes device straight to
  `torch.to()`, which rejects "auto"), so the optional service loads its reranker
  under default config (#263).
- **Config off-switches**: `retrieval.densify.llmEdges` is now a real off-switch,
  and four keys that gated nothing were removed.
- Doc coherence: the README comparison-table tool count (`~123` to 141) is now
  covered by the version-coherence gate.
- **Graph densification correctness hardening** (external audit of the first cut;
  all in the dark, unreleased feature — no v1.9.0 behaviour changes): a failed
  gateway run no longer erases the LLM edge layer (`extractSemanticEdges` reports
  `failedBatches`; the runner refuses to reconcile a partial run); turning
  `tagEdges` / `knnEdges` off now actually prunes those edges (the reconcile runs
  every pass with an empty desired set, instead of being gated behind the flag);
  derived edges are upserted so a changed confidence / fingerprint refreshes
  instead of being silently kept stale; an authored (literal) edge now wins an
  equal-hop tie in the walk, so a wikilinked note is never mislabelled derived and
  down-weighted; the LLM runner orders notes by path for deterministic batching;
  and the edge fingerprint covers both endpoints rather than the alphabetically
  first one. Two doc overclaims corrected: the fingerprint does not "self-flag
  stale" (no sweep exists yet), and the prompt-injection wrapping is
  defense-in-depth, not a guarantee of inertness — the output contract (known
  paths + discrete confidences) is the real blast-radius limit.

### Security

- **Repository vault-data containment.** The multi-hop golden set is private vault
  data and is no longer committed (moved out of the repo); a CI guard now rejects
  vault data (databases, golden-set shapes, known vault paths) before it can land;
  and a real vault path that a merge brought onto `main` was scrubbed.

### Documentation

- **Agent onboarding guide** (`SKILLS.md`, #265): a working guide for AI agents and
  the humans configuring them, covering the governance mental model, setup and the
  companion plugin, the find/describe/call discovery loop, a capability map by
  intent, the genuinely new features, safe-operation rules, agent playbooks, an
  example vault-convention set, and a config quick reference.

## [1.9.0] - 2026-07-13

### Added

- **Polyglot model tier** behind the `ModelClient` boundary (#239, #245, #246,
  #247), all **off by default** (no behavior change unless configured).
  `embeddings.provider: "model-tier"` serves dense retrieval from **Qwen3 via
  HuggingFace TEI** (`services/qwen-tei`) and **BGE-M3 multi-vector** (dense +
  learned-sparse + ColBERT, one `/v1/encode`) via the Python
  `services/bge-m3-service`, fused as SEPARATE RRF streams (never adding a Qwen
  cosine to a BGE score). Serve-path `retrieval.sparse`, `retrieval.colbert`,
  and a live `bge-reranker-v2-m3` cross-encoder are wired through the search
  Reranker seam — all gated off, pending a golden-set measure on your vault.
- **Native batched cosine** `cosineBatch` (#238, THE-420): one N-API crossing
  per query on the brute-force fallback path (~2.8x over the JS implementation),
  shipping with the repo's first benchmark harness.
- **Model-service and security CI, plus a Python test suite** (#248): a 16-test
  pytest suite for `services/bge-m3-service` (mock model layer, no torch/GPU); a
  path-filtered `ci-model-service` workflow (ruff + py_compile + pytest); and
  `ci-security` (a gitleaks gate over the working tree + cargo-audit + bun-audit,
  with a weekly cron).

### Fixed

- **v1.8.1 code audit — 13 fixes** across security, correctness, and robustness
  (#244): the bge-m3 bare-`catch` that disabled sparse/ColBERT on any transient
  error, the `/excalidraw/write` empty-scaffold overwrite data-loss, the
  gatedRerank absolute-cosine no-op, and the MMR-under-cluster-cap no-op; plus a
  reranker z-margin gate, atomic `forget`, vec dim-mismatch recording, and
  companion-plugin robustness.
- **Dispatch hardening** (#236): redact the HITL token from telemetry; warn on
  output-schema drift.

### Changed

- **Rust/Python/TS workload-partition ADR** and build order (#237): partition by
  compute profile — Rust for batched CPU kernels, Python for GPU/ML behind the
  service boundary, TypeScript for the control plane.
- Docs freshness pass and duplicate-stale-claim fixes (#234, #235).
- The model tier is **optional**: the server runs unchanged without the services
  (dense-only, existing providers). If you enable it, pin `BGE_MODEL_REVISION`
  and the TEI model image, and measure the new retrieval streams on your golden
  set before turning any of them on.

## [1.8.1] - 2026-07-12

### Fixed

- **bge-m3 sparse vectors are now reference-correct** (derived token/score
  alignment + special-token filtering). Two defects corrupted every stored sparse
  vector: vLLM's BgeM3 pooler strips BOS/EOS from `token_classify` scores while
  `/tokenize` returns the full id list, and the positional pairing silently
  truncated the mismatch — shifting **every weight one token left** — while
  cls/eos/pad/unk weights were never filtered per the FlagEmbedding
  `lexical_weights` contract. Alignment is now derived (equal lengths pair
  directly; a 2-short score list pairs against the inner ids; any other mismatch
  degrades the head to empty — never truncates), and XLM-R special ids are
  dropped. **If you built a bge-m3 sparse index with an earlier version, rebuild
  it** — the stored vectors are mis-keyed. Re-measured clean on the maintainer
  vault (n=136 paired): the sparse RRF stream is statistically zero on every
  metric vs the shipped BM25+dense+graph champion, so it remains off by default.

### Changed

- **The configuration reference is now complete** — every `ServerConfigSchema`
  field with its default (including previously undocumented `snapshots`,
  `bootstrap`, `writes.requireCas`, the embeddings batch/prefix knobs, HTTP
  DNS-rebinding options, the `bge-m3` provider, and `plur.command`), the full
  10-variable environment table, and a new **inference gateway** setup guide
  (self-hosted LiteLLM recipe, role→model policy, verification, degradation
  semantics) at `configuration/inference-gateway`.

## [1.8.0] - 2026-07-12

### Added

- **Obsidian Git + Remotely Save bridges (THE-378, THE-381).** Seven new M4
  companion-bridge tools (surface **141 across 31 domains**): `git_status`,
  `git_diff`, `git_log` (read; repo-wide surfaces fail closed under a read
  whitelist), `git_stage` (write, per-path ACL), and `git_commit`
  (`execute:git` — a hardcoded HITL floor, so commits always require human
  confirmation); plus `remotely_save_status` / `remotely_save_trigger`, an
  independent backup-verification signal. Agent git now flows through the
  ACL/HITL pipeline instead of shelling out; the plugin side duck-types
  obsidian-git's gitManager defensively (git failures degrade to `git_error`,
  never a 500) and `/probe` advertises both capabilities.
- **Dependency-aware deletion + hash-chained forget audit (THE-239).** New CLI
  `obsidian-tc forget [path] (--episode <id> | --note <rel-path>) [--erase]`,
  plus `--verify`. Episode forget tombstones always and scrubs content fields
  under `--erase` (the row skeleton keeps the attribution chain); note forget
  propagates an already-deleted note through the derived stores — retrieval
  history kept under the default tombstone/audit posture, deleted under
  `--erase`; derived activation cleared; a prewarm bundle mentioning the
  target invalidated; syntheses/contradictions/reflections reported, never
  rewritten. Every forget appends to `forget_log` (migration 20260712_003), a
  hash chain where editing, removing, or reordering any entry breaks
  verification.
- **Knowledge-gap detector (THE-48).** New CLI `obsidian-tc gaps [path]
  --queries <file> [--vault id] [--threshold T] [--min-results N] [--json
  file]` runs a batch of queries through the live engine and flags the ones
  with no real coverage — top-1 below the calibrated floor or too few results
  — with nearest-context paths for issue drafting. `--calibrate <golden.yaml>`
  replays the golden set and prints the top-1 score distribution; the shipped
  default threshold (0.138) is the measured p5 on the n=136 set against the
  live index (the original 0.75-cosine rule is meaningless on fused RRF
  scores). The cycle-close session files "Knowledge gap:" issues from the
  report; the server only detects.

- **Derive-don't-mutate access instrumentation + knowledge-health scorecard
  (THE-44, THE-46).** `chunk_access_stats` — a VIEW over `chunk_retrievals`
  (access count, last access, citations, outcome balance; migration
  20260712_002) — replaces the original mutate-the-chunk-store design, and the
  `linear:` frontmatter convention replaces a `linked_issue_id` column. New CLI
  `obsidian-tc metrics [path] [--vault id] [--since ms] [--until ms]
  [--stale-days N] [--json file]` emits the cycle scorecard (totals, windowed
  retrieval/citation counts, staleness cuts, linear-linked coverage,
  per-surface breakdown, top notes) for the cycle-close session to stamp into
  a vault metrics note.

### Changed

- **vec0 index: per-vault partition key + metadata aux columns (THE-277).**
  `vec_chunks` is now `vec0(chunk_id PK, vault_id partition key, +path, +model,
  embedding)`: KNN prunes to the query vault's shard (the cross-vault crowding
  class is structurally gone) and results carry their path without a join. A
  legacy-shaped table is detected at boot and rebuilt in place from stored
  `chunk_embeddings` — **no re-embed**.

### Fixed

- **`eval_dataview_field` no longer hangs to the bridge timeout.** The companion
  route passed the note *path* where Dataview's `evaluate()` expects a
  variable-context *object*; the rejected promise was uncaught, and LRA's express
  router leaves an unanswered request hanging. The route now builds its context
  from `dv.page(path)` (so `file.*` and frontmatter fields resolve inside the
  expression), maps a missing page to `note_not_found` and evaluation throws to
  `dql_error`. Systemically, **every companion route is now wrapped by a
  catch-all at the registration boundary** — a throwing/rejecting handler answers
  a typed `bridge_error` envelope instead of hanging its request until the
  client's timeout.

## [1.7.0] - 2026-07-12

### Added

- **`reflect` — the third verb, as one callable operation (THE-222).** New MCP
  tool (**134 total**): recall over the same measured front door, then a
  gateway synthesis pass — a grounded answer with source provenance in one
  query-scoped call. `mode: "challenge"` runs the adversarial red-team over the
  decision-bearing recall; `persist: true` writes the derived note under the
  memory folder's `reflections/` with `source_model` + exact chunk provenance
  (gated on `write:notes`). Degrades gracefully without the gateway. The
  sleep-time half runs via the new `obsidian-tc reflect` CLI command: the
  evaluator pass stamps pending work episodes (born-ineligible rows are never
  raised; unstable ok/error clusters are held; the optional judge can only
  lower, with a parse-failure kill switch), and gateway-gated preference
  extraction updates the new **versioned preference profile** — typed deltas
  only (add/strengthen/weaken/retract with weight counters), never monolithic
  regeneration.
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
- **Domain-verb facade mode (shipped under THE-275 — see correction).** _Correction, 2026-07-26: THE-275 was **cancelled**, and this entry credited it with shipping. The feature below is real and shipped in 1.3.0; the attribution was misleading. THE-275's actual proposal — per-tool visibility `tags` plus a hand-curated ~20-tool preset — was never built (only 15 of 150 definitions carry `tags`). The domain-verb mode below **superseded** that proposal rather than implementing it. Rationale and the current default's standing: `docs/adr/0006-the-default-surface-is-the-triad.md`._ `toolFacade.mode: "domain"` now advertises ~a dozen domain meta-tools (`notes`, `metadata`, `links`, `search`, `vault`, `attachments`, `structured`, `workspace`, `automation`, `knowledge`, `admin`) instead of the full ~100-tool surface or the triad. Each takes a shallow `{ action, args }` and routes the named action through the same `registry.dispatch` pipeline (every ACL / HITL / idempotency / throttle gate and the target's own schema validation fire unchanged). Boundary-only; every tool stays callable by name, and an unmapped tool still ships under an `other` domain rather than being hidden.
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
