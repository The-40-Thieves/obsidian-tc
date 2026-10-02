# Facade mode per client: the Codex `domain` and `flat` cells (measurement)

Follow-up to the per-client `toolFacade.mode` study (PR #1107), which measured Claude Code in `triad`,
`domain` and `flat` and Codex in `triad` only, because Codex hit its weekly usage limit. This note records
the remaining Codex cells. The pre-registration is
[2026-10-02-facade-codex-cells-preregistration.md](2026-10-02-facade-codex-cells-preregistration.md)
(sha256 `e7402a1cff9681203275ee97af08c9b73b002474d744c937896bf57131675289`, recorded 2026-10-02T21:33:31Z); the
four addenda written while the run was in progress are reproduced below, each with its own hash and time.

## Result

Recommendation for Codex under the pre-registered rule: **`domain`**. `flat` is not distinguished from it
(the rule's own "close" flag is still set after four reps). `triad` stays the shipped default and the
recommendation for Claude Code (unchanged).

Codex CLI 0.159.2, default model `gpt-6.1-sol` (probed before the run and after every cell: identical each
time), plan `prolite` (weekly limit 0 to 9% used over the whole run), obsidian-tc 1.31.8 built from `eb637ce3`,
16 tasks x 4 reps = 64 trials per mode, 192 trials, every one confirmed complete.

| Codex CLI | trials | success | median calls-to-success | tool-not-found trials (events) | trials with an error (errors) | median billable tokens |
|---|---|---|---|---|---|---|
| `triad` | 64 | 64/64 | 5 | 5 (10) | 7 (12) | 20,384 |
| `domain` | 64 | 64/64 | 2.5 | 0 | 55 (65) | 20,498 |
| `flat` | 64 | 64/64 | 3 | 0 | 8 (8) | 20,779 |

Mean calls per trial: `triad` 5.39, `domain` 3.19, `flat` 3.25. Median wall time per trial: 26.4 s, 22.8 s,
25.2 s.

### Predictions, scored

| # | Prediction (registered before the data) | Outcome |
|---|---|---|
| 4a | Codex `triad` is not worse than `flat` | Held: 64/64 each, and `triad` needed more calls, so it is worse on the tiebreakers, not on success |
| 4b | Tool-not-found shows up more in `flat` and `domain` than in `triad` (the `tool_search` exact-name miss) | Did not hold: 0 trials in `flat` and `domain`, 5 trials in `triad` (the model guessing capability names `search_entities`, `list_entities`, `delete_observation` in `describe_capability`) |
| 5 | Codex `domain` has a validation error in most trials | Held: 55 of 64 trials (49 of 65 errors the missing `vault`) |
| 6 | Success is at or near the ceiling in all modes | Held: 192 of 192 |

### Full analyzer output, all 4 reps

### Per client x mode

| client | mode | trials | success | median calls-to-success | tool-not-found trials (events) | median billable | mean cache-write | mean ToolSearch | mean discovery | errors | timeouts | tools/list (count, KB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | triad | 64 | 64/64 (100%) | 5 | 5 (10) | 20384 | 0 | 0.00 | 2.53 | 12 | 0 | 3, 2 |
| codex | domain | 64 | 64/64 (100%) | 2.5 | 0 (0) | 20498 | 0 | 0.00 | 0.00 | 65 | 0 | 13, 29 |
| codex | flat | 64 | 64/64 (100%) | 3 | 0 (0) | 20779 | 0 | 0.00 | 0.00 | 8 | 0 | 176, 318 |

### Pass count per task (passes/trials) by mode

| task | codex triad | codex domain | codex flat |
| --- | --- | --- | --- |
| find-and-tag | 4/4 | 4/4 | 4/4 |
| bulk-tag | 4/4 | 4/4 | 4/4 |
| memory-observation | 4/4 | 4/4 | 4/4 |
| rename-fix-backlinks | 4/4 | 4/4 | 4/4 |
| fm-update | 4/4 | 4/4 | 4/4 |
| daily-append | 4/4 | 4/4 | 4/4 |
| dx-backlinks | 4/4 | 4/4 | 4/4 |
| dx-outgoing | 4/4 | 4/4 | 4/4 |
| dx-broken-links | 4/4 | 4/4 | 4/4 |
| dx-tags-folder | 4/4 | 4/4 | 4/4 |
| dx-by-property | 4/4 | 4/4 | 4/4 |
| dx-open-tasks | 4/4 | 4/4 | 4/4 |
| dx-canvas | 4/4 | 4/4 | 4/4 |
| dx-base | 4/4 | 4/4 | 4/4 |
| dx-memory-recall | 4/4 | 4/4 | 4/4 |
| dx-search-fact | 4/4 | 4/4 | 4/4 |

### Decision rule (pre-registered)

| client | recommended | tied on success | close cell | reason |
| --- | --- | --- | --- | --- |
| codex | domain | triad, domain, flat | yes: reps 3-4 | ties triad on success, better on calls and not-found |

### Not-found and error codes by mode

| client | mode | tool / code | n |
| --- | --- | --- | --- |
| codex | triad | describe_capability / unknown | 10 |
| codex | domain | get_entity / validation_error | 8 |
| codex | domain | list_tasks / validation_error | 8 |
| codex | domain | search_text / validation_error | 7 |
| codex | domain | read_canvas / validation_error | 4 |
| codex | domain | get_backlinks / validation_error | 4 |
| codex | domain | read_note / validation_error | 4 |
| codex | domain | list_tags / validation_error | 4 |
| codex | domain | read_base / validation_error | 4 |
| codex | domain | find_notes_by_property / validation_error | 4 |
| codex | domain | move_note / validation_error | 4 |
| codex | domain | update_observation / validation_error | 4 |
| codex | domain | update_frontmatter / validation_error | 4 |
| codex | flat | list_tags / validation_error | 4 |
| codex | flat | find_notes_by_property / validation_error | 3 |
| codex | triad | get_backlinks / note_not_found | 2 |
| codex | domain | find_unresolved_links / validation_error | 2 |
| codex | domain | read_frontmatter / validation_error | 1 |
| codex | domain | get_outgoing_links / validation_error | 1 |
| codex | domain | get_backlinks / note_not_found | 1 |
| codex | domain | list_notes / validation_error | 1 |
| codex | flat | patch_note / validation_error | 1 |

### Reps 1 and 2 only (the 32-trial-per-cell state when the rule first flagged the cell as close)

### Per client x mode

| client | mode | trials | success | median calls-to-success | tool-not-found trials (events) | median billable | mean cache-write | mean ToolSearch | mean discovery | errors | timeouts | tools/list (count, KB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | triad | 32 | 32/32 (100%) | 5 | 2 (2) | 21033 | 0 | 0.00 | 2.47 | 3 | 0 | 3, 2 |
| codex | domain | 32 | 32/32 (100%) | 2.5 | 0 (0) | 21306.5 | 0 | 0.00 | 0.00 | 33 | 0 | 13, 29 |
| codex | flat | 32 | 32/32 (100%) | 3 | 0 (0) | 20873.5 | 0 | 0.00 | 0.00 | 3 | 0 | 176, 318 |

### Pass count per task (passes/trials) by mode

| task | codex triad | codex domain | codex flat |
| --- | --- | --- | --- |
| find-and-tag | 2/2 | 2/2 | 2/2 |
| bulk-tag | 2/2 | 2/2 | 2/2 |
| memory-observation | 2/2 | 2/2 | 2/2 |
| rename-fix-backlinks | 2/2 | 2/2 | 2/2 |
| fm-update | 2/2 | 2/2 | 2/2 |
| daily-append | 2/2 | 2/2 | 2/2 |
| dx-backlinks | 2/2 | 2/2 | 2/2 |
| dx-outgoing | 2/2 | 2/2 | 2/2 |
| dx-broken-links | 2/2 | 2/2 | 2/2 |
| dx-tags-folder | 2/2 | 2/2 | 2/2 |
| dx-by-property | 2/2 | 2/2 | 2/2 |
| dx-open-tasks | 2/2 | 2/2 | 2/2 |
| dx-canvas | 2/2 | 2/2 | 2/2 |
| dx-base | 2/2 | 2/2 | 2/2 |
| dx-memory-recall | 2/2 | 2/2 | 2/2 |
| dx-search-fact | 2/2 | 2/2 | 2/2 |

### Decision rule (pre-registered)

| client | recommended | tied on success | close cell | reason |
| --- | --- | --- | --- | --- |
| codex | domain | triad, domain, flat | yes: reps 3-4 | ties triad on success, better on calls and not-found |

### Not-found and error codes by mode

| client | mode | tool / code | n |
| --- | --- | --- | --- |
| codex | domain | get_entity / validation_error | 4 |
| codex | domain | list_tasks / validation_error | 4 |
| codex | domain | search_text / validation_error | 3 |
| codex | triad | describe_capability / unknown | 2 |
| codex | domain | get_backlinks / validation_error | 2 |
| codex | domain | read_note / validation_error | 2 |
| codex | domain | list_tags / validation_error | 2 |
| codex | domain | read_base / validation_error | 2 |
| codex | domain | find_notes_by_property / validation_error | 2 |
| codex | domain | read_canvas / validation_error | 2 |
| codex | domain | move_note / validation_error | 2 |
| codex | domain | update_frontmatter / validation_error | 2 |
| codex | domain | update_observation / validation_error | 2 |
| codex | flat | list_tags / validation_error | 2 |
| codex | triad | get_backlinks / note_not_found | 1 |
| codex | domain | get_outgoing_links / validation_error | 1 |
| codex | domain | get_backlinks / note_not_found | 1 |
| codex | domain | list_notes / validation_error | 1 |
| codex | domain | find_unresolved_links / validation_error | 1 |
| codex | flat | find_notes_by_property / validation_error | 1 |

## What was held fixed

- Harness: `packages/server/eval/write-ergonomics/` at the merged #1107 head; the only file hashes that
  differ from the frozen study are `tasks.ts` and its test (the long-form date accepted by `dx-search-fact`,
  which was the single Codex miss in the first triad cell).
- Server: `eb637ce3`, built in a separate detached worktree. Not `main`, which has since gained the wiki tools
  and would change the `domain` and `flat` surfaces.
- Corpus: the same public evergreen corpus and seeded notes, rebuilt in place by the harness's `template.ts`
  (see addendum 1); 1,379 files, byte-identical to the template of the first study except one random
  entity id.
- Trials per cell, order and timeouts: as registered; reps 3 and 4 were run for all three modes so the rule
  could be re-applied on equal n.

## What differs from the first Codex `triad` cell, and why triad was re-run

The first cell (16 trials, 15 of 16, median 5 calls, 20.7k median billable) did not record its model, ran on
a different plan, and carried a since-fixed checker false negative. All three modes were therefore run again
here under one CLI version, one default-model resolution and one checker. The new `triad` cell (5 calls,
20.4k, 64 of 64) matches the old one in behaviour.

## Limits

One model (the CLI default, not pinned by the harness), one plan, one 16-task set, stdio, headless runs with
the shell tool off, semantic search degraded identically on every trial. The rule's success criterion is at
the ceiling here, so the recommendation rests on the tiebreakers (calls and tool-not-found), which are
small differences in an easy task set. The account had Codex connectors available (one trial listed them
through Codex's built-in resource-listing tool); no connector tool was called. The raw artifacts (transcripts,
proxy logs, archived vaults, 192 trial directories) stay on the maintainer's host and are not committed.

## Addenda (frozen when written)

### Addendum 1

sha256 `f7d8ba368d8c8b302aba176d8e58a509108cefbb6c44e9a971e8146fc9853e0d`, recorded 2026-10-02T21:48:19Z.

The first launch of the schedule produced 16 `triad` trials that all failed with zero obsidian-tc calls, and
was stopped by hand before its `domain` cell completed. Cause: the template had been byte-copied from
`../20261002-discovery/template`, but its warm index records the absolute path of the vault it was built
under, so the server refused to start ("vault id "main" is already recorded against a different path"); Codex
then fell back to an account connector (`codex_apps`) and answered from that. These trials are an
infrastructure fault, not a measurement of any mode; they are kept untouched under
`diag-runs/aborted-1-copied-template-path/` and are not counted anywhere.

Fix, before the relaunch: the template was rebuilt in this directory with the harness's own
`template.ts <root> --omit "Inbox/Messy frontmatter.md"` against the same public corpus. Its vault is the
same 1,379 files as the discovery template, byte-identical except one random entity id in
`memory/person/Maya Chen.md` (`diff -rq`). One single-trial smoke run (`dx-backlinks`, triad, PASS, only the
`obsidian-tc` MCP server used) is in `diag-runs/probe-trial-triad/`; it is not counted.

`verify-complete.py` additionally flags any trial whose transcript names an MCP server other than
`obsidian-tc` and does not count such a trial as complete. Nothing else in the registration changes. The
preregistration's statement that the template is a byte-copy of the discovery template is superseded by
this addendum (same corpus and seeded notes, rebuilt in place).

### Addendum 2

sha256 `87dde7849dae17f030d978042a974ab7b627b2d09ac541f892d969db78666e02`, recorded 2026-10-02T22:03:31Z.

The schedule stopped after `domain` rep 1 because `verify-complete.py` flagged one trial
(`rename-fix-backlinks`, PASS) as having used another MCP server. The transcript shows the model called
`list_mcp_resources` with the made-up server name `obsidian_tc`, which Codex rejected client-side
("unknown MCP server"); no foreign server was reached. The guard was too coarse, not the trial. The
guard now flags a trial only when a call to a server other than `obsidian-tc` SUCCEEDED. The trial is
counted as complete and in its cell; the guard change does not alter any metric or the decision rule. The
failed `list_mcp_resources` call is model friction and is visible in the transcript but is not an
obsidian-tc server error. The schedule was resumed with the remaining cells in the registered order
(`flat` rep 1, then rep 2 reversed: `flat`, `domain`, `triad`).

### Addendum 3

sha256 `c0974ae9b628ab0daae510286283683f11901a7554872a61930f885ddec54e96`, recorded 2026-10-02T22:32:23Z.

The schedule stopped once more after the last cell (`triad` rep 2): `verify-complete.py` flagged
`triad/dx-by-property__r2` (PASS) for a successful call to server `codex`. That is Codex's own built-in
`list_mcp_resources` tool (server name `codex`), which the model called with no arguments; it returned the
account's connector list (resource names only). No connector tool was called and the obsidian-tc calls
are intact. The guard now treats the built-in `list_mcp_resources` / `list_mcp_resource_templates` tools
as client behaviour, not a foreign server. The trial counts. All six cells (96 trials) had completed
before this addendum; no result depended on it. Observed for the record: this account has Codex
connectors (`codex_apps`) available to the model; no trial called one.

### Addendum 4

sha256 `cc213ea40b34734d55f41a5db324ae7a229aab7ddf2a4dc570b9954d6a745112`, recorded 2026-10-02T22:32:43Z.

Reps 1 and 2 (96 trials, `tables-reps1-2.md`, `results-reps1-2.json`) were all complete and all passed
(100% in every mode), so success is at the ceiling and the frozen rule falls through to its tiebreakers.
`facade-analyze.ts` returned: recommended `domain`, "ties triad on success, better on calls and not-found",
and flagged the cell as CLOSE (domain 2.5 and flat 3 median calls are within 0.5, tool-not-found equal at 0).

PREREGISTRATION.md rule 4 therefore applies: reps 3 and 4 are run, because the weekly-limit probe is at 5%,
far below the 50% condition. They are run for ALL THREE modes, not only the close pair, so the rule is
re-applied to all 4 reps on equal n (a comparison against `triad` on 32 versus 64 trials would not be
like for like). Order: rep 3 triad, domain, flat; rep 4 reversed. Same harness, server build, template,
guards and 240 s timeout. Cumulative billable-token ceiling 8,000,000 (2.2M spent on reps 1 and 2). The rule
text, tie band and detectable-difference statement are unchanged; the recommendation will be the rule's
output on the 4-rep data, whatever it is, and the write-up must also report the per-mode error counts, which
the frozen rule does not weigh.

## Operational notes

- Two guards in the run script flagged trials in the first pass (addenda 2 and 3); both were false positives
  of the guard, not of the trials, and the trials counted.
- A first launch (16 `triad` trials) was invalid: the template's index recorded the old vault path and the
  server refused to start (addendum 1). Those trials are kept aside and counted nowhere.
