# Plan: follow-up track — THE-1041, THE-1042, THE-1040

Spec: the three Linear tickets (descriptions are the spec) and GH #934 / #935 for the first two.
Repo: The-40-Thieves/obsidian-tc, main 4fc91a0d (v1.29.0). Server tests: vitest under Node in
`packages/server/test/`. Premises verified against main by a scout before dispatch (file:line below).

## Global Constraints (apply to every task)

- **One worktree per task, one branch, one PR.** Branch names are the Linear `gitBranchName`s given
  per task. Never edit `main`. Never `git add -A`; add named files. Never bare `git stash`.
- **Every commit signed off:** `git commit -s`. Conventional Commits title with the ticket id. End
  commit messages with the two trailer lines from your dispatch. PR body: what changed, how verified
  (test names + counts), `Closes #<gh-issue>` where one exists, the ticket id.
- **Test-first.** Write the failing test that reproduces the defect BEFORE the fix; quote RED and
  GREEN output in the report. Tests live in `packages/server/test/` next to their neighbours.
- **Match the repo's style.** Comments are invariant + pointer, cite the ticket id only where a
  future reader needs the why; no first person or dates in code comments (`check:comment-style`
  gate, 120-line ceiling per file, baseline 33 files).
- **CHANGELOG:** ONE bullet under `## [Unreleased]` (`### Fixed` or `### Added`) in the existing
  register: bold lead sentence citing the ticket AND the GitHub issue; the PR number is added by the
  release gate later, but if you know your PR number when you write the bullet, cite it too.
- **Gates before pushing** (from repo root; quote exit codes):
  ```
  bun run lint && bun run typecheck
  for g in check:boundaries check:dev-dep-imports check:perf-timing-scope \
           check:ingest-telemetry-wiring check:config-paths check:duplicate-exports \
           check:duplication check:export-surface check:facade-parity check:comment-style; do
    bun run "$g" >/tmp/g.log 2>&1; echo "$g exit=$?"; done
  bun run test:scripts
  bun run docs:decisions-index && bun run map        # commit the regenerated files
  cd packages/server && bun run docgen:render && bun run docgen:facts-check && cd ../..
  ```
  Then the targeted vitest files you touched (`cd packages/server && bunx vitest run test/<file>`).
  Never run the whole server suite locally; CI runs it. Do not wait on CI — the controller does.
- **Schema/description changes to M1 notes tools or M7 tools move the metadata-parity tests**
  (`m1-notes-tool-metadata-parity.test.ts`, `m7-tool-metadata-parity.test.ts`): regenerate the
  literal by derivation, never by hand.
- **Report file:** write the full report to the path in your dispatch; reply with status, commits,
  PR URL, one-line test summary, concerns. **No subagents. Do not merge.**

## Task 1 — THE-1041: input schemas in input mode (GH #934)

Branch: `mislam2/the-1041-describe_capability-and-the-facade-tools-emit-input-schemas`

Verified: `packages/server/src/mcp/facade.ts:25-29` `JSON_SCHEMA_OPTS` has no `io`; `toJson()`
(`:33-40`, memoized per schema) converts everything in zod's default `io: "output"` mode. Call
sites: `facade.ts:147, 155, 163` (facade meta-tools' own `inputSchema`), `facade.ts:250-251`
(`describe_capability` input_schema AND output_schema), `server.ts:300, 302` (`tools/list`
inputSchema AND outputSchema). Zod is `^4.4.3`; `z.toJSONSchema(schema, { io: "input" })` is
already used in `packages/shared/src/config/server.schema.ts:251`.

Required changes:
1. Add `toInputJson(schema)` beside `toJson` with its OWN memo (the memo is keyed by schema; input
   and output conversions of the same schema must not collide), converting with
   `{ ...JSON_SCHEMA_OPTS, io: "input" }`. Use it at every INPUT site: facade.ts:147/155/163 and
   :250, server.ts:300, and any other input-schema site you find (`rg -n "toJson(" packages/server
   scripts` — also check the Smithery server-card generator and docgen: if they render INPUT
   schemas through `toJson`, switch them; output schemas stay on `toJson`).
2. Tests (new `test/input-schema-io-mode.test.ts`): (a) iterate the full registry
   (`scripts/docgen/build-registry` `buildFullRegistry`, as the reporter did) and assert
   `describe_capability`'s `input_schema` deep-equals `z.toJSONSchema(def.inputSchema, {...,
   io: "input"})` for every tool, and `output_schema` equals the output-mode conversion; (b)
   `write_note`: `options` is NOT in `required`, and a call omitting it validates; (c) a plain
   (non-strict) object inside a tool input is emitted WITHOUT `additionalProperties: false`, and
   the `.strict()` ones keep it; (d) `tools/list` over a real in-memory MCP session (see
   `tool-facade.test.ts` for the harness) returns input-mode `inputSchema`. RED first: (a) must
   report the reporter's ~98-of-163 divergence before the fix; quote the number.
3. Regenerate whatever moves: docgen rendered schemas, the Smithery card test fixture, parity
   literals (top-level keys should not change — verify, do not assume).
4. CHANGELOG `### Fixed` bullet. PR closes #934.

## Task 2 — THE-1042: validation errors that say the fix (GH #935)

Branch: `mislam2/the-1042-validation-errors-name-the-field-but-not-the-fix-list`

Verified: `packages/server/src/mcp/server.ts:232` `MAX_RENDERED_ISSUES = 5`; `renderIssues`
`:237-242` uses `z.prettifyError`; `formatErrorDetail` `:246-251` reads `error.details.issues`.
`parseInput` in `packages/server/src/mcp/registry/input-binding.ts:22-29` throws the
`validation_error` and has `def.inputSchema`. `VaultId` is `packages/shared/src/schemas/
primitives.ts:8-12` (regex message "vault id must be a lowercase slug"). `list_vaults`'s visibility
gate is `ctx.vaultBound === true ? [resolve(ctx.vaultId)] : list()` at
`tools/m1/registry-tools.ts:183-186`. `search_text` scopes with top-level `root`
(`tools/m2/search-tools.ts:320-330`), not `path`.

Rulings (controller): hints are STRUCTURED in `details` first and rendered second, so programmatic
callers get them too; a `vaultBound` caller is never shown any id but its own; `vault` is never
resolved case-insensitively.

Required changes:
1. `unrecognized_keys`: at the throw site in `parseInput`, for each `unrecognized_keys` issue
   compute the accepted keys of the object schema at that issue's `path` (walk `def.inputSchema`'s
   shape; handle nested objects, `.optional()`/`.default()` wrappers, discriminated unions by
   listing the union of member keys) and add `details.accepted_keys: { [pathString]: string[] }`;
   `renderIssues` appends `accepted: a, b, c` after the issue line. Add a nearest-name suggestion
   (`did you mean "root"?`) when a rejected key is within edit distance 2 of an accepted key, and a
   small static alias table for cross-tool spellings that edit distance cannot catch — at minimum
   `search_text: { path: "root" }`; grep the tools for other folder/path spellings (`folder`,
   `root`, `path`, `dir`) and add the obvious pairs. The table lives beside `parseInput`, keyed by
   tool name.
2. `vault` failures: (a) the VaultId regex/min/max issue at path `["vault"]` in `parseInput`; (b)
   `vault_not_found` thrown by `VaultRegistry.resolve` during dispatch. At the dispatch layer, where
   `ctx` is known, add `details.visible_vaults` = the same gate as `list_vaults` (only
   `ctx.vaultId` when `vaultBound`, else all ids), and `details.did_you_mean` when a case-folded or
   slugified form of the submitted value equals a visible id. Render: `vault: did you mean "auny"?`
   or `visible vaults: a, b`. Find the ONE cleanest site (dispatch.ts around parseInput /
   enforceVaultBinding) rather than patching each tool.
3. Keep everything inside `MAX_RENDERED_ISSUES` and the THE-823 text channel; the rendered text
   must not exceed one extra line per issue.
4. Tests (`test/validation-error-hints.test.ts`): the two calls from the issue verbatim through
   `call_capability` on a real in-memory session (harness as in `facade-elicit-token.test.ts`):
   `read_note {vault:"Auny"}` → text contains `did you mean "auny"` and details.did_you_mean;
   `search_text {vault, query, path}` → `accepted:` list contains `root` and the alias hint names
   `root`; a `vaultBound` caller with a wrong vault sees ONLY its own id (assert the other vault's
   id is absent from text AND details); an unknown-but-well-formed vault id → visible vaults list;
   `unrecognized_keys` on a nested object path; the 5-issue cap still holds with hints.
5. CHANGELOG `### Added` bullet. PR closes #935.

## Task 3 — THE-1040: comment-only frontmatter survives writes

Branch: `mislam2/the-1040-serializenote-drops-a-comment-only-frontmatter-block-any`

Verified: `packages/server/src/vault/frontmatter.ts:17` regex captures the raw block (LF or
CRLF); `serializeNote` (`:117-124`) returns the bare body when the parsed mapping has no keys
(`:122`), so a comment-only block (parsed as `{}`) is dropped; `emitFrontmatter` preserves
`originalFrontmatter` only for the non-empty case. Callers: patch_note/write_note/append_note and
others pass `parsed.rawFrontmatter`; `tools/m6/bulk-tools.ts:274` and `memory/materialize.ts:92`
construct NEW notes without raw (unchanged by this task). Tests:
`test/frontmatter-fidelity.test.ts`.

Rulings (controller): (a) when the parsed mapping is empty AND `originalFrontmatter` is a non-blank
string, `serializeNote` emits the original block verbatim between delimiters; (b) the delimiter line
ending follows the original block (CRLF when the raw block contains `\r\n`), for the non-empty
case too — this closes the LF-delimiter-on-CRLF-notes residue noted on THE-1038; (c) a genuinely
empty block (`---\n\n---` with only whitespace) is still dropped, as today.

Required changes:
1. Implement (a)-(c) in `serializeNote` / `emitFrontmatter`; keep the existing key-preservation
   behaviour for non-empty mappings.
2. Tests: unit (frontmatter-fidelity.test.ts): comment-only block round-trips byte-identical for
   LF and CRLF; whitespace-only block still dropped; CRLF note with real keys keeps CRLF delimiters;
   a non-empty mapping still preserves formatting as before. Tool-level (new
   `test/frontmatter-comment-only.test.ts`, harness `m1-helpers.ts`): the note from the ticket
   (`---\n# preserve me\n---\n## A\nold\n`) survives `patch_note` append, prepend, replace,
   replace_text, `append_note`, and `write_note mode:"update"` (whichever update modes exist —
   read `WriteInput`), asserting the file starts with the exact original block.
3. Audit the two raw-less callers and state in the report why they are unaffected (they build new
   notes); do not change them unless a test shows loss.
4. CHANGELOG `### Fixed` bullet. No GH issue; cite THE-1040 and GH #932's review origin.

## Task 4 — THE-1043: frontmatter line-based rewrite follow-ups (post-merge Codex findings)

Branch: `mislam2/the-1043-frontmatter-line-based-rewrite-the-1040-mis-handles-root`

Source: the post-merge Codex pass on 26966d00..3e55e254 (73 real-handler probes). Three
REGRESSIONS of THE-1040's line-based rewrite and two pre-existing gaps of the same class, all in
`packages/server/src/vault/frontmatter.ts` on main 3e55e254. The ticket description carries the
exact inputs and outputs; every one becomes a test.

Rulings (controller):
- The emitter works on the ORIGINAL BLOCK AS A LINE LIST. A key "owns" the lines its node covers
  only when the node starts at a line start and ends at a line end (block style). A key that shares
  a line with siblings (a root flow mapping `{a: 1, b: 2}`) is handled by re-emitting that whole
  line from the changed mapping (the pre-THE-1040 node-range behaviour for that line), never by
  line splicing.
- On a CHANGE: every line owned by no changed/removed key is emitted verbatim (comments, blank
  lines, unchanged keys with their inline comments); a changed key is re-emitted in place of its
  own lines; a removed key's lines are spliced out with exactly one line break, the block's EOL,
  between the neighbours (so `# lead` and `# tail` stay on separate lines and CRLF stays intact).
- A missing trailing newline after the closing delimiter is preserved (`---` at EOF stays at EOF).
- The keep-chomp `it.todo` stays unless the line-list model makes it pass, in which case promote it.

Required:
1. Fix regressions 1-3 and gaps 4-5 from the ticket, test-first (RED on 3e55e254 for each of the
   five inputs, quoted), plus CRLF variants of 2 and 4, `bulk_set_property` on a note with comments,
   and `add_tag` on a comment-only block (comments kept).
2. Keep all existing THE-1040 tests green (frontmatter-fidelity, frontmatter-comment-only,
   frontmatter-tools-branch-coverage) — 77 pass + 1 todo today.
3. Coherence: after the rewrite, remove any helper the line-list model makes dead; the file's
   comments describe the current model; stay under the comment-style ceiling.
4. CHANGELOG `### Fixed` bullet citing THE-1043 (and THE-1040 as the origin).

## Task 5 — THE-1044: anchors/aliases and keep-chomp assignment (pre-existing, found by the THE-1043 Codex pass)

Branch: `mislam2/the-1044-frontmatter-edits-break-yaml-anchorsaliases-and-trim-newly`

Both defects are in how a CHANGED key's value is re-emitted by `emitGroup` / the value serializer in
`packages/server/src/vault/frontmatter.ts` (main 320decc0). Named `it.todo` tests for both inputs
already exist in `test/frontmatter-fidelity.test.ts`; promote them.

Defects:
1. Anchors/aliases: `---\na: &x [1, 2]\nb: *x\n---` — `update_frontmatter set a: 9` writes
   `a: 9\nb: *x` (dangling alias, unreadable); `remove a` leaves only `b: *x`. Both report success.
2. Keep-chomp assignment: on `---\na: 1\nb: 2\n---`, `set a: "hello\n\n\n"` writes
   `a: |+\n  hello\nb: 2`; reading back gives `"hello\n"` — the emitter trims the scalar's trailing
   newlines (content), not just the entry separator.

Rulings (controller):
- Correctness beats byte fidelity when they conflict. A block that contains any alias (`*name`) is
  edited in DOCUMENT mode: parse with `YAML.parseDocument`, apply the set/remove on the Document
  (`doc.set` / `doc.delete` / `doc.setIn` as the tools need), and emit `doc.toString()` for the
  WHOLE block; the yaml library keeps anchors, aliases and node comments in that path. When the
  anchored node itself is removed or replaced, the library's own handling decides (the document
  must re-parse; any alias to a removed anchor is materialized as a copy of the old value before
  removal so nothing dangles). Blocks without aliases keep the line-list model unchanged.
- A newly assigned scalar keeps its exact string: the entry emitted for a changed key must not trim
  trailing newlines that are part of the value; only the separator between entries is the block EOL.
  Use the yaml library's scalar styling (`blockQuote: "literal"` with keep chomping when the string
  ends in newlines) and assert the re-parsed value byte-for-byte.
- No tool-level behaviour changes beyond these; the seven round-trip callers keep their signatures.

Required:
1. Test-first: promote the two `it.todo`s (RED on 320decc0 with the exact symptoms, quoted), add:
   alias to a removed anchor is materialized; alias to a CHANGED anchor follows the new value; a
   block with an alias AND comments keeps the comments through document mode; keep-chomp strings
   with 1, 2 and 3 trailing newlines and CRLF; a strip-chomp (`|-`) and clip (`|`) assignment round-trip.
2. Keep every existing frontmatter test green (frontmatter-fidelity, frontmatter-comment-only,
   frontmatter-tools-branch-coverage: 123 pass + 2 todo → 125 pass + 0 todo).
3. Verify the yaml package version and API against current docs first (`npx ctx7@latest library
   "yaml" "parseDocument set delete toString anchors aliases"` then `docs`); quote what you rely on.
4. CHANGELOG `### Fixed` bullet citing THE-1044 (origin: THE-1043 review).

## Task 6 — THE-1045: document-mode anchor collection by pair identity; log the plain-stringify fallback (residual from THE-1044)

Branch: `mislam2/the-1045-frontmatter-anchor-collection-by-pair-identity`

Parked at the THE-1044 review breaker (PR #941, round-5 re-review). In
`packages/server/src/vault/frontmatter.ts` document mode, `materializeAliases` collects the anchors
under a doomed key with `doc.get(key, true)`. The `yaml` library's `YAMLMap.findPair` falls back to
key-VALUE equality and returns the FIRST matching pair, so across a collision group it can miss an
anchor on the value of a pair the collapse drops.

Repro (main 67dde185): `---\n1: &key 1\n*key : &v third\n'1': second\nb: *key\nc: *v\n---`,
`set b: 2` → `&v` is not collected, its pair is dropped, `doc.toString()` throws
`Unresolved alias: v`, the blanket `catch {}` in `emitFrontmatter` swallows it, and the block is
re-emitted by plain `YAML.stringify`: values correct (`{"1":"second", b:2, c:"third"}`), all
anchors/comments/formatting lost, nothing logged.

Rulings (controller):
- Anchor collection walks `map.items` and matches pairs by NODE IDENTITY (the pair objects
  `docKeys` already resolved), never via `doc.get`/`findPair`. If that duplicates the alias
  replacement visit, split the helper (collect vs. replace) rather than trip `check:duplication`.
- The plain-stringify fallback stays exactly as it is, but it is no longer silent: when the
  document path throws, log at debug level through the module's existing logger (find how
  `frontmatter.ts` or its nearest caller logs today; if the module has no logger, thread the
  optional note `path` that `parseNote` already accepts into a `console.debug`-free structured
  log via the server's logger module — match what `vault/` neighbours do) with the note path (when
  known) and the error message. No behaviour change for callers.
- Correctness beats byte fidelity; the fallback's exact-values guarantee is what the tests pin.

Required:
1. Test-first (RED on 67dde185, quote the symptom): the repro above asserting the re-parsed object
   AND that `&key`/`&v` survive in the emitted text (no fallback); an anchor on the value of the
   SURVIVING pair still found; the round-5 fixtures (`ALIAS_KEY_UNTOUCHED` and siblings) unchanged.
   A test that forces the document path to throw (e.g. a stubbed `doc.toString` or an input the
   library rejects on emit) asserts the fallback output is unchanged AND the debug log was called
   once with the path and message.
2. Keep every frontmatter test green (frontmatter-fidelity 109, comment-only 15,
   branch-coverage 35, m6-bulk 16 = 175 → 175 + new).
3. `frontmatter.ts` stays ≤ 120 comment lines; `check:comment-style` baseline (33) untouched.
4. CHANGELOG `### Fixed` bullet under [Unreleased] citing THE-1045 (origin: THE-1044 review).
