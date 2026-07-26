# Measurement record: kNN derived-edge sweep (k × floor × derivedWeight)

**Status: COMPLETE 2026-07-26.** Result of the protocol frozen in
[the pre-registration](2026-07-26-knn-sweep-preregistration.md). Ticket: THE-532.

Aggregates only. The golden set keys queries to real note paths and is not committed; nothing here
carries vault content.

## Corpus and setup

- `~/obsidian-tc-eval/multi-hop-golden-set.yaml`, **250 queries**, asserted from the parse before
  the run started.
- Index settled once before the control arm: **12,698 chunks, all embedded**, recorded in
  `index-state.json` alongside the results. Every cell measured the same corpus.
- Control arm: same index, derived edges **not** walked.

## Result: null across the grid

Paired by query id, n = 250. Two-sided paired sign-flip permutation test, Benjamini–Hochberg
FDR at q = 0.10 across the m = 8 cells.

| k | floor | derivedWeight | ΔnDCG@10 | 95% CI | p | Δrecall@10 | queries moved | BH |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| 8 | 0.00 | 0.5 | −0.0023 | [−0.0092, +0.0043] | 0.5164 | −0.0098 | 36/250 | ns |
| 8 | 0.00 | 1.0 | +0.0071 | [−0.0041, +0.0196] | 0.2559 | +0.0027 | 62/250 | ns |
| 8 | 0.60 | 0.5 | −0.0023 | [−0.0092, +0.0043] | 0.5164 | −0.0098 | 36/250 | ns |
| 8 | 0.60 | 1.0 | +0.0071 | [−0.0041, +0.0196] | 0.2559 | +0.0027 | 62/250 | ns |
| 24 | 0.00 | 0.5 | +0.0020 | [−0.0072, +0.0119] | 0.6907 | −0.0010 | 46/250 | ns |
| 24 | 0.00 | 1.0 | +0.0024 | [−0.0096, +0.0151] | 0.7110 | −0.0040 | 74/250 | ns |
| 24 | 0.60 | 0.5 | +0.0020 | [−0.0072, +0.0119] | 0.6907 | −0.0010 | 46/250 | ns |
| 24 | 0.60 | 1.0 | +0.0024 | [−0.0096, +0.0151] | 0.7110 | −0.0040 | 74/250 | ns |

**No cell is significant. No confidence interval excludes zero.**

## Replication check: PASSED

The pre-registration made the rest of the grid uninterpretable unless `(k=8, floor=0.00, w=0.5)` —
the densification record's exact configuration — came back approximately inert. It did:
**−0.0023, p = 0.5164**, with only 36 of 250 queries moving at all. The sweep is comparable with
the record.

## The power estimate in the pre-registration was wrong, and conservatively so

The pre-registration assumed **σ_d = 0.173**, taken from THE-422. Observed: **σ_d = 0.055**.

| | σ_d | SE | MDE (single) | MDE (BH, m=8) |
| -- | -- | -- | -- | -- |
| pre-registered | 0.173 | 0.0109 | 0.031 | **0.039** |
| observed | 0.055 | 0.0035 | 0.0097 | **0.0124** |

The assumed figure was the variance of a much LARGER contrast — graph vs the semantic baseline.
This experiment compares graph vs graph-plus-derived-edges, where most queries do not move at all
(36–74 of 250), so the paired differences are far tighter.

Recomputing power from observed variance is legitimate here specifically because the endpoint, the
test, the FDR correction and the replication gate were all fixed before the data existed; only the
*sensitivity estimate* changed. The grid resolves **≈0.012**, not the ≈0.039 declared.

## Verdict

**No effect ≥ ≈0.012 nDCG@10 exists anywhere in the swept grid.**

THE-422's ship bar is ≥0.010. The grid resolves ≈0.0124 — just above it. So this is a
no-ship result at, and very nearly at the resolution of, the bar that matters:

- **Recommendation: do not enable kNN derived edges.** Nothing in the grid earns its cost.
- The scoped observation "kNN is inert" from the densification record is upgraded to a **general
  result across k ∈ {8, 24}, floor ∈ [0, 0.60], derivedWeight ∈ {0.5, 1.0}** — not merely the
  single point it previously rested on.
- **Residual, stated precisely:** an effect between 0.010 and 0.0124 would not have been detected.
  Closing that last sliver needs roughly n ≥ 380 paired queries, not a different grid.

## Two secondary findings

**The similarity floor is inert in [0, 0.60].** At k=8 the two floor variants produced
**byte-identical** per-query results — the 13 edges the floor removes (6,499 → 6,486) never reach a
top-30. At k=24 the 135 removed edges (18,977 → 18,842) shift individual queries, but the mean is
unchanged to four decimal places. The kNN neighbours are essentially all above 0.60 cosine, so the
floor has nothing to cut. This axis can be dropped from any future sweep.

**`derivedWeight` is the only axis that moves anything.** w=1.0 beats w=0.5 at both k values
(+0.0071 vs −0.0023 at k=8) and roughly doubles the queries affected (62 vs 36). Not significant,
but it is the one previously untested knob and the only one with a visible gradient. If this line
is ever revisited, vary derivedWeight and ignore floor.

## Cost

Index-time, on the 12,698-chunk eval index:

| k | edges built | densify wall time |
| -- | -- | -- |
| 8 | 6,499 | 177 s |
| 24 | 18,977 | 210 s |

**Serve-time latency was NOT captured**, and the pre-registration asked for it ("report the latency
cost alongside quality"). `eval/run.ts --json` emits per-query metrics only — no timing — so the
comparison against the tag-edge arm's +44% user-visible search latency could not be made. This is a
gap in the harness, not a result: it does not change the verdict, because a null quality effect
needs no cost justification, but a future arm that DID show quality would still have no latency
number to weigh it against.

## Reproducing

```bash
packages/server/eval/sweep-knn.sh          # ~75 min; resumes, skips completed cells
```

Per-cell artifacts (per-query metrics, edge counts, densify timings, corpus path, chunk count) are
written to `~/obsidian-tc-eval/the532-sweep/` and are not committed.
