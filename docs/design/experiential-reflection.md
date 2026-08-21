# Experiential Reflection — Evaluator & Preference Extraction

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## File header (THE-222 safety invariants)

### THE-701 — judge layer removal (2026-08-02)
Removed on measurement, not on principle. Over 333 candidates, the judge layer denied 35 rows, ALL of them status=error and nothing else — 100% of its effect was reproducing `status === "error"`, at 94.6% fidelity with zero false positives on ok rows. That contradicted the file's own policy ("errors are lessons too"), and because the judge could only LOWER, it won every disagreement silently. It also could not have been doing its stated job: every episode had `summary IS NULL`, so it saw only id/tool/status while being asked to detect manipulative content — that job is already done deterministically and earlier by `assessPoison()`, which runs at capture and stamps a high-risk row 'ineligible' at birth (episodes.ts:184), before this pass's WHERE ever sees it.

### THE-721 — task_result = -1 gate correction (2026-08-06)
An earlier version of the file-header comment claimed the -1 was "stamped by the citation / session-close outcome pass." No such writer exists, and none ever did: `agent_episodes` has seven write statements across the tree and not one of them sets `task_result`, so the column is NULL on 414 of 414 live rows (re-measured 2026-08-06; it was 363 when the original comment was written, and the ratio has never moved off 1.0). The citation pass stamps `chunk_retrievals` columns only; there is no session-close pass (sessions.ts and session-tools.ts never touch the column). The same false claim is frozen into migration 20260711_001's header, which is checksum-pinned and cannot be corrected in place — THE-721 carries the correction here instead.

Consequence: bounded rather than dangerous. An unreachable HOLD is more permissive than designed, not less, and there is no known-bad set to leak because nothing marks one. `reflect-evaluator.test.ts:96` seeds `task_result: -1` directly and asserts the hold, so the gate is ready the moment a producer exists. Whether to build one is the open question on THE-721.

## `partitionPending` (THE-698)

Extracted so `readEpisodeBacklog` can answer "how many pending rows would this pass promote?" WITHOUT promoting anything. That question is what a health check actually needs: a pending row is not evidence the evaluator is broken — held rows are supposed to stay pending forever, and on the live store four contradictory `index_vault` episodes do exactly that. A count of pending rows therefore cannot distinguish "the evaluator has never run" from "the evaluator ran and correctly held these," and a check built on that count warns forever on a healthy deployment. Measured: it did, immediately after the live promotion left 333 eligible and 4 legitimately held.

Deliberately shared rather than reimplemented in the checker. Two copies of these predicates would drift, and the drift would be silent in exactly the direction that matters — a checker that thinks fewer rows are promotable than the evaluator does reports healthy while the tier goes dark again.

## `evaluateEpisodes` — THE-726 race sequence

The promotion UPDATE re-checks `task_result` as well as `eligibility`, and that second clause is load-bearing rather than defensive. This pass reads, classifies in memory, then writes — it is not wrapped in a transaction — so a verdict can land in the gap:

1. this pass selects row R (pending, task_result NULL) and classifies it for promotion
2. a verdict transaction stamps R = -1; its own demotion matches nothing, because R is still `pending` and demotion only moves rows OUT of `eligible`
3. the promotion UPDATE promotes R anyway, and R is now eligible carrying a -1

R would then never be re-inspected, because the next pass selects only `pending`. Re-checking `task_result` in the UPDATE's WHERE means step 3 promotes nothing and the following pass holds R with its reason recorded. Without this clause, the demotion in verdict.ts closes only the case where the verdict arrives AFTER promotion, and the claim that the hold is order-independent would be false.

## `applyPreferenceDeltas` — vault-partition namespace history (THE-710)

THE-710 revised the P1.8 / audit-THE-562 disposition of this table before THE-891 narrowed it again. The preference plane was previously keyed by `key` alone, deliberately, on the rationale that a single-user runtime wants one shared profile. That rationale did not extend to a single-vault assumption: with two vaults configured, one vault's learned preference silently overwrote the other's under the same key, with no column to filter on — the THE-310 defect class. Migration 20260803_001 rebuilt both tables (`preference_profile`, `preference_deltas`) to lead the primary key with `vault_id`; migration 20260820_001 (THE-891) narrowed it further to `(vault_id, scope_caller, key)` so the caller axis is per-key rather than global.

## `PREFERENCE_KEYS` (THE-673 / THE-891)

Enforced in application code rather than a DB `CHECK`: `key` is part of `preference_profile`'s primary key, and SQLite cannot add a `CHECK` to an existing column without a full table rebuild — the same class of migration `20260803_001`/`20260820_001` already had to do twice for this table. A TypeScript allowlist gives the same "impossible state" guarantee at zero migration cost.

Four other keys were once proposed for this registry and rejected because each needs an input this ticket does not build:

- `preferred.output_format` — needs `captureContent` flipped on
- `response.detail` — needs THE-675's transcript question
- `citation.style` — needs an elicitation/HITL producer
- `workflow.confirmation_level` — needs an elicitation/HITL producer

Shipping them unregistered-but-inert would be the ticket's own named anti-pattern ("four keys nothing can ever write").

## `groupEpisodesByVerdictWindow` (THE-726 / THE-673)

Measured on the live corpus at 4.82 dispatches per session (range 1-18): without the window collapse, a single 18-dispatch task would outweigh a careful one-call task 18:1 for the same single judgement — the length bias this function removes.

Extracted as ONE shared helper (originally inline in the now-removed LLM evidence-line formatter), on the same standing rule against two copies of one predicate drifting apart that `partitionPending`'s entry above describes: the deterministic counter built on this needs exactly the same collapse the LLM path needed, and a second copy is exactly the kind of drift that would be silent in the direction that matters.

KNOWN LIMIT: grouping happens AFTER whatever row LIMIT the caller applied upstream, so a large window still consumes ROW slots even though it contributes one WINDOW. At the measured 4.82 dispatches per window, a 40-row budget yields roughly 8 windows, not 40 — under-sampling, and a strictly smaller problem than the length bias this collapse removes.

## `buildSearchModeDeltas` (THE-673)

The binding requirement on this ticket is "one window contributes ONE observation." When a window dispatched more than one distinct search-family tool, the majority tool within that window is the window's one observation, not a delta per tool — a delta per tool would let a single judgement bump the weight multiple times and violate that requirement. Ties are broken toward the most recently dispatched tool: evidence rows arrive ts-DESC, so the first-seen tool in the count map is the latest.

`task_result = 0` (recorded but neutral) produces no delta: a neutral or unjudged window is not evidence of preference either way, and treating "used a tool" alone as revealed preference would silently reintroduce the "count everything, judged or not" behaviour the eligibility WHERE (`task_result IS NOT NULL`) already excludes upstream. A window with no search-family tool at all (e.g. only `read_note`) also produces no delta — this axis counts choice among search alternatives, not general activity.

`op` is always `add` on the positive branch rather than a looked-up `strengthen` — `applyPreferenceDeltas`'s `add` already upserts (create-or-reinforce, refresh `value`), so it is the create-or-strengthen behaviour the design calls for without a second DB read to pick a label. `weaken` is left as a plain UPDATE-only op on purpose: weakening a key that was never added must stay a no-op (the existing C4 guard in `applyPreferenceDeltas` — no phantom audit row), never a way to sneak the key into existence from the negative side.

## `extractPreferences` (THE-673 / THE-644)

THE-718 removed the retrieval-evidence half of this extractor. THE-644 reopened it, repointed at the axis that actually has a producer — `citation_state` — not the still-dead `feedback` an earlier version of this comment named as the repoint target. `opts.cacheDb` is that gate, and it is a CALLER decision, not a flag read internally: the caller only supplies it when `experiential.citationPreferences` is on, so leaving it undefined (the default) skips `citationEvidence` entirely and the function is byte-identical to the THE-673 version — same query, same windowing, same one evidence source.

## `registerEpisodeEvaluation` (THE-698)

`evaluateEpisodes` had exactly two non-test call sites before this: its own definition and the manual `obsidian-tc reflect` CLI. Nothing wired it on a schedule the way `registerActivationRecompute` wires activation, so the promotion pass simply never happened unless an operator remembered to invoke it. Measured on the live store before this shipped: 337 of 337 episodes `pending`, zero eligible, across seventeen days of continuous capture.

The consequence was not a stale number but a dark subsystem. `work_search` serves evaluator-approved rows only — that is its security contract, not a default — so with zero eligible rows it returned nothing, always. An empty result is indistinguishable from "nothing matched," which is exactly how this stayed invisible. SECURITY.md documents `pending` as "a short-lived state and not a quarantine"; seventeen days at 100% pending is a quarantine.
