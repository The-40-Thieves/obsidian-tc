# Evaluation methodology

obsidian-tc publishes **no headline benchmark score**, and that is a deliberate position rather than
an absence. This document explains what is measured instead, how, and what that does and does not
let you conclude.

It does now publish **one reproducible retrieval result on a public corpus** — see
[Published on a public corpus](#published-on-a-public-corpus-2026-08-07). The distinction matters:
that number lives here, beside its own caveats, power analysis and the label scheme it depends on.
It is not on the README. A figure quoted where its qualifications are not is the exact thing this
project withdrew a set of headline numbers for on 2026-08-07, and re-creating that shape somewhere
more prominent would undo the lesson rather than apply it.

Operator instructions — how to actually run the harness — live in
[`packages/server/eval/README.md`](../packages/server/eval/README.md). This document is the *why*.

---

## What is measured

Every retrieval change is evaluated as a **paired** comparison: configuration B minus configuration
A, on the same queries, in the same run. Reported per arm:

`recall@10` · `nDCG@10` · `MRR@10` · bridge recall (multi-hop) · a hard-subset slice

Paired deltas, not two independent means. Query difficulty varies enormously across a vault, and an
unpaired comparison mostly measures which queries landed in which sample.

## The statistics

Implemented in [`packages/server/eval/stats.ts`](../packages/server/eval/stats.ts) — no
imports at all, 236 lines, readable in one sitting. You can audit the method without our data.

| test | what it answers | parameters |
| --- | --- | --- |
| Sign-flip permutation test | is the mean delta distinguishable from zero? | two-sided, 10,000 resamples |
| Percentile bootstrap CI | how large is the effect? | 95% CI of the mean delta |
| Power report | what could this corpus have detected? | α = 0.05, power = 0.8 |
| Paired non-inferiority | is a change safe to ship? | default margin **−0.015** |
| Benjamini–Hochberg | many arms in one sweep | default **q = 0.1** |

**Why a permutation test rather than a t-test.** nDCG deltas are bounded, skewed, and n is small.
A t-test assumes none of that. A Wilcoxon test would answer a question about the median when the
decision is about the mean. The permutation test makes no distributional assumption and is the
correct default; the module comment says so and the code shows it.

All resampling runs through a seeded PRNG (mulberry32), so a given artifact reproduces exactly
run-to-run. A number that moves when you re-run it is a bug, not noise.

## The ship rule

A mechanism ships **on** only if it clears the gate. A mechanism that fails it is not deleted — it
ships **dark** behind a config flag, with its measured numbers recorded next to it.

The floor is a **non-inferiority margin of −0.015 nDCG@10**. "Not significantly worse" is not the
bar; the change must be demonstrably not-worse by more than that margin.

**The power analysis is reported alongside every run, and it is the honest part.** A null result
from an underpowered corpus is "we could not detect an effect this small," never "there is no
effect." The harness prints the minimum detectable effect for the corpus as it stood at run time,
so a null can be read correctly:

```
power ΔnDCG@10 : σ_d 0.155  SE 0.0133  MDE@n=136 0.037 (α=0.05, power=0.8)
                 Δ=0.05→n≥76   Δ=0.03→n≥210   Δ=0.02→n≥472
```

That measurement was taken at n=136. <!-- facts-check:ignore: historical power measurement taken at the golden set's then-size, deliberately preserved alongside the current n=250 -->
The golden set is now **n=250**, and the spread has been
re-measured twice since: first at σ_d 0.204 / MDE 0.036 on the same nomic representation, then —
after that representation was deleted on 2026-07-31 — at **σ_d 0.198 / MDE 0.035 on `ndcg_at_10`**
against the live BAAI/bge-m3 store (THE-674, 2026-08-02, at `be4962d`). Every step was *worse*
resolution than the figure before it, not better. All three are kept rather than quietly replaced.

**The current bar is metric-specific, and the spread across metrics is 2.5×.** 0.035 is the
`ndcg_at_10` row. `recall_at_10` resolves at 0.026 and `bridge_recall` at 0.022, while `mrr_at_10`
needs 0.055 — and `bridge_ndcg_at_10`, which is scored only on the labelled subset rather than the
full set, needs 0.062. <!-- facts-check:ignore: per-metric resolution figures from THE-674, not corpus counts -->
Quoting the headline for a bridge-gated experiment overstates the resolution by nearly 2×. The full
per-metric table lives in `packages/server/eval/README.md`.

## Withdrawn: the headline retrieval figures (2026-08-07)

The README and `SKILLS.md` used to quote `graph nDCG@10 0.786 / recall@10 0.871 / bridge recall
0.831` as the live champion. **Those figures are withdrawn.** Two independent reasons, both
checkable:

**They are unreproducible.** They entered the README on 2026-07-11, which predates the oldest
eval artifact still on the eval host. The closest surviving n=136 artifact gives 0.7897 / 0.8736 /
0.8309 — only bridge recall matches. Their provenance cannot be recovered, so they cannot be
defended, corrected, or re-derived.

**And the harness that would re-derive them had a defect.** `--path-dedup` collapsed the graph arm
to one hit per note *and*, to fill that quota, widened only that arm's retrieval depth from 30 to
60 (`FANOUT_OVERFETCH_K`). The semantic baseline stayed at 30 and was never deduped. The flag was
written for the fan-out A/B — which compares two **graph** arms and is unaffected, so every
published fan-out and `maxPerCluster` result stands — but the same run also printed a
graph-vs-baseline delta, and that delta was reading a 60-deep arm against a 30-deep one.

That is now fixed: the same depth and the same collapse apply to every arm, and each artifact
records `armDepth` so this is checkable rather than inferred from a flag name.

### The trap that delayed the replacement, and the correction it needed

The obvious move was to re-derive the figures against a bge-m3 index already on the eval host. That
produced a number that looked like a finding and was not, and the diagnosis took two wrong turns
worth recording.

**What actually happens.** A cache built before `chunk_fts` became contentless (THE-711) has FTS
rowids that are *independent* of `chunks.rowid`. Current code joins on that identity, so the join
does not fail — it **pairs BM25 hits to the wrong chunks**. Measured on a real pre-THE-711 cache:
8,933 of 13,451 rows "joined", all mis-paired, and 4,897 dropped.

**Why it reads as a retrieval result.** The pure-dense arm never touches FTS, so it reproduces
byte-identically while the RRF-fused arm collapses. On the same 250 queries:

```
                baseline stale -> fresh     graph stale -> fresh
ndcg_at_10        0.7484 -> 0.7471            0.6387 -> 0.7695
bridge_recall     0.7360 -> 0.7360            0.6840 -> 0.8080

baseline moved -0.0013      graph moved +0.1308      ratio 97.5x
```

**A one-sided shift with the other arm frozen is the signature of a stale index, not a retrieval
result.** Perfect reproducibility on one arm is not evidence the harness is valid — it can mean that
arm simply does not read what broke.

Two corrections, since the first diagnoses were wrong and are quotable from this project's own
history. It is **not** a migration-count problem: a freshly built `cache.db` legitimately applies 24
migrations while the manifest holds 42 across multiple stores, so comparing those counts is
meaningless, and the real gap was three. And it is **not** `acl_path_sets`, which is inert on this
path. It is the FTS shape, specifically.

The read path now **refuses** a pre-THE-711 `chunk_fts` rather than mis-joining it (THE-750), so
this failure mode is loud from here on. Still: never reuse an eval cache across a
retrieval-touching schema change. "Same embeddings" is not "same index", and
`vec_index_fingerprint` records the embedding provider and dimensionality but **no schema version**,
so it cannot tell you an index is current.

## Published on a public corpus (2026-08-07)

The figures withdrawn above were unreproducible by anyone outside this project. These are not: the
corpus is public, the judgments are third-party and MIT-licensed, and the harness is in this repo.

**Corpus.** Andy Matuschak's [evergreen notes](https://notes.andymatuschak.org/), crawled with the
preparation script published by [`flowing-abyss/obsidian-hybrid-search`](https://github.com/flowing-abyss/obsidian-hybrid-search)
— **1,357 notes, 5,671 wikilinks**, indexed to 2,986 chunks and 8,335 edges on a fresh
`BAAI/bge-m3` index. Their **78 hand-judged queries** are the relevance labels; all 72 distinct
target paths resolve in the index. Nothing is redistributed here: that repo ships the *judgments*,
and the corpus is fetched from its source.

**Two binarizations, because theirs are graded and ours are binary.** Their labels distinguish
`relevant` from `partial`; `computeQueryMetrics` scores a flat expected-path set. Collapsing that
distinction one way or the other is a *choice*, and partials nearly triple the label set (92 → 243
target paths) — so both are reported and the truth is bracketed by the pair.

| n=78, `BAAI/bge-m3`, no flags, both arms at depth 30 | baseline | graph | Δ | 95% CI | perm p |
| --- | --- | --- | --- | --- | --- |
| **strict** nDCG@10 (relevant only) | 0.869 | **0.914** | +0.045 | [0.000, 0.092] | 0.0540 |
| **strict** recall@10 | 0.942 | **0.979** | +0.036 | [0.004, 0.079] | 0.1230 |
| **lenient** nDCG@10 (partials count) | 0.628 | **0.689** | +0.061 | [0.031, 0.092] | **0.0002** |
| **lenient** recall@10 | 0.631 | **0.696** | +0.065 | [0.025, 0.111] | 0.0022 |

Both clear the −0.015 non-inferiority floor. **Read the strict arm as underpowered rather than
null:** its MDE at n=78 is **0.065** and the observed effect is 0.045, so p=0.054 means "below this
corpus's resolution", not "no effect". The lenient contrast is quieter (σ_d 0.135 vs 0.206,
MDE 0.043) and clears comfortably. Both point the same way at a similar magnitude.

**This is not comparable to the peer's published 0.753**, and the temptation to line them up should
be resisted: different embedder (they ran `Xenova/multilingual-e5-small`; this is `bge-m3` at
1024d), different binarization, different harness boundary. Worth one observation only — their
graded 0.753 falls *between* our lenient 0.689 and strict 0.914, which is the ordering a graded
metric bracketed by two binarizations should produce. A sanity signal, not a comparison. Running
their corpus through *their* harness would be the comparable experiment, and has not been done.

**Where the effect sits is suggestive only.** Per-category deltas put it in `quote-fragment`
(+0.21), `disambiguation` (+0.20) and `linked-neighborhood` (+0.12) — but those buckets are n=3–23,
carry no BH correction across 8 comparisons, and mostly sit under the whole-corpus MDE. The
`linked-neighborhood` slice is the one that would actually speak to whether graph expansion earns
its keep, and at n=6 it is directionally supportive and statistically nothing.

**`bridge_recall` reads 0.000 → 0.000 and that is an absence of labels, not a result.** This corpus
declares no multi-hop bridges, so the field is empty by construction and the multi-hop ship gate is
inapplicable to it.

### Corroboration on the private set

The same comparison on the private n=250 golden set, fresh index, current code: graph beats the
semantic baseline by **+0.022 nDCG@10** (95% CI [0.002, 0.044], permutation p=0.0336) and
**+0.027 recall@10** (p=0.0311), both non-inferior, with bridge recall 0.736 → 0.808. That number is
**not** independently reproducible — it is the internal benchmark, on the private corpus this
document has already explained the limits of — and it is recorded here as corroboration rather than
as a headline. Note it also sits below its own MDE (0.030), so it is significant at less than 80%
power.

Two corpora, two label schemes, same direction.

## Permission-aware retrieval on the same public corpus (2026-08-08)

The third criterion above — a corpus that is *permission-aware* — had nothing behind it, and no
public one exists. Rather than wait for one, the axis was **constructed** on top of the corpus
already in use. The result is, as far as a literature sweep could find, the **first permission-aware
document-retrieval benchmark**: existing permission benchmarks
([RBAC text-to-SQL](https://arxiv.org/html/2607.22115v1),
[Role-Conditioned Refusals](https://arxiv.org/pdf/2510.07642), MultiPER-Enterprise) all measure SQL
generation or LLM refusal reasoning, not retrieval under access control.

**Why it is cheap here and was not for the work it borrows from.** The RBAC text-to-SQL corpus needed
GPT-4 plus a four-expert panel to derive per-role ground truth, because SQL column permissions are
semantic. Folder ACLs are not. `readableRel(acl, rel)` is a pure function of an ACL and a path, so
for principal *P* with ACL *A*:

```
expected_P  =  expected  INTERSECT  { p : readableRel(A, p) }
```

Ground truth is **computed, not judged** — the 78 third-party judgments become per-principal
judgments by intersection, and a reader can verify that intersection without running anything.

**The overlay** (`eval/acl-overlay.json`) defines four principals over alphabetical title ranges,
deliberately **overlapping** at the seams — the one design choice copied directly from the RBAC
paper, because disjoint roles make any out-of-whitelist path trivially detectable and the leakage
test vacuous. 41 of 78 strict queries are scoreable for more than one principal.

**Leakage — the primary metric, and a correctness gate rather than a quality one:**

| binarization | principal | n | unreadable paths returned |
| --- | --- | --- | --- |
| strict | P1 `a-f` | 40 | **0** |
| strict | P2 `d-l` | 36 | **0** |
| strict | P3 `k-s` | 26 | **0** |
| lenient | P1 | 56 | **0** |
| lenient | P2 | 48 | **0** |
| lenient | P3 | 46 | **0** |

**252 principal-query evaluations, zero leaks.** Leakage has an expected value of exactly 0, so *n*
does not bound its conclusiveness — one leaked path on a 26-query arm is as much a finding as one on
a 1000-query arm, and there is no "not significant" reading of a leak.

The ACL is built through the same `FolderAcl` + `makeIndexReadable` factory the boot reconcile,
`add_vault` and the index-on-write hook use, and the leakage check consumes **the search's own
`isReadable`** rather than rebuilding one — a zero from a predicate that is not the shipped one
would be evidence about nothing.

`leaked_paths` is `null` when no ACL is in force, never `0`: "not checked" and "checked, none" are
different claims, and conflating them would print PASS for an arm where the boundary was never
evaluated. Five tests pin every state including a **failing** one, because a gate that has only
reported PASS is indistinguishable from one wired to a constant — the defect THE-699 found in this
very harness.

**A fourth principal was refused, and that is the harness working.** `P4` (`r-z` plus digits) leaves
only 21 of 78 queries with a reachable target, below `run.ts`'s n≥26 floor: *"the whitelist is too
narrow to measure anything — widen it, or the report measures the ACL rather than the retrieval."*
One query of 78 is readable by no principal at all and is excluded rather than scored zero.

**The honest caveat, which must travel with any citation of this.** A self-authored ACL overlay is a
self-authored benchmark, and this document has already called that the weakest form of evidence. It
is defensible here only because the *overlay* is arbitrary while the *ground truth derived from it*
is not: the intersection is mechanical, committed, and independently checkable. Say both halves.

### Under-fill: the secondary metric (2026-08-10)

Leakage above is a correctness gate. **Under-fill** is the quality half — recall lost against each
principal's *own* achievable ceiling — and it is the number the `acl_path_sets` work (THE-694/695)
exists to protect, because the over-fetch window means a heavily-restricted principal can lose
recall for reasons unrelated to ranking.

**The ceiling really is 1.0, and that was checked rather than assumed.** Under-fill is only
`1 − recall@10` if every query's visible target set fits inside the 10 slots. Measured across all
eight arms: the largest `expected_P` is **6** (lenient P4) and **zero queries** in any arm exceed 10
targets. So no part of the number below is arithmetic rather than retrieval.

| binarization | principal | *n* | recall@10 | under-fill | vs unrestricted |
| --- | --- | --- | --- | --- | --- |
| strict | P1 `a-f` | 40 | 1.000 | **0.000** | −0.021 better |
| strict | P2 `d-l` | 36 | 1.000 | **0.000** | −0.021 better |
| strict | P3 `k-s` | 26 | 0.981 | 0.019 | −0.002 better |
| lenient | P1 `a-f` | 56 | 0.842 | 0.158 | −0.146 better |
| lenient | P2 `d-l` | 48 | 0.792 | 0.208 | −0.096 better |
| lenient | P3 `k-s` | 46 | 0.760 | 0.240 | −0.064 better |
| lenient | P4 `r-9` | 35 | 0.651 | 0.349 | **+0.045 worse** |

"vs unrestricted" compares each principal's under-fill to the same figure on the unrestricted run
published above — strict 0.021, lenient 0.304.

**The headline: over-refusal does not materialise at most ACL widths.** Six of seven principals
under-fill *less* than the unrestricted baseline. That is not a surprise once stated — a restricted
principal has fewer targets to find in the same 10 slots — but it is the opposite of the failure the
over-fetch window was feared to cause, and it had not been measured.

**The signal worth keeping is the trend, not any single row.** Under-fill rises monotonically as the
whitelist narrows — lenient P1 −0.146, P2 −0.096, P3 −0.064, P4 **+0.045** — crossing the
unrestricted baseline exactly at the narrowest principal that can be scored at all. So over-refusal
is real, it is a function of how restrictive the ACL is, and on this corpus it becomes visible only
at the boundary where the harness is already close to refusing the arm.

**A fourth principal became measurable, and one arm is still refused.** P4 lenient clears the n≥26
floor at 35 and is reported above; P4 strict leaves only 21 of 78 and is still refused, with the
harness's own message: *"the whitelist is too narrow to measure anything — widen it, or the report
measures the ACL rather than the retrieval."* That refusal is the gate working. Including P4 lenient
takes the run to **287 principal-query evaluations, still zero leaks**.

**Three caveats that must travel with these numbers.**

1. **The comparison to unrestricted is UNPAIRED.** Each principal scores a different subset of
   queries (only those with ≥1 reachable target) against a different target set. It is a directional
   comparison, not a significance test, and no *p* is claimed for it.
2. ***n* is 26–56 per principal and is NOT pooled.** Pooling would be wrong twice over: the
   principals overlap by construction (41 of 78 strict queries are scoreable for more than one), so
   the arms are not independent, and each principal's ceiling is a different quantity.
3. **The self-authored-overlay caveat above applies here unchanged.** The overlay is arbitrary; the
   ground truth derived from it is not.

## Published negative results

The gate is only credible if it has refused things. Three mechanisms were built, measured, and left
off by their own numbers.

### Multi-query fan-out (RRF over query variants)

Measured 2026-07-26 on the n=250 set. Fan-out over three generated phrasings per query vs
single-query, both arms path-deduped, identical code, paired:

| metric | Δ mean | p | verdict |
| --- | --- | --- | --- |
| nDCG@10 | **−0.047** | 0.0004 | significant; fails the −0.015 floor |
| MRR@10 | **−0.063** | 0.0011 | significant; fails the floor |
| recall@10 | −0.002 | 0.82 | not significant — ties on 228/250 |

**The fan-out returns the same documents in a worse order.** Sliced: multi-hop queries (n=103) are
near-neutral at −0.0085; single-hop (n=147) lose −0.0746. The design predicted gains concentrating
on compound queries. The concentration was real; the gain was not.

It remains opt-in and off by default, and a test asserts the built-in research prompt does not tell
an agent to use it.

### Cluster-diversity cap (`maxPerCluster`)

Measured negative at every *k* tested. Clustering still runs; the live store is deliberately left
unclustered for ranking purposes. Kept dark.

### Deterministic edge densification (`retrieval.densify`) — both types, flat on coverage

Measured 2026-08-08 on the n=250 multi-hop set (103 bridge-bearing queries, MDE 0.0223 on
`bridge_recall`). `retrieval.densify` builds derived edges without any LLM: `knnEdges` from vec0
neighbours over the embeddings that already exist, `tagEdges` from shared-frontmatter-tag
co-occurrence. Both had shipped, both were dark, and **neither had ever been measured for retrieval
quality** — only for latency.

Each arm walks the same index as its own control; only `includeInWalk` differs, so the contrast is a
pure search-side toggle with identical chunks, vectors and literal edges on both sides.

| arm | derived edges | build | Δ bridge_recall | p | ΔnDCG@10 |
| --- | --- | --- | --- | --- | --- |
| `knnEdges` floor 0.0 | 6,777 | 250 s | −0.008 | 0.73 | −0.002, non-inferior |
| `knnEdges` floor 0.6 | 6,683 | 255 s | −0.008 | 0.73 | −0.002, non-inferior |
| `knnEdges` floor 0.8 | 1,549 | 249 s | +0.000 | 1.00 | −0.002, non-inferior |
| `tagEdges` fanout 25 | 9,260 | **6.5 s** | +0.000 | 1.00 | −0.002, non-inferior |

**Nothing significant on any metric, at any density, for either edge type.** Up to +74% connectivity
over the 12,567 literal edges moved coverage by less than a third of the detectable threshold. The
nDCG null is a strong one rather than an underpowered shrug: σ_d 0.046 puts the contrast-specific
MDE at **0.008**, so the study could have seen a 0.008 shift and measured 0.002.

The treatment was not inert — it reordered 30 of 250 queries and changed 8 queries' bridge outcomes,
which cancelled to exactly zero. And the instrument was live: 202 of 250 queries carry a non-zero
`bridge_recall` on this corpus, unlike the public evergreen set, which declares no bridges at all and
where this metric is structurally unmeasurable.

**Why it is a coherent null rather than a disappointment.** Both cheap edge types connect notes that
are already mutually findable — kNN edges mirror the similarity the dense retriever has already
exploited before the graph walk starts, and shared tags connect notes a human already filed
together. Neither expresses a relation that is absent from both the embedding and the tag
vocabulary, which is what the unreachable-target queries actually need. So "connectivity is the
ceiling" is true of the *kind* of edge, not the *count*.

Two knobs are worth recording from the sweep even though the headline is flat:

- `knnMinSim: 0.6` is **nearly inert** for `bge-m3` — only 1.4% of top-8 neighbours fall below it
  (75.8% sit between 0.6 and 0.8, 22.9% above 0.8). Floors 0.0 and 0.6 produced byte-identical
  result files. A meaningful sweep uses 0.7/0.75.
- On the public evergreen corpus, `knnEdges` at floor 0.0 **fails** the −0.015 non-inferiority floor
  on strict labels (Δ −0.009, lower bound −0.026). The shipped default of `knnMinSim: 0` keeps every
  neighbour the kNN returns, and on that corpus it costs precision at rank 10.

All four arms stay off by default. `eval/densify-index.ts` (kNN) and `eval/densify-tags-index.ts`
(tags) rebuild each edge set on an existing index without a reindex, so re-running this costs
minutes rather than the 48+ a full `indexVault` reconcile per cell would.

## Why the corpus is private, and what that costs

The golden set is built from a personal Obsidian vault. It cannot be published, and a redacted
version would no longer be the thing that was measured.

Stated plainly, this means: **you cannot reproduce our numbers.** You can audit the method, the
statistics, the ship rule, and the negative results. You cannot re-run the comparison.

Everything derived from the private set is gitignored (`eval/runs.db`, exports). Curated figures
that reach the docs go through a single reviewed file,
[`docs/project-facts.json`](./project-facts.json), with a CI drift gate — never scraped from a run
automatically, because a number that updates itself is a number nobody checked.

### Run `sync-facts --check` on the eval host after any golden-set change

`goldenSetSize` in `project-facts.json` is a claim about a file CI cannot see. The check that
verifies it therefore cannot live in CI, and this is the step that replaces it:

```bash
# on the machine that holds the golden set
bun scripts/docgen/sync-facts.ts --check --golden <path>/multi-hop-golden-set.yaml
```

Exit **0** means the recorded figure matches the set. Exit **1** means it has drifted — re-run
without `--check` to update, and commit the result as a reviewed change.

**Do not wire this into CI.** Without `--golden` it exits **2** — "golden set not found" — because
the set is private and gitignored, so a CI job could only ever fail for the wrong reason. Tolerating
that exit to make the job green would produce a gate that can neither pass nor fail, which is worse
than no gate: it is the shape this whole document exists to argue against. The exit codes are doing
their job; the missing piece was a human running the command, which is what this section is.

Verified 2026-08-06: exit 2 with no `--golden`, exit 0 against the real set, `goldenSetSize` 250
and current. Note the figure the set *sizes* — the nDCG/recall numbers derived from it — has no
equivalent automated check; `sync-facts` deliberately refuses to scrape it, for the reason in the
paragraph above.

## Generalization

Everything above establishes that a result is *real for this vault*: reproducible in the sense that
re-running it against the same private set gives the same number, audited by a permutation test with
no hidden assumptions, and honest about the effect size it could and could not have detected. None of
that establishes that a result is *real for vaults in general*. Those are different claims, and this
project shipped defaults for two years as though the first implied the second.

It does not, and this is not a project-specific worry — it is the documented failure mode of
single-collection retrieval evaluation. BEIR's whole contribution was showing retrievers reorder
across corpora with no universal winner; Armstrong et al. (CIKM 2009) found ad-hoc "improvements"
published against one TREC collection routinely lost to a strong baseline once compared honestly
elsewhere; Fuhr (SIGIR Forum 2017) named the gap directly — a significance test answers whether an
effect is real on *this* sample, never whether it generalizes. A win on the ~1,150-note private vault
behind this document's numbers is exactly that kind of single-collection result.

**What the golden-set evidence in this document does and does not establish**, stated as plainly as
the rest of it:

- It establishes that a mechanism is not-worse than its alternative *on this vault's shape* — one
  language, one size regime, one link-density and doc-length profile — within the stated
  non-inferiority margin and power.
- It does not establish that the mechanism is not-worse on a vault of a different shape: a different
  language, an order-of-magnitude different note count, code-heavy or reference-heavy documents,
  sparser or denser linking. Every published negative result above is itself a demonstration that
  shape moves the answer — `knnEdges` at floor 0.0 ties on the private vault and fails
  non-inferiority on the public evergreen corpus in the same sweep.

**The taxonomy this implies, and the promotion bar it sets**, is recorded as
[ADR 0007](./adr/0007-default-promotion-requires-multi-shape-evidence.md) rather than repeated in
full here: corpus-insensitive constants (a flat-optimum value like RRF's folklore k=60) may default
on from single-vault evidence; vault-fact-conditional settings (language, size, doc-length variance,
link density) should eventually derive from measured index statistics instead of a fixed constant —
named there as future work, not built; everything else — judgment-dependent mechanisms, which is most
of what this document's ship rule gates — defaults off until it wins-or-ties on a majority of a
multi-shape suite of three-plus corpora, with no catastrophic loss on any. A single-vault win still
means something under that bar: it labels the mechanism "validated on: personal-notes shape" and
qualifies it for an opt-in preset. It does not, on its own, promote a project-wide default.

No default changes as a result of this section. What changes is that every default this document
currently reports as a golden-set win is now also on record as evidence *for one vault shape*, not
evidence that the field's own literature says a single vault can give.

## Why there is no headline benchmark number

Not for lack of a benchmark to run. Because the available ones measure something else, and because
the field's published numbers do not currently mean what they appear to mean.

**The public memory benchmarks are conversational, not documentary.** LoCoMo (1,540 questions over
multi-session dialogues), LongMemEval (500 questions), BEAM, and DMR all evaluate recall over
*conversation histories*. obsidian-tc retrieves over a **wiki-linked markdown vault** where graph
expansion, folder ACLs and multi-vault scoping are load-bearing stages. Flattening a dialogue
corpus into notes produces no link graph, so several stages contribute nothing — the score would
measure a deliberately crippled configuration.

The document-retrieval analogues (BEIR, Natural Questions, HotpotQA) have the opposite problem.
BEIR reports exactly the metrics used here — nDCG@10, MAP, Recall, Precision, MRR against
`qrels` — but its corpora are flat document sets with **no link structure and no access control**,
which are two of the three things that distinguish this engine. A BEIR number would be comparable
and would measure the least distinctive part of the system.

**And the field's numbers are largely unverified vendor claims.** Independent testing published by
[Bench'd](https://benchd.ai/benchmarks) (May 2026) found:

| system | LongMemEval | LoCoMo |
| --- | --- | --- |
| LlamaIndex | 59.0% | 54.8% |
| LangChain | 59.0% | 51.9% |
| **LLM baseline (no memory system)** | **57.6%** | **50.4%** |
| Mem0 OSS | 32.4% | 0.0% |
| Mem0 managed *(self-reported, not independently verified)* | 93.4% | 68.5% |

Two things follow, and the second is the important one.

First, a vendor's self-reported score and an independent measurement of their open-source package
differ by ~61 points on the same benchmark. Those are different products.

Second — **most dedicated memory systems scored at or below a plain LLM with the full conversation
in its context window.** A memory layer can, and frequently does, perform worse than no memory
layer at all, because compression and summarisation destroy information faster than they organise
it.

### And the LoCoMo column above is scored against a key with known errors

Every LoCoMo figure in that table — ours included, had we published one — predates an audit that
found the benchmark's own answer key is wrong on a material fraction of questions.

The [Penfield Labs LoCoMo audit](https://github.com/dial481/locomo-audit) (April 2026) examined all
**1,540** non-adversarial questions and found **156 issues**: **99 that corrupt scoring (6.4% of
questions)** plus 57 that are citation-metadata errors only. The score-corrupting ones break down as
hallucinated facts (33), temporal miscalculations (26), speaker-attribution errors (24), ambiguous
answers (13) and incomplete answers (3).

**The error rate is highest exactly where a graph retriever would be judged:** 9.9% on the multi-hop
category and 9.4% on open-domain, against 4.3% on single-hop factual.

The audit's own conclusion is the number worth carrying:

> The theoretical maximum score for a perfectly correct system is ~93.6%

Set that beside the table. A vendor's self-reported LoCoMo figure of 92.5% sits **1.1 points under
the benchmark's ceiling** — a claim that should be read with the ceiling in hand rather than at face
value.

**What this does and does not invalidate.** A wrong answer key penalises every system roughly
equally, so the *relative* ordering above — and therefore the argument this section makes — survives
it. What does not survive is any *absolute* LoCoMo number, from anyone, scored before April 2026 and
not stated as corrected. The competitor harness at
[`basic-memory-benchmarks`](https://github.com/basicmachines-co/basic-memory-benchmarks) now ships
the corrections and requires runs to declare which key they used; that is the right posture and this
project would adopt it before quoting a LoCoMo number of its own.

### One more reason a conversational benchmark cannot grade this engine

The same competitor harness publishes a `baseline-grep` arm — literally grep — and it reaches
**recall@10 0.937** on LongMemEval-60 and **1.000** on their 274-question ConvoMem set, in 1–5 ms.
Their own failure analysis puts the retrieval ceiling at 0.983–1.000 and attributes **96–100% of
end-to-end failures to the answerer rather than to retrieval**.

On the corpora this field competes over, retrieval is close to saturated: the scoreboard is grading
the reader, not the retriever. That is the sharpest available argument for measuring this engine on
a **linked, permissioned** corpus instead — not because those numbers would be flattering, but
because a benchmark grep can max out cannot distinguish any two retrievers, including ours from a
bad one.

### The consequence for anyone building this

**A memory benchmark without a no-memory control arm is uninterpretable.** Absent that baseline you
cannot distinguish "our memory system is good" from "our memory system is worse than passing the
raw text through," and the table above shows that is not a hypothetical failure mode. Any future
benchmark work here will report the no-memory baseline next to every arm, in the same run.

This is the same discipline the ship rule already encodes internally: a mechanism is measured
against the honest alternative of *not having it*.

## What would change this

This section used to say a published score requires a corpus that is public, link-structured and
permission-aware, and that **none exists**. That is now wrong on two of the three criteria, and the
correction is more interesting than the claim was.

**A public, link-structured markdown corpus exists, and an Obsidian-side peer has already published
a number on it.** [`flowing-abyss/obsidian-hybrid-search`](https://mcpservers.org/servers/flowing-abyss/obsidian-hybrid-search)
evaluates against **Andy Matuschak's evergreen notes** — 1,357 notes with 5,000+ internal links and
78 hand-judged queries — and publishes result JSONs alongside the fixtures:

| | nDCG@5 | nDCG@10 | MRR | Hit@1 | Recall@10 |
| --- | --- | --- | --- | --- | --- |
| Matuschak evergreen notes (1,357 notes, 78 queries) | 0.722 | **0.753** | 0.874 | 0.795 | 0.972 |

That corpus is the first public one with a **real wikilink topology**, which makes it the first
available outside test of whether graph expansion earns its keep — the mechanism this engine is
built around and the one a flat document benchmark cannot exercise.

**Three caveats, none of which restore the old claim.**

*It was not permission-aware — that criterion has since been met by construction rather than by
finding a corpus.* See [Permission-aware retrieval on the same public
corpus](#permission-aware-retrieval-on-the-same-public-corpus-2026-08-08) below.

*The comparable number was not measured on a comparable embedder.* That 0.753 comes from
`Xenova/multilingual-e5-small` running locally. This engine runs `BAAI/bge-m3` at 1024d. The same
project's third evaluation (LongMemEval-S, 22,419 notes, 470 queries) **does** use `baai/bge-m3` and
reports nDCG@5 0.895 — but on a conversational corpus, which is the shape problem this document
already describes. So there is no single row that is comparable on both corpus shape and embedder.

*Their numbers come from their harness.* Comparing across harnesses makes boundary differences more
dangerous, not less — retrieval-vs-answer cut, judge model, and top-k all move a score. Running
their public corpus through *this* harness is the comparison that would mean something; citing their
figure next to ours is not.

**The first option has since been taken** — see
[Published on a public corpus](#published-on-a-public-corpus-2026-08-07) — and the permission-aware
criterion has been met by *constructing* the missing axis rather than waiting for a corpus to appear
with it (below). What remains open is a synthetic link-structured vault, or a partial BEIR number
carrying an explicit caveat about which stages it fails to exercise.

The position that publishing this methodology — including the negative results and the resolution
limits — beats a borrowed number measured on the wrong shape of data is unchanged. What changed is
that a right-shaped corpus turned out to exist, so the single number now published is one anybody
can re-derive.

If you are evaluating obsidian-tc against alternatives, the honest summary is: the retrieval
mechanisms here are gated by a pre-registered statistical rule; two of them failed it and ship dark
with their numbers recorded; one public-corpus comparison is published above with both its
binarizations and its power limits; and the larger internal corpus behind everything else is
private. Weigh that against a competitor's headline figure accordingly — noting, from the section
above, that a headline figure on a conversational benchmark may be grading the reader rather than
the retriever, and may be scored against a key with known errors.
