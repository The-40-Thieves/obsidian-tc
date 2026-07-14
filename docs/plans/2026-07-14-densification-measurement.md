# Graph densification: measurement record and verdict

Status: **complete**. Date: 2026-07-14. Vault: `E:\Obsidian\Second Brain` (live snapshot, copied; the
live index was never mutated). Golden set: n=136, 5 query classes.

This is the full experimental record for the densification feature shipped (default-off) in #250-#256.
It supersedes the informal numbers quoted while the work was in flight; an external audit correctly
found that the first-pass statistics were graph-vs-baseline within each arm rather than
treatment-vs-control across arms, and that the combined arm confounded two independent mechanisms.
Both defects are corrected here.

## 1. What was tested

Three derived-edge mechanisms, all off by default, all writing to `vault_edges` with
`edge_kind != 'literal'` and never written back into notes:

| edge_type | source | confidence |
|---|---|---|
| `shared_tag` | frontmatter tag co-occurrence, hub tags excluded at `maxTagFanout=25` | 1.0 |
| `similar_to` | vec0 kNN over existing chunk embeddings, `k=8` | cosine similarity |
| `semantically_similar_to` | LLM Pass-3 via the local gateway | model-assigned, snapped to a rubric |

The LLM layer is **not** in this experiment: it requires the local inference gateway, which cannot run
on this machine (open WSL2/Hyper-V kernel fault). Only the two zero-egress mechanisms were measured.

## 2. Arms

Five SQLite index copies, all derived from one snapshot of the live enriched index
(nomic-768, `chunkContext: true`) so the embeddings are byte-identical across arms. All arms carry the
`20260713_001` derived-edge columns, so schema is identical too - only edge rows differ.

| arm | edges | how built |
|---|---|---|
| `ctl` | 11,033 | control: authored wikilinks only (`links_to`) |
| `tag` | 19,410 | control + 8,377 `shared_tag` |
| `knn` | ~22,800 | control + `similar_to` (k=8, no similarity floor) |
| `knn80` | - | `knn` with `similar_to` edges below cosine 0.80 deleted |
| `trt` | 25,164 | control + both (the combined arm) |

`knn80` and the single-mechanism arms were derived from `trt` **by deletion**, not by re-running kNN:
`confidence` on a `similar_to` edge *is* its cosine similarity, so a similarity floor is a `DELETE`.
This is why the ablation was cheap enough to run at all.

## 3. Retrieval parameters (identical in every arm)

`hopLimit: 2` - `rrfK: 10` - `TOP_K: 30` - `derivedWeight: 0.5` (derived edges down-weighted in the
walk) - `includeInWalk: true` in every densified arm - smoothExpansion and graphStream both **off**
(their defaults).

## 4. How it was run

```
# per arm, with the arm's index as the cache dir:
DENSIFY=1 bun eval/run.ts <arm-config>.json --json <arm>.json    # DENSIFY=1 sets densify.includeInWalk
bun eval/compare.ts ctl.json <arm>.json                          # PAIRED, by query id
```

`eval/compare.ts` pairs per query id and reports the mean delta, a two-sided sign-flip permutation
p-value, and a percentile bootstrap 95% CI. It reports **raw** p-values; multiplicity is applied by hand.

## 5. Results - paired, treatment vs control, n=136

Control reproduces the champion exactly (recall@10 .871 / nDCG .786 / MRR .851 / bridge .831), which is
the arm-validity check.

| arm | dNDCG@10 | 95% CI | p | drecall | dMRR | dbridge |
|---|---|---|---|---|---|---|
| **tag** | **+0.0045** | **[0.0009, 0.0098]** | **0.0102** | +0.005 | +0.004 | 0.000 |
| knn | -0.001 | [-0.005, 0.003] | 0.83 | -0.002 | +0.001 | -0.007 |
| knn80 | +0.001 | [-0.003, 0.004] | 0.61 | +0.000 | +0.001 | -0.007 |
| trt (combined) | +0.002 | [-0.003, 0.008] | 0.51 | +0.000 | +0.004 | -0.007 |

**The combined arm masked the tag signal.** Testing the two mechanisms together produced a null
(p=0.51); separating them showed tag is the only arm whose CI excludes zero. The audit that demanded
separable arms was right, and this is the finding it produced.

kNN is **inert at every threshold**. The `minSim: 0` default looks unsafe but is empirically harmless:
the kNN confidence distribution is min 0.571 / mean 0.809, so a 0.5 floor drops zero edges - and
raising the floor to 0.80 still moves nothing (p=0.61).

## 6. Where the tag effect lives (per-class breakdown)

| class | n | dNDCG | 95% CI | p | queries moved |
|---|---|---|---|---|---|
| hop (mined 2-hop) | 36 | +0.0129 | [0.0006, 0.0316] | 0.13 | 4 (4 up, 0 down) |
| orig (multi-hop pair) | 32 | +0.0045 | [-0.0000, 0.0101] | 0.13 | 6 (5 up, 1 down) |
| kms (single-hop) | 30 | 0.0000 | - | 1.00 | **0** |
| lex (lexical/exact) | 28 | 0.0000 | - | 1.00 | **0** |
| tmp (temporal) | 10 | 0.0000 | - | 1.00 | **0** |
| **ALL** | **136** | **+0.0045** | [0.0009, 0.0098] | 0.0102 | **10 (9 up, 1 down)** |

This is the most informative result in the record, and it cuts both ways.

**For the mechanism:** the effect is confined *exactly* to the classes where tag edges can act. Every
single-hop, lexical, and temporal query is byte-identical to control - those queries never traverse the
graph far enough to reach a derived edge. A spurious effect would not respect that boundary. And 9 of
the 10 queries that moved improved.

**Against the result:** only 10 of 136 queries moved at all. A sign-flip permutation test on a vector
of 126 zeros and 10 non-zeros is, in effect, a **sign test on 10 observations** - and indeed
P(>=9 of 10 positive under H0) = 0.011, which is the p=0.0102 we measured. The effective n is 10, not
136. Neither multi-hop subgroup reaches significance on its own.

## 7. Multiplicity

Sixteen tests were run across this campaign (4 arms x 4 metrics). Benjamini-Hochberg at q=0.10 gives a
threshold of 0.10 x 1/16 = **0.00625** for the smallest p-value. Tag's p=0.0102 **does not clear it**.

Under the project's own pre-declared ship rule (BH-FDR at q=0.10, non-inferiority floor delta > -0.015),
the tag result is **suggestive, not established**.

## 8. Operational cost

Storage is free. Latency is not.

| | control | tag |
|---|---|---|
| index size | 289 MB | 294 MB (**+1.7%**) |
| edges | 11,033 | 19,410 (+76%) |
| 2-hop walk, 1 seed | 77 ms median | **189 ms** (2.4x) |
| 2-hop walk, 5 seeds | 135 ms median | **293 ms** (2.2x) |
| 2-hop walk, 10 seeds | 265 ms median | **481 ms** (1.8x) |

(Seeds drawn from the highest-degree notes, so the absolute figures are a worst case; the **ratio** is
the robust number.)

The cost is in the **walk**, not the storage: the tag index with `includeDerived=false` benchmarks at
86 ms - within noise of the 77 ms control. Densifying the graph is cheap; *traversing* the dense graph
is what costs, because a 76% larger edge set means a materially larger 2-hop frontier
(481 -> 632 nodes per walk at 1 seed).

## 9. Verdict

**Tag edges stay default-off.** They fail the ship gate on both arms of it:

1. The effect is **not established** - p=0.0102 fails BH-FDR at q=0.10, and rests on 10 moved queries.
2. Even taking the point estimate at face value, **+0.0045 nDCG for ~2x graph-walk latency is a bad
   trade.** The cost is certain and the benefit is not.

**kNN edges stay default-off** - inert at every similarity threshold tested, and they cost the same
walk latency for nothing. This one is a clean negative.

Nothing is deleted. Both mechanisms remain behind their flags, correct and tested, so a future re-test
is one config change away. The tag hypothesis is worth confirming properly, and the protocol for doing
that is frozen in [2026-07-14-tag-edges-preregistration.md](2026-07-14-tag-edges-preregistration.md).

## 10. Corrections to earlier claims made during this work

Recorded because the errors are the useful part:

- "Densification produces no significant change" - **wrong as stated.** True of the *combined* arm; the
  combined design was masking a mechanism-confined tag effect.
- "kNN edges are permanently rejected" - **overreach.** They are rejected *on this vault, at k=8,
  hopLimit=2, with this backbone*. That is a measurement, not a law.
- "Hub-degree suppression may be self-sabotaging the derived arms" - **refuted by the data.** Results
  were byte-identical with and without the fix, because `nodeDegrees` only runs when `smoothExpansion`
  or `graphStream` is on, and both default off. #256 fixed a real latent bug; it changed no number here.
