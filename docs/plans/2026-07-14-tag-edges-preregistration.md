# Pre-registration: confirmatory test of tag co-occurrence edges

**Status: FROZEN 2026-07-14.** Written *before* any confirmatory data exists. Nothing below may be
amended once the confirmatory data has been observed; if the protocol turns out to be wrong, it is
abandoned and re-written from scratch as a new pre-registration, and that fact is recorded.

> **Amended 2026-07-14, before any confirmatory run.** An external audit found the original data clause
> would have accepted a post-hoc split of the same 136 queries as "independent" confirmation. It would
> not have been: all 136 generated the hypothesis. The clause is tightened below. This amendment is
> legitimate precisely because no confirmatory data has been observed - the freeze binds from here.

## Why this document exists

The exploratory run ([measurement record](2026-07-14-densification-measurement.md)) found tag edges
improved nDCG@10 by +0.0045 (95% CI [0.0009, 0.0098], p=0.0102) on the n=136 golden set. That result
**generated** the hypothesis; it cannot also confirm it. Re-running the same test on the same 136
queries would be circular - it would re-measure the noise that produced the signal.

## Hypothesis (single, directional)

> Enabling tag co-occurrence derived edges in the graph walk improves nDCG@10 on **multi-hop** queries
> relative to the authored-wikilink-only walk.

Restricted to multi-hop because the exploratory per-class breakdown showed the effect is confined there,
and showed single-hop / lexical / temporal queries are *byte-identical* to control (they never traverse
far enough to reach a derived edge). Testing them again would only add noise and multiplicity.

## Configuration under test (frozen)

`retrieval.densify`: `tagEdges: true` - `maxTagFanout: 25` - `includeInWalk: true` - `derivedWeight: 0.5`
- `knnEdges: false` - `llmEdges: false`. Walk: `hopLimit: 2`, `rrfK: 10`, `TOP_K: 30`,
`smoothExpansion: false`, `graphStream: false`. Backbone: nomic-768 with `chunkContext: true`.
Control arm: identical, `tagEdges: false`. Both arms must carry the `20260713_001` columns.

## Primary endpoint

Mean dNDCG@10 (tag - control), **paired by query id**, over multi-hop queries only.

## Statistical test

**m = 1.** Exactly one hypothesis is tested. Two-sided paired sign-flip permutation test
(`pairedPermutationTest`, `packages/server/eval/stats.ts`), 10,000 permutations. A percentile bootstrap
95% CI is reported alongside. No multiplicity correction is needed *because only one test is run* - and
no additional test may be added later to rescue a null.

## Guardrail metrics (reported, not significance-tested)

recall@10, MRR@10, bridge recall - computed on the **full** confirmatory query set. These are checked
only against the non-inferiority floor, not for significance. **The check is on the CI LOWER BOUND**, not
the point estimate: a guardrail passes iff the bootstrap 95% CI lower bound of its delta exceeds -0.015.
A point delta above the floor with a CI reaching well below it has not demonstrated non-inferiority, it
has merely failed to demonstrate harm, and those are different claims.

## Statistical power (calculated, not asserted)

An earlier draft of this document said "on the order of 120+ multi-hop queries". That number was
**asserted, not computed** — which is precisely the sin this whole document exists to prevent. Here is the
calculation, from the published exploratory data.

Paired per-query deltas (tag - control, nDCG@10) over the 68 multi-hop queries in the golden set:

- observed mean = **0.00895**
- observed SD = **0.03824**

For a paired test at alpha = 0.10 (two-sided) and 80% power, n = (z(0.95) + z(0.80))^2 * SD^2 / delta^2
with z(0.95) = 1.6449 and z(0.80) = 0.8416:

| target delta | required n (multi-hop queries) |
|---|---|
| +0.013 (the observed `hop` effect) | **54** |
| **+0.010 (the cost gate)** | **91** |
| +0.005 | 362 |

**The confirmatory set must carry at least 91 multi-hop queries** to detect the effect the cost gate
requires. The current golden set has **68** — underpowered for this purpose, by calculation rather than by
vibe. Reproduce from the committed artifacts:

```
# deltas: tag.json minus ctl.json on graph.ndcg_at_10, over ids prefixed hop- / orig-
docs/plans/data/2026-07-14-densification/{ctl,tag}.json
```

A run on fewer than 91 multi-hop queries is **underpowered by construction**, and a null from it must be
reported as **inconclusive, not as a refutation**. If 91 cannot be mined, say so and do not run the test.

## Query mining and relevance judgment (frozen procedure)

- Queries are mined by the existing golden-set procedure, from note pairs, **before** any arm is run.
- Relevance judgments are fixed **at mining time** and are never revised after seeing an arm's output.
- The person or process assigning relevance is **blind to arm assignment** — trivially satisfied when
  judgments precede the runs, which is why the order above is mandatory, not incidental.
- Ties and near-misses are resolved at mining time and recorded; no post-hoc adjudication.

## Frozen environment

The confirmatory run pins, and records in its result note: the **repository commit**, the **corpus
snapshot** (vault content hash / date), the **embedding model + dimensions + `chunkContext` setting**,
and the **index build** used for both arms. Both arms must be copies of ONE index snapshot, differing
only in edge rows — the same discipline the exploratory run used, for the same reason.

## Decision rule (frozen)

This test can conclude **MECHANISM CONFIRMED**. It cannot conclude **SHIP**. An earlier draft used "SHIP"
as the success label and then, two sections later, explained that a pass would not actually authorize
enabling the flag — an incoherence worth naming rather than smoothing over. The two are separate gates and
they are now separate sections.

### Gate 1 — MECHANISM CONFIRMED (what this test decides)

All three required:

1. **Effect:** primary endpoint p < 0.10 **and** dNDCG > 0.
2. **Non-inferiority:** every guardrail's bootstrap **95% CI lower bound > -0.015**. Not the point
   estimate — a point delta above the floor whose CI reaches well below it has not demonstrated
   non-inferiority, it has merely failed to demonstrate harm.
3. **Cost gate:** dNDCG >= 0.010 on the primary endpoint.

Clause 3 exists because the mechanism is not cheap. Measured: derived-edge traversal costs **2.6-2.75x on
the graph walk**, and **+44% (+222 ms) on user-visible search latency** (`graphSearch` 466 -> 688 ms
median, plus an arm-independent 34 ms query embedding). A statistically real but tiny effect does not
justify that bill.

**NOT CONFIRMED** otherwise: the feature stays default-off, the flag stays for re-test, the null is
recorded, and no further gate is opened.

### Gate 2 — AUTHORIZED TO SHIP (what this test does NOT decide)

CONFIRMED does not license flipping `includeInWalk`, because **that flag is global**. There is no class
gate on it and never has been. So confirming the mechanism on multi-hop queries leaves exactly two paths,
and both need their own evidence:

- **(a) Build the class gate.** The deterministic `classRouter` already classifies queries (and is itself
  off by default). Route derived edges only to the multi-hop class, then **re-measure BOTH quality and
  latency through the actual classifier** — not just cost. A router misclassification does not merely
  waste time, it changes *which* retrieval path a query takes, so it can move quality in either direction.
  Reusing this test's quality numbers for a routed deployment would be invalid.
- **(b) Ship globally** and accept +44% on **every** query, including the single-hop, lexical, and
  temporal ones the exploratory run measured to derive **zero** benefit. If this path is taken it requires
  a **declared latency budget** decided before the measurement: a p95 user-visible search budget the
  deployed configuration must fit inside. Absent such a budget, (b) is not a decision, it is a shrug.

Writing this down before the data is the point. Otherwise a PASS quietly becomes a one-line flag flip that
taxes every query in the vault to help a tenth of them.

## Data (the load-bearing constraint)

The confirmatory set **must not be** the 136-query golden set that generated the hypothesis. Acceptable:

- **(a)** A second vault with its own independently mined golden set. *Preferred* - it also tests
  whether the effect survives a different tag taxonomy, which is the real generalization question,
  since the mechanism depends entirely on how the author tags.
- **(b)** **Newly mined** queries from the same vault that have **never been evaluated** against any arm.
  *Weaker* - same corpus, same tag habits; it would confirm the effect is not query-sampling noise, but
  not that it generalizes beyond this vault's tagging style.

**A post-hoc partition of the existing 136 does not qualify and is explicitly forbidden.** All 136
queries were evaluated on every arm, and every one of them contributed to discovering the tag hypothesis.
Splitting them after the fact yields a "held-out" set that was never held out. Confirmation requires
genuinely untouched data.

**Out of scope for this pre-registration:** kNN. Its scoped negative (two floors, one k, one weight) does
not settle the mechanism, but re-opening it means a k / floor / `derivedWeight` sweep, and a sweep is a
new multiplicity problem that needs its own protocol. It may not be smuggled into this test.

No exclusions. Every query in the confirmatory set is analyzed. The analysis is run **once**, after the
data exists.

## Pre-committed interpretation

- **p < 0.10 and dNDCG >= 0.010** -> **MECHANISM CONFIRMED**, and Gate 2 opens. Not a ship. Pick path
  (a) or (b) above and produce the evidence that path requires.
- **p < 0.10 and dNDCG < 0.010** -> real but not worth ~2x walk cost. Stays off. Pursue pruning.
- **p >= 0.10** -> the exploratory result was noise on 10 queries. Stays off. Record the null and stop.
- **dNDCG <= 0 on multi-hop** -> abandon the mechanism entirely; do not re-test it on a third set.

The third and fourth outcomes are the likely ones, and saying so here is the point of pre-registering.
