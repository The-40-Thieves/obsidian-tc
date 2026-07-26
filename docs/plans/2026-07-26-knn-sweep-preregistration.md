# Pre-registration: kNN derived-edge sweep (k × floor × derivedWeight)

**Status: FROZEN 2026-07-26.** Written *before* any sweep cell has been evaluated. The machinery
(`eval/densify-index.ts`, the `DERIVED_WEIGHT` passthrough) was exercised beforehand, but no
quality number from a densified index has been observed. Nothing below may be amended once sweep
data exists; if the protocol turns out to be wrong it is abandoned and rewritten as a new
pre-registration, and that fact recorded.

Ticket: THE-532. Follows the convention of
[the tag-edge pre-registration](2026-07-14-tag-edges-preregistration.md).

## Why this document exists

The [densification measurement record](2026-07-14-densification-measurement.md) concluded that kNN
derived edges are "inert — no measurable benefit". That verdict rests on **one point** in the
parameter space: k=8, derivedWeight=0.5, floors {0, 0.80}, one vault, one backbone. A negative from
a single configuration cannot rule out the surface, so the verdict is scoped, not settled.

## Corpus (asserted, not assumed)

`~/obsidian-tc-eval/multi-hop-golden-set.yaml`, **250 queries**, asserted by parsing the file at run
time. A stale 136-query copy exists at a nearly identical path under `/data`; the canonical file's
own header still reads `136` and is wrong. The count is taken from the parse, never from the header
or from a ticket.

Index: `~/obsidian-tc-eval/cache-nomic-ctx/cache.db` — 12,159 chunks, nomic-768. Before this sweep
it carried **zero** derived edges of any kind (only `links_to` and `unresolved`), so every cell
builds its edge set from scratch.

## The grid (declared before running)

| axis | values | why |
| -- | -- | -- |
| `knnK` | 8, 24 | 8 is the record's tested value. 24 is the untested direction: a materially larger neighbourhood. |
| `knnMinSim` (floor) | 0.00, 0.60 | 0.00 is tested. 0.60 is untested and sits between the tested 0 and the tested 0.80, which may have been too strict to admit useful edges. |
| `derivedWeight` | 0.5, 1.0 | 0.5 is the record's value. 1.0 treats a derived edge as strongly as an authored wikilink — the untested direction, and the one most likely to make derived edges matter at all. |

**m = 8 cells.** `(k=8, floor=0.00, weight=0.5)` deliberately reproduces the record's configuration
and serves as a **replication check**: if it does not come back approximately inert, the sweep's
comparability with the record is in question and that must be reported before anything else is read.

Control arm: the same index and settings with derived edges **not** walked (`DENSIFY` unset), so
the comparison isolates the derived layer rather than any indexing difference.

Everything else is held fixed: `TOP_K=30`, `rrfK=10`, path-dedup off, `smoothExpansion` off,
`graphStream` off, `chunkContext` as already built in the index, no reranker, no sparse stream.

## Primary endpoint

Mean ΔnDCG@10 (cell − control), **paired by query id**, over all 250 queries.

## Statistical test and multiplicity

Two-sided paired sign-flip permutation test (`pairedPermutationTest`, `eval/stats.ts`), with
Benjamini–Hochberg FDR at q=0.10 across the **m = 8** cells. Percentile bootstrap CI reported per
cell. The full grid is reported including null cells — not just the best one.

## Power — and the honest limit of this sweep

THE-422 records σ_d ≈ 0.173 at n=250, giving SE ≈ 0.0109 and a single-comparison
MDE ≈ **0.031** (α=0.05, power=0.8, two-sided).

Across m=8 under BH-FDR, the worst-case position tests at α ≈ 0.0125, so the grid's detectable
effect is approximately **ΔnDCG@10 ≈ 0.037** in the worst case and ≈0.031 in the best.

**This is the load-bearing statement of this document.** The tag-edge arm's *observed* effect was
+0.0045, and THE-422's ship gate demanded ≥0.010. Both sit far **below** this sweep's resolution.
Therefore, declared in advance:

> A null result across this grid rules out kNN effects of roughly **0.037 or larger**. It does
> **not** rule out an effect in the 0.005–0.030 range, which is precisely where the tag-edge arm's
> effect lived. If the sweep returns null, the correct conclusion is **"no large effect; effects
> below ~0.037 remain unresolved at n=250"** — *not* "kNN is inert".

Outcome (b) in THE-532 — upgrading "kNN is inert" to a settled verdict — is therefore **available
only if the ship bar is ≥0.037**. Under a 0.010 bar it is unavailable at this n, and no amount of
sweeping fixes that: it is a property of the corpus size, not of the grid. Settling a 0.010 bar
would need roughly n ≥ 2,300 paired queries.

Recording this now, before the data, so a null cannot later be over-read the way THE-422's was.

## Cost, reported alongside quality

The tag-edge arm was killed on cost (+44% user-visible search latency), so a kNN configuration that
buys quality at similar cost is not automatically a ship. Each cell reports:

- index-time: `densify_ms` and the resulting `similar_to` edge count
- search-time: mean per-query latency, control vs cell

## Decision rules (declared)

1. **A cell clears the bar** — ΔnDCG@10 significant under BH-FDR *and* point estimate ≥ 0.037 *and*
   search latency within +10% of control → write a ship/no-ship recommendation naming the cell.
2. **Null across the grid** → record "no effect ≥ ~0.037 detected", with the explicit caveat above.
   Do **not** write "inert".
3. **The replication cell misbehaves** → report that first; the rest of the grid is not
   interpretable until it is explained.

## Guardrail

A winning cell is **hypothesis-generating only**. It may not be shipped on the data that selected
it; confirmation requires queries that did not participate in selection. This is the same rule
THE-422 applies to the tag-edge result, and the reason that ticket still exists.

## Artifact

Each cell writes JSON recording: the grid coordinates, the **measured query count**, the **corpus
path**, edge count, densify_ms, and per-query metrics — so a later reader can tell which corpus
produced which numbers without trusting a filename.
