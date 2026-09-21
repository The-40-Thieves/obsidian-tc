# Plan: GitHub issues batch three — THE-1037, THE-1038, THE-1039

Spec: the three Linear tickets (their descriptions are the spec) and the seven GitHub issues they
cite (#922, #925, #926, #927, #928, #929, #930, all by aunysillyme against 1.28.4). Read the
GitHub issue bodies with `gh issue view <n> -R The-40-Thieves/obsidian-tc` — they carry the
repros and the measured numbers; do not re-derive them.

Repo: `The-40-Thieves/obsidian-tc`, main `724bf3c7` (v1.28.4 + 2). Bun 1.4.0 monorepo; server
tests are vitest under Node in `packages/server/test/`; targeted tests run locally, the full
suite runs in CI.

## Global Constraints (apply to every task)

- **One worktree per task, one branch per task, one PR per task.** Branch names are the Linear
  `gitBranchName`s given in each task. Never edit `main`. Never `git add -A`; add named files.
- **Every commit signed off:** `git commit -s`. The PR title is Conventional Commits and cites
  the ticket, e.g. `fix(mcp): strip elicit_token inside call_capability (THE-1037)`. End commit
  messages with the attribution trailers from your dispatch. PR body: what changed, how it was
  verified (test names + counts), and `Closes #<gh-issue>` lines for each GitHub issue the PR
  closes, plus the ticket id in the body.
- **Test-first.** Write the failing test that reproduces the reported defect BEFORE the fix, run
  it, watch it fail for the reported reason, then fix. Quote the failing and passing output in the
  report. Tests go next to their neighbours in `packages/server/test/`; reuse
  `packages/server/test/m1-helpers.ts` for notes-tool fixtures.
- **Match the repo's style.** Read a neighbouring file first. Comments are invariant + pointer,
  not narrative; cite the ticket id (`THE-1037`) in a comment only where a future reader needs the
  why. No first-person, no dated prose in code comments (`check:comment-style` gate).
- **CHANGELOG:** add ONE bullet under `## [Unreleased]` in the existing register (bold lead
  sentence naming the ticket, then the mechanism), under `### Fixed` or `### Added` as fits.
  Cite the GitHub issue numbers in the bullet.
- **Gates to run locally before pushing** (each from repo root unless noted; quote exit codes in
  the report):
  ```
  bun run lint
  bun run typecheck
  for g in check:boundaries check:dev-dep-imports check:perf-timing-scope \
           check:ingest-telemetry-wiring check:config-paths check:duplicate-exports \
           check:duplication check:export-surface check:facade-parity check:comment-style; do
    bun run "$g" >/tmp/g.log 2>&1; echo "$g exit=$?"; done
  bun run test:scripts
  bun run docs:decisions-index && bun run map      # regenerate; commit the results
  cd packages/server && bun run docgen:render && bun run docgen:facts-check && cd ../..
  ```
  Any gate whose script name does not exist: say so in the report, do not invent a substitute.
  Then the targeted vitest files you touched: `cd packages/server && bunx vitest run test/<file>`.
  Do NOT run the whole server suite locally (4 shared cores); CI runs it. After pushing, run
  `gh pr checks <n> --watch` is NOT required of you — the controller watches CI.
- **A schema change to an M1 notes tool moves
  `packages/server/test/m1-notes-tool-metadata-parity.test.ts`** (ordered inline literal of
  name/description/scopes/input+output top-level keys). Regenerate the entry by deriving it from
  the tool (the test file's header says how) and paste it — never hand-type keys. Changing a tool
  description also changes docgen's generated marker regions (`docgen:render`), commit those.
- **Adding a CLI verb** (Task 3): the command's shape goes INLINE in the `CliCommand` union in
  `packages/server/src/cli/args.ts`; the command module uses `Cmd<"compact">` from
  `cli/shared.ts` and never imports from args.ts (that is a `no-circular` boundary violation).
  Add it to `cli/commands/help.ts`, and to the CLI docs wherever the other verbs are listed
  (grep for `rerun` across `README.md`, `packages/server/README.md`, `docs/`).
- **Report file:** write the full report to the path in your dispatch. Return only status,
  commits, a one-line test summary, and concerns.
- **No subagents.** You do not dispatch helpers or reviewers; review comes from the controller.
- **Do not merge.** Push the branch, open the PR, report. The controller merges once green.

## Task 1 — THE-1037: strip `elicit_token` inside `call_capability` (GH #925)

Branch: `mislam2/the-1037-call_capability-never-strips-elicit_token-so-every-hitl`

Defect (verified): `packages/server/src/mcp/server.ts:611-615` strips `elicit_token` from the
OUTER `tools/call` args into `ctx.elicitToken`. `callCapability` (`mcp/facade.ts:102-119`)
dispatches the inner `parsed.data.args` untouched via the `dispatchTarget` closure built at
`server.ts:702`, so a gated tool called through the facade receives `elicit_token` and its
`.strict()` schema rejects it: `validation_error: Unrecognized key "elicit_token"`. The token is
valid and undeliverable.

Required changes:

1. Hoist the strip into ONE helper (e.g. `splitElicitToken(args, ctx)` returning `{args, ctx}`),
   in `mcp/server.ts` or a small sibling module, and call it from BOTH entry points: the outer
   path at line 611 and inside the `dispatchTarget` closure passed to `callCapability` (so the
   inner args are stripped and `ctx.elicitToken` set before `dispatchToResult`). If the inner
   args carry a token AND the outer args carried one, the inner wins (it is the more specific
   binding); document that in the helper's comment.
2. `server.ts:645` says the domain-grouped facade tools route "identical to call_capability".
   Inspect that path; if it dispatches inner args the same way, it must call the same helper.
   Report which path(s) you found and what you did.
3. Tests, in `packages/server/test/tool-facade.test.ts` or a new
   `facade-elicit-token.test.ts` (follow `hitl-multi-round-trip.test.ts` /
   `conditional-hitl-advertisement.test.ts` for how a token is minted in tests —
   `issueElicitToken` in `src/elicit.ts`):
   - a gated call through `call_capability` WITHOUT a token → `elicit_required` (unchanged);
   - the same call WITH a minted token in the inner `args` → succeeds (this is the test that
     fails today with `validation_error`; watch it fail first);
   - a WRONG token through the facade → the HITL error (not `validation_error`);
   - the direct `tools/call` path still redeems a token (regression guard for the hoist);
   - the domain-grouped path from step 2, if it exists, redeems a token too.
4. CHANGELOG bullet under `### Fixed`. PR closes #925.

## Task 2 — THE-1038: `patch_note` anchor correctness, section read, exact-string replace (GH #922, #926, #927, #928)

Branch: `mislam2/the-1038-patch_note-heading-anchor-corrupts-notes-first-match-binding`

All defects live in `packages/server/src/tools/m1/notes/write.ts` (`patchByHeading`,
`patchByBlock`, `patchByPreamble`, lines 34-160), byte-identical since v1.26.0. Schemas in
`tools/m1/notes/schemas.ts` (`PatchAnchor`, `PatchInput`, `PatchNoteOutput`, `ReadNoteOutput`).
`read_note` in `tools/m1/notes/read.ts`. Existing tests: `notes-tools.test.ts`,
`write-quality-warning.test.ts`, `m1-helpers.ts`.

Required changes, in this order (each is its own commit with its own tests):

1. **Lift the anchor helpers into a shared module** `packages/server/src/tools/m1/notes/anchors.ts`
   (HEADING, PatchResult, removedSpan, escapeRegExp, patchByHeading, patchByBlock,
   patchByPreamble, plus a new pure `resolveSection(body, anchor)` that returns the span the
   patch helpers use). Pure functions over strings, no I/O. Update write.ts's header comment
   (lines 9-11 currently claim they are private because nothing else needs them — that is no
   longer true; say why they moved). Behaviour-preserving; existing tests stay green.
2. **Fence-aware scanning (GH #926).** Track fence state in every scan: a line whose trimmed
   form starts with ``` or ~~~ opens a fence; it closes only on a line starting with the SAME
   fence character (a ``` inside a ~~~ block is content). Heading matching is skipped while
   fenced, in the anchor scan, the section-end scan, and `patchByBlock`'s paragraph-start walk.
   Repro from #926 must produce the section ending at the real `## Next section`. Post-write
   guard: if the operation flips the body's fence-open count from even to odd, throw
   `err.invalidInput("patch would leave an unterminated code fence", {...})` — compare
   before/after, so a note that ALREADY has an unclosed fence is not refused for every patch.
3. **Refuse an ambiguous anchor (GH #922 shape 3).** Collect ALL matching headings (case-insensitive
   trimmed text, as today); more than one → `err.invalidInput` with the count and the 1-based
   line numbers in `details`. Same for a block id that occurs on more than one line.
4. **`replace` idempotent on the anchor heading (GH #922 shape 2).** If `content`'s first
   non-blank line is an ATX heading whose level AND trimmed text (case-insensitive) equal the
   anchor's, drop that line from the inserted content. Update the tool description to state
   that the anchor heading is preserved and a leading duplicate is dropped.
5. **`read_note` section read (GH #927).** Add optional `anchor: PatchAnchor` to `read_note`'s
   input (keep `.strict()`). When present, resolve with `resolveSection` and add
   `section: { text, start_line, end_line, heading_level? }` to the output: `text` is the
   section INCLUDING its heading line (or the block paragraph / the preamble); `start_line` and
   `end_line` are 1-based, inclusive, relative to the raw file `content` (account for the
   frontmatter lines `parseNote` strips — compute the offset from `parsed.rawFrontmatter`);
   `heading_level` present only for heading anchors. `content_hash` stays the WHOLE-note hash so
   it round-trips into `patch_note.prev_hash`. Anchor not found → `err.invalidInput("target
   heading not found" / "block reference not found")`, matching patch_note. `section` is
   omitted (not null) when no anchor is given. Description updated. Parity test regenerated.
6. **`patch_note operation: "replace_text"` (GH #928).** New enum member with `old_string`
   (min 1) and `new_string` (may be empty). Schema refines: `old_string`/`new_string` required
   iff `replace_text`; `content` required iff NOT `replace_text`. The match is scoped to the
   resolved anchor's section text; 0 matches → `err.invalidInput` "old_string not found in
   section"; 2+ → `err.invalidInput` with the count. `prev_hash` still enforced.
   `confirm_replace` ignored. `lines_removed` = line count of `old_string`, `bytes_removed` =
   `Buffer.byteLength(old_string)`. `PatchNoteOutput.operation` enum extended. Snapshot capture
   and reindex exactly as `replace`. Description updated.
7. **Tests** (in `notes-tools.test.ts` or a new `patch-note-anchors.test.ts` for the pure
   helpers): every repro string quoted in #922 and #926 becomes a test case; plus the ambiguous
   anchor refusal, the heading-drop, the odd-fence refusal, read_note section for each anchor
   type with exact line numbers on a note WITH frontmatter, replace_text 0/1/2-match cases, and
   the CRLF note keeps its EOL.
8. CHANGELOG bullet under `### Fixed` (one bullet covering the four issues is fine). PR closes
   #922, #926, #927, #928.

Out of scope (rulings, see ledger): Setext headings; `stop_before` / trailing-footer bounding
(#922 shape 1, item 4 of the ticket) — leave it open on THE-1038 with a note; mixed-EOL
preservation.

## Task 3 — THE-1039: FTS5 merge in the sweep, `compact` verb, doctor delta (GH #929, #930)

Branch: `mislam2/the-1039-nothing-ever-merges-the-fts5-indexes-notes_fts-settles-at-3x`

Verified: `packages/server/src/db/maintenance.ts:283` runs only `PRAGMA optimize` (skips virtual
tables). `rg "'optimize'|'merge'|automerge" packages/server/src` → zero. `fts.ts:142/162` already
use the special-INSERT idiom for `integrity-check` and `rebuild`. `workspace/rerun.ts:302` has
`VACUUM INTO` with the WAL rationale. CLI verbs in `cli/args.ts`; no compact.

Before writing SQLite code, fetch current docs: `npx ctx7@latest library SQLite "FTS5 merge
optimize automerge commands"` then `docs` — confirm the exact semantics of `'merge', N` (sign of N,
what N bounds) and quote them in a code comment.

Required changes:

1. **Sweep merge (GH #929).** In `runMaintenanceSweep`, after `PRAGMA optimize` and inside the
   same advisory try/catch, for each of `notes_fts` and `chunk_fts` that EXISTS in
   `sqlite_master` (existence check, not the per-connection `hasFts` flag), run
   `INSERT INTO <t>(<t>) VALUES('merge', N)` with a bounded N chosen from the docs (the ticket
   suggests 16). Under `OBSIDIAN_TC_DISABLE_FTS=1` or a store without the tables this must not
   throw. Add `fts_merged: string[]` (tables merged) to the sweep result so the behaviour is
   observable; extend the existing result assertions in `maintenance.test.ts`.
   Test: build a cache.db with `notes_fts`, insert rows across many separate transactions so
   several segments exist, record `SELECT count(*) FROM notes_fts_data`, run the sweep, assert
   the count strictly decreased and `fts_merged` lists the table. Second test: the sweep on a
   store with no FTS tables returns `fts_merged: []` and no error.
2. **`obsidian-tc compact` (GH #930).** New CLI verb, `cli/commands/compact.ts`. Flags:
   `--config <path>` (like the others), `--dry-run`, `--json <path>`, `--into <path>`.
   Default behaviour, in order, on `cache.db` and then `experiential.db`:
   a. FTS5 `'optimize'` on every `*_fts` table present (full merge; this is the operator path,
      the sweep does the bounded one);
   b. in-place `VACUUM` (NOT a file swap — see ruling), opened with the configured
      `db.busyTimeoutMs`; on `SQLITE_BUSY` print that another writer holds the database and exit
      non-zero;
   c. `PRAGMA integrity_check` and the FTS `integrity-check` insert on each `*_fts` table after;
   d. print before/after file sizes and bytes reclaimed per database; `--json` writes the same.
   `--into <path>`: instead of (b), `VACUUM INTO <path>` after (a), verify the copy with (c) and
   a per-table row-count comparison against the live db, and print the exact `mv` the operator
   would run; never move files yourself. `--dry-run`: print sizes, `freelist_count * page_size`,
   and the `*_fts_data` row counts; change nothing. Document the ~2x free-space need in the help
   text.
   Tests: `cli/args.ts` parse cases for the new verb (follow `metrics`'s test), and a command
   test on a temp cache.db that asserts the file shrank after `compact` and that
   `--into` produced a verified copy with the live file untouched (hash before == after).
3. **doctor delta (GH #930).** Add a default (non-`--probe`) doctor row for `cache.db`: file
   size, `freelist_count * page_size` (reclaimable by VACUUM), and per-`*_fts` table the
   `<t>_data` row count. Status `warn` with the remedy `obsidian-tc compact` when freelist bytes
   exceed 10% of the file; otherwise `ok`. Follow the shape of the existing rows in
   `cli/commands/doctor.ts` / `doctor-probes.ts` and the design note `docs/design/cli-doctor.md`;
   respect biome's 700-line ceiling on doctor.ts (put the probe in doctor-probes.ts). Test it
   with a temp db in the doctor tests.
4. **Pre-upgrade snapshots.** `rg -n "pre-v" --glob '!node_modules'` across the whole repo
   (scripts/, packages/plugin, docs). If nothing in this repo creates them, add one sentence to
   the `compact` docs recommending it before any manual copy of `~/.obsidian-tc`, and say in the
   report that the snapshots are operator-side. If something here does create them, run the FTS
   optimize before the copy and report where.
5. CHANGELOG: one `### Fixed` bullet (sweep merge) and one `### Added` bullet (`compact` +
   doctor row). PR closes #929, #930.
