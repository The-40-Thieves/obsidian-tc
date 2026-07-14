# Pre-registration: confirmatory test of tag co-occurrence edges

**Status: FROZEN 2026-07-14.** Written *before* any confirmatory data exists. Nothing below may be
amended once the confirmatory data has been observed; if the protocol turns out to be wrong, it is
abandoned and re-written from scratch as a new pre-registration, and that fact is recorded.

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
only against the non-inferiority floor, not for significance.

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
- **(b)** A fresh query split mined from the same vault, with queries disjoint from all 136. *Weaker* -
  same corpus, same tag habits; it confirms the effect is not query-sampling noise but not that it
  generalizes beyond this vault's tagging style.

No exclusions. Every query in the confirmatory set is analyzed. The analysis is run **once**, after the
data exists.

## Pre-committed interpretation

- **p < 0.10 and dNDCG >= 0.010** -> tag edges are real and worth their latency. Ship default-on for
  multi-hop, with the latency regression documented.
- **p < 0.10 and dNDCG < 0.010** -> real but not worth ~2x walk cost. Stays off. Pursue pruning.
- **p >= 0.10** -> the exploratory result was noise on 10 queries. Stays off. Record the null and stop.
- **dNDCG <= 0 on multi-hop** -> abandon the mechanism entirely; do not re-test it on a third set.

The third and fourth outcomes are the likely ones, and saying so here is the point of pre-registering.
