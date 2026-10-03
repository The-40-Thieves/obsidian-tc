# Pre-registration: Codex `domain` and `flat` cells of the per-client `toolFacade.mode` study

Frozen before any measured trial in this directory. The machine-recorded time and sha256 of this
document are in `PREREGISTRATION.timestamp` and `PREREGISTRATION.sha256` beside it. It extends
`../20261002-discovery/PREREGISTRATION.md` (sha256
`aecd3a921eb4c5c272ef777a49ff9659104752b0623aa39a6cfbc9abbb339588`, PR #1107); everything not restated
here is inherited from it unchanged: the question, the 16 tasks and their prompts, the success checks,
the metrics, the decision rule and the predictions.

## Why this follow-up exists

PR #1107 measured Claude Code in `triad`, `domain` and `flat` (32 trials per cell) and Codex in `triad`
only (16 trials, one rep): the Codex weekly usage limit ran out during the first `domain` trials. The
owner has since upgraded the Codex plan (the first call in this session reports plan type `prolite`,
weekly window 0.0% used, resets 2026-10-09 21:16 UTC). The remaining cells are Codex x `domain` and
Codex x `flat`.

## Subject (what is held fixed, and what is not)

- Harness: `packages/server/eval/write-ergonomics/` at the merged #1107 head. Its file hashes equal the
  frozen list in `../20261002-discovery/PREREGISTRATION.harness.sha256` for every file except `tasks.ts`
  and `test/write-ergonomics-harness.test.ts`, which carry the one change made after the freeze: the
  `dx-search-fact` checker now also accepts the long-form date "November 12, 2026" (the one Codex miss
  in the triad cell was that false negative). The checker change is applied to every cell below.
- Task set: the same 16 tasks (`FACADE_TASK_IDS`: six find-then-write tasks, ten discovery tasks), verbatim
  prompts, same checkers, `--task-set facade`. (The request that started this follow-up said "30 tasks";
  the study's set is 16 and nothing was added, so the cells stay comparable.)
- Corpus: the same public evergreen corpus template, byte-copied from
  `../20261002-discovery/template` (1,357 notes plus the seeded notes and `Discovery/` folder; the
  broken-YAML note omitted, as before). No private vault text is read.
- Server: obsidian-tc 1.31.8 built from `eb637ce3` (the commit the Claude cells and the Codex triad
  cell were measured against), in a separate detached worktree, NOT from current `main` (which has since
  added the wiki tools and would change the `domain` and `flat` surfaces). `tools/list` is expected to be
  3 / 13 / 176 definitions for triad / domain / flat, as before; the proxy records it per trial.
- Codex CLI 0.159.2 (unchanged since the triad cell), `codex exec --json --ephemeral`, isolated
  `CODEX_HOME`, `approval_policy=never`, `default_tools_approval_mode="approve"`, shell off, 240 s
  timeout per trial: the harness defaults, no flags beyond `--facade`.
- Model: the harness does not set one, so Codex uses its default for the account. A probe at the start
  of this session (isolated home, same shape as the harness) resolved it to `gpt-6.1-sol`. The triad cell
  in #1107 did not record its model, so whether it was the same cannot be shown. This is the reason
  for the next section.

## Design

Because the old triad cell has an unrecorded model, a different plan and a since-fixed checker, ALL
three Codex cells are run fresh here, sequentially, one `codex` process at a time, under one CLI
version, one default-model resolution, one checker:

- 3 cells (`triad`, `domain`, `flat`) x 16 tasks x 2 reps = 32 trials per cell, 96 trials, the same n as
  the Claude cells. Rep 1 in the order triad, domain, flat; rep 2 reversed (flat, domain, triad), as
  before. The prompt cache is not reset between trials.
- The #1107 triad cell (16 trials, 15/16) stays as a historical reference in the write-up and is NOT pooled.
- The default model is probed again after each cell (and at the end); if it ever differs from
  `gpt-6.1-sol` the run stops and the cells measured under different models are reported separately.
- Budget guard: stop when billable Codex tokens (uncached input + cache writes + output, cache reads
  excluded) exceed 4,000,000 across reps 1 and 2 (about 1.6x the expected 2.4M at the triad cell's
  mean). Reps 3 and 4 (below) have their own cumulative ceiling of 8,000,000.
- The plan's weekly-limit usage is read from a probe between cells. If it passes 80% the run stops.

## Completion check (a quota error can exit 0 with no output)

A trial COUNTS only if its `client.out` contains a `turn.completed` event AND the client exit is 0 AND
a final message exists. `verify-complete.py` checks every trial directory and is run after each cell and
at the end; its output is part of the results. Handling of a trial that does not count:

- usage-limit or auth text in the output (or an empty run): stop everything, move the trial to
  `diag-runs/` (never deleted), report the study as partial with exactly the cells completed. Cells are
  never extrapolated or filled from another cell.
- timeout at 240 s: a counted failure (the model did not finish), with `timedOut` flagged.
- any other crash that is plainly not model behaviour (network, process kill): moved to `diag-runs/`, the
  same task and rep re-run once into the vacated path, both recorded.

## Metrics and decision rule

Unchanged from the frozen study: success, median calls-to-success (passing trials only; server `tools/call`
plus client tool-search calls), tool-not-found trials, median billable tokens; secondary: total errors and
codes, discovery calls, `tools/list` size, turns, wall time. Rule, applied to Codex alone with n = 32 per
cell by `facade-analyze.ts`:

1. Rank by success; modes within 2 trials of the best are tied.
2. Among tied modes: fewer median calls-to-success, then fewer tool-not-found trials, then fewer median
   billable tokens.
3. `triad` stays the recommendation unless another mode beats it on success by more than the tie band, OR
   ties it on success and is better on BOTH calls-to-success and tool-not-found.
4. A cell is "close" when two modes are within 2 trials on success and not separable on the tiebreakers
   (calls within 0.5, not-found equal). Reps 3 and 4 of the close cells are then run, unless the weekly
   limit probe is above 50% (then the close cell is reported as close and undecided, with no reps 3 and 4
   run). The rule is re-applied to all reps.
5. Smaller gaps than the detectable difference (about 21 points of success near 90%) are "not
   distinguished", never a win. The recommendation text must say which of the two it is.

The decision is reported per client; the shipped default does not change in this PR.

## Predictions carried forward (scored in the write-up)

From the frozen document, for Codex: (4) `triad` is not worse than `flat`; the exact-name `tool_search`
miss shows up as more tool-not-found in `flat` and `domain` than in `triad`. Added now, before data:
(5) Codex `domain` has a validation error in most trials, as Claude Code's did (the per-action schema is
not visible before the call). (6) Success is at or near the ceiling in all three modes.

## What would change my mind / not a result

- A `triad` result worse than the #1107 triad cell by more than the tie band is reported as a
  difference between two Codex configurations (plan/model/checker), not corrected away.
- Nothing here measures Cursor, Gemini CLI, Claude Desktop or VS Code.
- The Claude Code cells are not re-run.
