// THE-466 slice 1 grew args.ts past biome's noExcessiveLinesPerFile floor (packages/*/src/**/*.ts,
// 700 lines). USAGE is pure help text with no coupling to parseCliArgs' logic — split out so a
// future flag addition's help text doesn't compete with the parser's own line budget.

export const USAGE = `obsidian-tc — MCP server for Obsidian

Usage:
  obsidian-tc <vault-dir | config.json>   Start the server (zero-config from a vault folder, or a config file)
  obsidian-tc serve [path]                Same as above; path may be a vault folder or a config file
  obsidian-tc config show [path]          Print the effective config with secrets redacted
  obsidian-tc config validate [path]      Validate the config (exit non-zero on error)
  obsidian-tc doctor [path] [--json] [--token <jwt>] [--probe]
                                          Probe runtime health: runtime, native module, auth policy,
                                          token max-age vs expiry, detected Obsidian vaults/plugins.
                                          --json emits the versioned report; --token checks a deployed
                                          credential's age. Exits non-zero when a check fails.
                                          --probe additionally EMBEDS a short string against the
                                          configured embeddings provider, so the dense head is
                                          reported as observed rather than as configured. Off by
                                          default: every other check is offline, and a "module"
                                          provider is never probed at all.
  obsidian-tc plugin install --vault <p>  Copy the companion plugin into <p>/.obsidian/plugins/
  obsidian-tc index [path] [--vault id] [--folder rel/path]
                                          Chunk and embed the vault into the search index (THE-697).
                                          Incremental: unchanged content hashes are skipped, removed
                                          chunks pruned. The operator path for a reindex — the
                                          index_vault tool cannot hold an HTTP request open long
                                          enough for a large vault. --folder requires --vault.
                                          Exits non-zero if any note failed to embed, since those
                                          notes are indexed but NOT retrievable.
  obsidian-tc cluster [path] [--k N]      Recompute chunk clusters for diversified retrieval (THE-73)
  obsidian-tc activation-recompute [path] Recompute ACT-R activation from retrieval history (THE-227)
  obsidian-tc prefetch [path] [--vault id] [--ttl-hours N]
                                          Prewarm the session-bootstrap context cache (THE-136)
  obsidian-tc densify-llm [path] [--vault id]
                                          LLM Pass-3 semantic-edge densification via the local gateway (graph densification)
  obsidian-tc reflect [path]
                                          Sleep-time reflect: stamp episode eligibility + update the preference profile (THE-222)
  obsidian-tc rerun <session-id> [path] [--vault <id>] [--sandbox] [--json]
                                        Re-issue a recorded session's captured tool arguments
                                        against current vault state and report which calls
                                        diverged (THE-645 item 3). RE-EXECUTION, not stubbed
                                        replay: results were never captured, so there is nothing
                                        to substitute. Requires \`sessions.traceContent\` to have
                                        been ON when the session was recorded; otherwise every
                                        record is refused and the command exits 2.
                                        Both modes are pinned to the session's OWN vault: a record
                                        whose captured args name a different vault is refused.
                                        Neither mode grants admin: scopes, so a recorded admin
                                        call (e.g. add_vault) is always refused.
                                        Default mode refuses every mutating call via a read-only
                                        ACL. --sandbox copies THAT vault and the databases to a
                                        temp dir and runs vault-filesystem calls for real against
                                        the copy; ALL plugin-bridge tools are disabled under
                                        --sandbox rather than run — the write ones (git, tasks,
                                        excalidraw, remotely-save) because they act through the
                                        live Obsidian app on the REAL vault and a copy cannot
                                        contain that, and the read ones with them, because the
                                        bridge transport is stripped wholesale rather than per
                                        tool. So a sandboxed re-run reports bridge-backed reads
                                        (list_tasks, git_status, eval_dataview_field, ...) as
                                        diverged; that is rerun's own policy refusing them, not
                                        vault state having moved.
                                        Exit: 0 nothing moved, 1 divergence found, 2 nothing
                                        was runnable.
  obsidian-tc citation-infer [path] (--transcript <file> (--session <id> | --since <ms> [--until <ms>])
                                             | --transcript-index <file.jsonl>)
                            [--max-judged N] [--judge-concurrency N] [--min-judged-for-kill N] [--allow-uncertain]
                                          Infer which retrieved chunks were actually USED in a response
                                          and stamp cited_in_response / citation_score / citation_state
                                          over the retrievals in scope (THE-170). Two stages: a cheap
                                          ROUGE-L/cosine filter, then a gateway judge over the
                                          survivors. The transcript is assistant-side text no MCP
                                          surface supplies, so it is fed in rather than observed.
                                          --transcript-index takes JSONL, one object per retrieval
                                          ({vault, surface_type, query, retrieved_at, transcript}),
                                          and runs ONE PASS PER ENTRY — a window spanning several
                                          queries has several answers, and scoring chunks against
                                          their concatenation attributes citations across queries
                                          that never saw each other (THE-717). Ambiguous and empty
                                          entries are SKIPPED and reported, never guessed at. The
                                          transcript must already be filtered to text produced AFTER
                                          retrieved_at.
                                          --judge-concurrency bounds the judge fan-out (default 3);
                                          --min-judged-for-kill floors the parse-failure kill switch
                                          (default 10) so one bad reply cannot abort a small pass
                                          (THE-621). --allow-uncertain lets the judge abstain — dark by
                                          default, since it moves rows out of the citation count.
  obsidian-tc metrics [path] [--vault id] [--since ms] [--until ms] [--stale-days N] [--json file]
                                          Knowledge-health scorecard from the derive layer (THE-44/46)
  obsidian-tc config explain [path] [--source env|file|profile|default|derived] [--json]
                                          Trace every resolved config value to WHERE it came from.
                                          Secrets report their SOURCE, never their value (THE-518)
  obsidian-tc note-quality [path] [--vault id] [--flags a,b] [--limit N] [--suggest]
                                          Recompute the note_quality rollup and list flagged notes:
                                          duplicate | orphan | stale_edit | stale_access | contradicted | tombstoned (THE-537)
                                          --suggest additionally prints one remediation line per
                                          flag (never writes to the vault) (THE-643)
  obsidian-tc gaps [path] --queries <file> [--vault id] [--threshold T] [--min-results N] [--json file]
  obsidian-tc gaps [path] --calibrate <golden.yaml> [--vault id]
                                          Knowledge-gap detector / threshold calibration (THE-48)
  obsidian-tc forget [path] (--episode <id> | --note <rel-path>) [--erase] [--vault id]
  obsidian-tc forget [path] --verify      Dependency-aware deletion + hash-chained audit (THE-239)
  obsidian-tc context-export [path] --out <file> [--vault id]
                                          Export the derived plane (preferences, episodes,
                                          note_quality, retrieval feedback, forget_log — the 9
                                          experiential.db tables) as a versioned, vendor-neutral
                                          JSON bundle (THE-636). --out is REQUIRED and refused
                                          if it resolves inside any configured vault's root —
                                          the bundle is derived personal data and must never be
                                          indexed/synced like vault content. --vault narrows the
                                          vault-scoped tables; chunk_retrievals, vault_object_state
                                          and forget_log have no vault axis and always export in
                                          full. A tombstoned/blocked episode is never included.
  obsidian-tc context-import <bundle> [path] [--vault id] [--dry-run]
                                          Import a context-export bundle (THE-636). Every row is
                                          schema-validated before any write; a format_version
                                          mismatch or one malformed row aborts the whole import
                                          with nothing written. Idempotent (re-importing the same
                                          bundle writes nothing new). Forget wins over import: a
                                          row this install has since forgotten is skipped and
                                          reported, never resurrected, and an imported forget_log
                                          entry retroactively forgets any matching content already
                                          here. --dry-run reports counts and writes nothing.
  obsidian-tc import-highlights [path] --vault <id> [--since <iso-date>] [--dry-run]
                                          Pull highlights from a configured read-later source
                                          (Readwise's v2 export API, the only adapter so far) and
                                          stage them in capture_queue as source: "import" for
                                          commit_capture review (THE-650) — the same staged,
                                          human-gated path every capture producer uses; nothing
                                          here writes to the vault directly. INERT with no
                                          readwise.token configured: exits 0 with NO network call.
                                          --vault is required (highlights from one account have no
                                          source-side vault to infer). --since scopes to highlights
                                          Readwise has updated after that ISO 8601 instant.
                                          Deduplicates on a per-highlight hash of (source,
                                          source_id, text, location, highlighted_at), so re-running
                                          a sync never re-enqueues an already-staged highlight.
                                          --dry-run reports counts and enqueues nothing.
  obsidian-tc token mint [path] --sub <id> [--aud <uri>] [--vault <id>] [--scopes a,b] [--ttl <sec>] [--json]
                                          Mint an HS256 bearer token from the config's auth block.
                                          Refuses to mint without an aud when the config binds one,
                                          or a --ttl above auth.tokenTtlSeconds (THE-658)
  obsidian-tc elicit [path] --hash <args_hash> --tool <name> [--vault <id>] [--caller <id>] [--json]
                                          Mint a single-use HITL confirmation token bound to the
                                          args_hash an elicit_required error returned (THE-826) —
                                          the route to a token for a client that does not implement
                                          MCP elicitation (e.g. Claude Code). Authorization is
                                          filesystem access to the SAME cache.db the live server
                                          reads elicit_tokens from — the same trust boundary
                                          'token mint' rests on for auth.jwtSecret. Bound to
                                          exactly the vault, args_hash and --caller given: a token
                                          minted for one call is refused for a different one.
                                          Single-use (consumed atomically on redemption) and always
                                          expires after the configured elicitTtlSeconds — there is
                                          no --ttl flag, so this can never outlive what the live
                                          server itself would issue. --caller defaults to "stdio",
                                          the identity every locally-spawned MCP client presents
                                          over the trusted stdio transport; pass --caller explicitly
                                          to match a JWT 'sub' (the value given to
                                          'token mint --sub') on an HTTP/jwt deployment. --vault is
                                          required when the config lists more than one vault.
  obsidian-tc version                     Print the version
  obsidian-tc help                        Show this help

If no path is given, OBSIDIAN_TC_CONFIG is used. A vault folder boots a single
vault with id "main" and all defaults; pass a config file for multi-vault, auth,
ACLs, transports, and embeddings.
`;
