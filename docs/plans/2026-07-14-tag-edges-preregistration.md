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

## Statistical power (declared in advance)

The exploratory effect was +0.0045 nDCG@10 overall, concentrated in multi-hop (+0.013 on `hop`), and it
moved only 10 of 136 queries. An effect that sparse is why the confirmatory set must be **sized, not
inherited**: at the exploratory per-query variance, detecting a multi-hop delta of +0.010 at 80% power
requires on the order of **120+ multi-hop queries** — roughly double the 68 multi-hop queries in the
current golden set. A confirmatory run on fewer than ~120 multi-hop queries is **underpowered by
construction**, and a null from it must be reported as inconclusive rather than as a refutation. If that
many cannot be mined, say so and do not run the test.

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

**SHIP** requires *all three*:

1. Primary endpoint p < 0.10 **and** dNDCG > 0.
2. Every guardrail satisfies delta > -0.015 (the project's standing non-inferiority floor).
3. **Cost gate:** dNDCG >= 0.010 on the primary endpoint.

Clause 3 is the one the exploratory run forced into existence. Derived-edge traversal costs a measured
**1.8-2.4x on graph-walk latency**. A statistically real but tiny effect does not justify that: a PASS
with dNDCG < 0.010 is **not a ship**. It licenses only further work - pruning tag edges by fanout or
IDF to cut the frontier, and re-testing the pruned variant under a fresh pre-registration.

**KILL** otherwise. The feature stays default-off, the flag stays for re-test, and the null is recorded.

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

- **p < 0.10 and dNDCG >= 0.010** -> tag edges are real and worth their latency. **But note what
  "ship for multi-hop" would actually require**: `includeInWalk` is a global flag. It is not, and has
  never been, restricted to multi-hop queries — there is no class gate on it. So a PASS does not license
  flipping the existing flag on. It licenses exactly one of:
  **(a)** build a class gate first (the deterministic `classRouter` already classifies queries, and is
  itself off by default), ship tag edges only on the multi-hop route, and re-measure the cost on that
  route; or
  **(b)** ship globally and eat the measured **+33% end-to-end latency on every query**, including the
  single-hop, lexical, and temporal ones the exploratory run showed derive **zero** benefit — which is a
  bad trade on its face and should not be taken without a further argument.
  Writing "(a) or (b)" here, before the data, is the point: otherwise a PASS would quietly become a
  one-line flag flip that taxes every query in the vault to help a tenth of them.
- **p < 0.10 and dNDCG < 0.010** -> real but not worth ~2x walk cost. Stays off. Pursue pruning.
- **p >= 0.10** -> the exploratory result was noise on 10 queries. Stays off. Record the null and stop.
- **dNDCG <= 0 on multi-hop** -> abandon the mechanism entirely; do not re-test it on a third set.

The third and fourth outcomes are the likely ones, and saying so here is the point of pre-registering.
