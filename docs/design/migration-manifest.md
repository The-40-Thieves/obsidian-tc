# Migration Manifest

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## 20260818_001_vault_context_watermark.sql (THE-647 item 1)

Borrows THE-461's `activation_state` discipline (capture the new watermark BEFORE the diff read,
persist it only AFTER the response is composed, never regress) rather than re-deriving it — see the
migration header and `context-watermark.ts` for the full reasoning.

Not `workspace_sessions`: THE-714 found it stays empty in production, so the watermark could not be
anchored there.

## EXPERIENTIAL_MIGRATION_FILES — THE-713, the admission test

Four shipped migration headers describe this store's charter and appear to contradict each other:
`20260626_001_experiential_init` says it holds *"only NON-RECONSTRUCTABLE keep-state"*, while
`20260725_002_note_quality` and `20260729_001_gap_reports` each admit a table because it is
*"DERIVED, RESETTABLE"*. Both phrases are in force and a `note_quality` rollup is plainly
reconstructable, so read literally the two rules exclude each other.

They are not two rules. They are one rule and one consequence, and the resolution is that
**NEITHER phrase is the admission test**:

> THE TEST IS TRUST, NOT RECONSTRUCTABILITY. A table belongs here when its contents are OBSERVED or
> DERIVED rather than AUTHORED — anything an injected episode, a retrieval event or a computed
> rollup can influence. The mechanism is a FILE boundary: nothing here can hold a foreign key into
> an authored atom (ids are referenced BY VALUE — "this is the membrane"), so poisoning blast
> radius is capped at the store boundary.

Given that test, both phrases follow rather than compete:

- **"resettable"** — a consequence. Because nothing authored depends on this file, losing it is
  survivable and a reset is a truncate, not a filtered delete.
- **"non-reconstructable"** — a WARNING, not a criterion. Some of what lives here (activation
  history, retrieval feedback, stated goals) cannot be recomputed from the vault, so "resettable"
  must not be read as "costless to discard".

`20260803_002_goals` already reasoned this way in practice — it admitted goals by arguing the
membrane is a file boundary and the trust boundary is enforced on the WRITE PATH, not by the
store's label. The rule above states the general case that migration applied.

Stated in this file rather than fixed in place because migration headers are CHECKSUM-PINNED:
editing a shipped migration is a hard startup error, so those four sentences cannot be corrected,
and this manifest is the nearest editable home that every reader of the chain already passes
through.

## 20260805_002_score_calibration.sql (THE-733)

`gaps --calibrate` printed the per-vault calibrated score distribution and returned, so no
percentile existed at query time — the only number reachable from the request path was a global
constant from an n=136 calibration on ONE vault. This migration persists the distribution instead.

## 20260806_001_retire_retrieval_outcome.sql (THE-718, final)

Measured 0 stamps across 108 rows for `chunk_retrievals.outcome`. The column was unreachable until
2026-08-03, so the zero is not low adoption of a working signal — the column never had a caller
that could write it.

## 20260806_004_citation_runs_judge_errors.sql (THE-717 follow-up)

Both live passes logged 3/3 "parse failures" that were, every one of them, an HTTP 404 — a judge
that is DOWN was recorded identically to a judge that is BABBLING before this split.

## 20260806_006_episode_eligibility_reason.sql (THE-746)

THE-672's measurement had to diff two hand-made database copies to learn which eligibility rule
fired for a given episode. This migration records the reason and the policy version directly so a
later policy change is distinguishable from a data change without that manual diff.

## 20260816_001_episode_type_structural.sql (THE-839)

`episode_type` had been the literal `'tool_call'` for every captured operation since
`20260711_002_agent_episodes.sql` — 630 rows, one distinct value, no information. 192 of them
(30.5%) turned out to be MCP protocol methods arriving through `dispatchResource`, not tool calls.

## 20260816_002_episode_verdict_at.sql (THE-726)

Measured 4.82 dispatches per session on average. Without `verdict_at` + `session_id` establishing
window identity, the preference extractor read N projected rows as N independent observations — a
single 18-dispatch task would consume 18 of its 40 evidence slots.

## 20260818_002_chunk_access_stats_excludes_advisory.sql (THE-634)

Found via adversarial review, not routine testing: the proactive-advisory sweep's pushed-not-retrieved
rows were silently bumping `access_count`/`last_accessed_at`, clearing `note_quality`'s
`stale_access` flag and inflating `metrics.ts`'s knowledge-health scorecard.

## 20260820_001_preference_scope_caller.sql (THE-891 item 6)

The mapping of a NULL caller to `''` (human-shared scope) was chosen deliberately to avoid
repeating the NULL-`vault_id` invented-attribution mistake from the earlier global-scope design
(see `20260724_001`/`20260803_001`): a missing caller must resolve to an explicit, intentional
scope rather than being silently attributed to any one caller.
