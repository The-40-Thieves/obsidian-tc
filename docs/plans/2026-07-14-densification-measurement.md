# Graph densification: measurement record and verdict

Status: **complete**. Date: 2026-07-14. Vault: the maintainer's personal vault (live snapshot, copied;
the live index was never mutated). Golden set: n=136, 5 query classes — private, not committed.

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
| `shared_tag` | frontmatter tag co-occurrence, hub tags excluded at `maxTagFanout=25` | `null` (a tag pair is not a similarity) |
| `similar_to` | vec0 kNN over existing chunk embeddings, `k=8` | cosine similarity |
| `semantically_similar_to` | LLM Pass-3 via the local gateway | model-assigned, snapped to a rubric |

The LLM layer is **not** in this experiment: it requires the local inference gateway, which cannot run
on this machine (open WSL2/Hyper-V kernel fault). Only the two zero-egress mechanisms were measured.

## 2. Arms

Five SQLite index copies, all derived from one snapshot of the live enriched index
(nomic-768, `chunkContext: true`) so the embeddings are byte-identical across arms. All arms carry the
`20260713_001` derived-edge columns, so schema is identical too - only edge rows differ.

| arm | total edges | composition |
|---|---|---|
| `ctl` | 11,033 | 10,828 `links_to` + 205 `unresolved` |
| `tag` | 19,410 | control + 8,377 `shared_tag` |
| `knn` | 16,787 | control + 5,754 `similar_to` (k=8, no floor) |
| `knn80` | 14,206 | control + 3,173 `similar_to` (confidence >= 0.80) |
| `knn80-strict` | 14,155 | control + 3,122 `similar_to` (confidence > 0.80) — the boundary check, see below |
| `trt` | 25,164 | control + both derived layers (the combined arm) |

Two notes on the control, because an earlier draft of this table was wrong on both:

- The `knn` arm was reported as "~22,800" edges. It is **16,787**. That number was estimated rather than
  queried, and it was simply incorrect; every count in this table is now read from the arm databases.
- The control is **not** "authored wikilinks only". It is 10,828 `links_to` plus **205 `unresolved`**
  rows (wikilinks pointing at notes that do not exist). Only `links_to` is traversed by the walk, so the
  `unresolved` rows are inert here — but the arm is not what the old caption said it was.

`knn80` and the single-mechanism arms were derived from `trt` **by deletion**, not by re-running kNN:
`confidence` on a `similar_to` edge *is* its cosine similarity, so a similarity floor is a `DELETE`.
This is why the ablation was cheap enough to run at all.

Two caveats on `knn80`, both real:

- **It approximates a `minSim=0.80` rebuild rather than reproducing one.** `confidence` is stored rounded
  to three decimals (`Math.round(sim * 1000) / 1000`), so `DELETE ... WHERE confidence < 0.8` retains an
  edge whose raw similarity was 0.7995. Measured: **51 of the 3,173 retained `similar_to` edges (1.6%)
  sit exactly at 0.800** and are therefore ambiguous.

  An earlier draft waved this away as "too few to flip a p=0.61 null." That is not an inference edge
  counts can support — one edge can move several queries. So it was **measured instead**: the
  `knn80-strict` arm deletes `confidence <= 0.800` (3,122 edges, i.e. every ambiguous edge resolved the
  OTHER way) and was evaluated end to end. Result, paired vs control: **dNDCG +0.001, 95% CI
  [-0.003, 0.004], p=0.6074** — identical to `knn80` to three decimals on every metric. Both sides of the
  rounding boundary give the same null, so the approximation is empirically immaterial *here*. A true
  rebuild remains the cleanest answer for any future kNN arm, and `knnMinSim` now exists to do it.
- **At the time it was measured, `minSim` was not a selectable configuration.** It existed only as an
  internal argument to `computeKnnEdges`; nothing threaded it from `config.retrieval.densify`. The arm
  therefore tested a hypothetical. That is now fixed — `retrieval.densify.knnMinSim` (default 0) exposes
  it, so the tested configuration is one an operator can actually select.

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

Separating the mechanisms is what surfaced the tag result at all: tested together, the combined arm is a
null (p=0.51); tag alone is the only arm whose CI excludes zero. The audit that demanded separable arms
was right, and this is the finding it produced.

**But "kNN dilutes tag" is NOT established, and an earlier draft of this document claimed it was.** That
claim rested on tag-vs-control being significant while combined-vs-control was not — which is the classic
error of reading a *difference between* two comparisons off their separate p-values. The direct paired
contrast settles it:

| combined vs **tag** (paired, n=136) | delta | 95% CI | p |
|---|---|---|---|
| dNDCG@10 | -0.002 | [-0.006, 0.000] | **0.3164** |
| drecall@10 | -0.005 | [-0.012, 0.000] | 0.5080 |
| dMRR@10 | +0.000 | [0.000, 0.000] | 1.0000 |
| dbridge | -0.007 | [-0.022, 0.000] | 1.0000 |

Adding kNN on top of tag does not significantly change anything. The point estimate leans negative, and
that is all that can be said. The matching -0.007 bridge figure across every kNN-bearing arm is likewise
**descriptive** — with p=1.00 there is no evidence of a population-level kNN bridge penalty.

**kNN showed no measurable benefit at the two similarity floors tested.** Not "inert at every threshold" —
that was also an overreach. What was actually tested: floors of **0 and 0.80**, at **k=8**, at
**derivedWeight=0.5**, on **one vault**, with **one backbone**. The promised `derivedWeight` sweep was not
run. The kNN confidence distribution (min 0.571 / mean 0.809) does mean the `minSim: 0` default is
empirically harmless here — a 0.5 floor would drop zero edges — but none of that licenses rejecting the
mechanism in general.

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

**For the mechanism:** the effect is confined *exactly* to the classes where tag edges plausibly act.
Every single-hop, lexical, and temporal query scores byte-identically to control, and 9 of the 10 queries
that moved improved.

Stated carefully, because an earlier draft overclaimed: identical metrics show the derived layer changed
**nothing observable** for those classes. They do NOT prove those queries "never traverse far enough to
reach a derived edge" — a derived node can be walked, and reranked, without altering the final top ten.
And class-concentrated noise is possible: chance does not distribute itself evenly across strata. The
class pattern is **mechanistically consistent** with a real effect and is the strongest thing in favor of
one. It is not proof against a spurious result.

**Against the result:** only 10 of 136 queries moved at all. A sign-flip permutation test over a vector
of 126 zeros and 10 non-zeros draws all of its evidence from those 10 — the **effective n is 10, not
136**. Neither multi-hop subgroup reaches significance on its own.

An earlier draft pushed that intuition too far and claimed the permutation p "is" the sign test:
P(>=9 of 10 positive) = 0.0107, which looked like a match for the measured 0.0102. That was wrong twice
over. The permutation test is **two-sided**, so the comparable sign-test probability is 0.0215, not
0.0107 — and the permutation test also uses the delta MAGNITUDES, not just their signs, so it is not a
sign test at all. The numerical near-agreement was a coincidence. "Effective n = 10" is a sound and
sobering description of where the evidence comes from; "this is a sign test" is not.

## 6b. Guardrails: non-inferiority, stated properly

An earlier draft said tag "costs nothing on the other metrics." Non-significance does not establish
absence of harm, and that phrasing was wrong. The claim that *is* supported comes from the CI bounds
against the project's standing non-inferiority margin, delta > -0.015:

| tag guardrail | delta | 95% CI | CI lower bound vs -0.015 |
|---|---|---|---|
| recall@10 | +0.005 | [0.000, 0.012] | 0.000 > -0.015 -> **passes** |
| MRR@10 | +0.004 | [0.000, 0.011] | 0.000 > -0.015 -> **passes** |
| bridge recall | 0.000 | [0.000, 0.000] | 0.000 > -0.015 -> **passes** |

Every guardrail's CI lower bound clears the margin, so **non-inferiority is established at delta=-0.015**.
That is a stronger and more defensible statement than "no significant regression," and it is the one the
ship rule actually asks for.

## 7. Multiplicity

The confirmatory family is the **16** arm-vs-control tests (4 arms x 4 metrics). Benjamini-Hochberg at
q=0.10 gives a threshold of 0.10 x 1/16 = **0.00625** for the smallest p-value. Tag's p=0.0102 **does not
clear it**.

Everything reported *after* that family was added in response to audit — the 4 combined-vs-tag contrasts
(section 5), the 5 per-class analyses (section 6), and the `knn80-strict` boundary arm (section 2). Those
are **exploratory diagnostics, not members of the confirmatory family**, and they are labelled as such
rather than folded in to inflate the denominator. The distinction does not rescue anything: enlarging the
family only lowers the BH threshold, so tag fails it a fortiori. But "16 tests across this campaign" is no
longer a literally accurate count of tests *run*, and the accounting should say which family the
correction applies to.

Under the project's own pre-declared ship rule (BH-FDR at q=0.10, non-inferiority floor delta > -0.015),
the tag result is **suggestive, not established**.

## 8. Operational cost

Storage is **inexpensive** (not free). Latency is not.

Two benchmarks, because they answer different questions and an earlier draft conflated them.

### The graph walk (the mechanism)

Seeds sampled **uniformly at random** from the **1,021** notes carrying at least one authored outgoing
link — *not* degree-ordered — with a fixed LCG seed, so the identical seed sequence is replayed against
both arms (paired). **30 measured walks** per arm per K after **5 discarded warmup walks**; `hopLimit: 2`.
Raw: [`bench-walk.json`](data/2026-07-14-densification/bench-walk.json).

| | control | tag | ratio |
|---|---|---|---|
| index size | 289 MB | 294 MB | **+1.7%** |
| edges | 11,033 | 19,410 | +76% |
| walk, K=1 (median / p95) | 61.5 / 75.3 ms | 160.2 / 184.6 ms | **2.60x** |
| walk, K=5 (median / p95) | 81.7 / 151.4 ms | 224.4 / 345.1 ms | **2.75x** |
| walk, K=10 (median / p95) | 107.8 / 167.2 ms | 294.3 / 347.4 ms | **2.73x** |

### The serving path (what a user actually pays)

`graphSearch()` itself — **not** the eval loop. This distinction cost a wrong number: the first pass
reported "347 -> 461 ms/query (+33%)" as end-to-end user-visible latency, but that was the wall clock of
`eval/run.ts`, which runs a **semantic baseline search AND a graph search per query** in order to compare
them. Production runs only the graph search. That figure measured a harness.

Measured properly — 136 golden queries x 3 reps per arm, arms **alternating** per query so cache warmth
cannot favor one, 5 warmup queries discarded, query embedding timed **separately** because it is
arm-independent and folding it into a ratio would silently dilute the result. Raw:
[`bench-serve.json`](data/2026-07-14-densification/bench-serve.json).

| | control | tag | delta |
|---|---|---|---|
| `graphSearch` (median / p95) | 466.5 / 655.4 ms | 688.4 / 947.3 ms | **1.48x** |
| query embedding (median) | 33.6 ms | 33.6 ms | identical (arm-independent) |
| **user-visible (embed + search)** | **500 ms** | **722 ms** | **+222 ms, +44%** |

The corrected number is **worse than the one I got wrong**: +44%, not +33%. Note the walk ratio (2.7x) and
the serving ratio (1.48x) are both real — `graphSearch` does more than walk (dense retrieval, RRF fusion,
scoring), so the walk's 2.7x is diluted into 1.48x by the time it reaches the caller. The 2.7x is the
mechanism's cost; the **+44% is the bill**.

A further correction to the first pass: it seeded from the **highest-degree** notes and called that a
"worst case" whose ratio was therefore conservative. Wrong in direction — uniform-random seeds give a
**larger** ratio (2.6-2.75x) than hub seeds did (1.8-2.4x), because a hub's 2-hop frontier is already
enormous in the control arm, so derived edges add proportionally less.

Storage is **inexpensive, not free**. The cost is in the **walk**, not the bytes: the tag index with
`includeDerived=false` benchmarks within noise of control. Densifying is cheap; *traversing* the dense
graph is what costs, because a 76% larger edge set means a materially larger 2-hop frontier (at K=1:
122 -> 258 nodes per walk).

## 9. Verdict

**Tag edges stay default-off.** They fail the ship gate on both arms of it:

1. The effect is **not established** - p=0.0102 fails BH-FDR at q=0.10, and rests on 10 moved queries.
2. Even taking the point estimate at face value, **+0.0045 nDCG for ~2x graph-walk latency is a bad
   trade.** The cost is certain and the benefit is not.

**kNN edges stay default-off** - no measurable benefit at either floor tested, and they cost the same walk
latency for nothing. But this is a *scoped* negative, not a dead mechanism: two floors, one k, one
`derivedWeight`, one vault, one backbone. Re-opening it means a real sweep (k, floor, weight), and that
would need its own pre-registration.

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
- "The combined arm **masked** the tag signal" / "kNN dilutes tag" - **not established.** Inferred from
  one comparison being significant and the other not, which does not license a claim about the
  difference between them. The direct paired combined-vs-tag contrast is p=0.32 (section 5).
- "kNN is inert at **every** threshold" - **overreach.** Two floors were tested, at one k, one weight,
  one vault, one backbone. The `derivedWeight` sweep was never run.
- "Tag costs nothing on the other metrics" - **replaced.** Non-significance is not equivalence; the
  supported claim is the non-inferiority result in section 6b, which rests on CI bounds, not p-values.
- The `knn80` arm was described as equivalent to a `minSim=0.80` rebuild. It is an **approximation** to
  within 51 boundary edges, because stored confidence is rounded to three decimals. Resolving those 51
  edges the other way (`knn80-strict`) was then measured, and changes nothing (section 2).
- The `knn` arm's edge count was reported as "~22,800". It is **16,787** — estimated instead of queried.
  The control was described as `links_to` only; it also carries 205 `unresolved` rows (section 2).
- `shared_tag` confidence was documented as 1.0. The implementation stores `null` (section 1).
- "P(>=9 of 10) = 0.011, which is the p we measured" - **wrong.** The permutation test is two-sided (the
  comparable sign probability is 0.0215) and uses magnitudes, not just signs. It is not a sign test; the
  numerical agreement was coincidence. "Effective n = 10" survives; "this is a sign test" does not.
- "Those queries never traverse far enough to reach a derived edge" - **not shown.** Identical metrics
  prove no observable change, not absence of traversal (section 6).
- The latency benchmark reported no protocol, no dispersion, and no end-to-end figure, and wrongly framed
  hub seeds as a conservative worst case. Re-run properly; the true ratio is **larger** (section 8).
- "**347 -> 461 ms/query (+33%) end-to-end**" - **that was the EVAL LOOP, not the serving path.**
  `eval/run.ts` runs a semantic baseline search *and* a graph search per query, to compare them;
  production runs only the graph search. The figure measured a harness. `graphSearch` itself was then
  benchmarked (alternating arms, 3 reps, embedding timed separately): the real user-visible cost is
  **+222 ms, +44%** — worse than the number I got wrong (section 8).
- The walk benchmark's seed frame was described as "3,000-odd notes". It is **1,021** — the artifact said
  so (`seedFrameSize`) and the prose did not match it.
