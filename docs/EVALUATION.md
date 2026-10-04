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

**Re-measured 2026-10-02 on the decontaminated vault.** The private vault carried a note that quoted the golden
queries verbatim until 2026-10-01 (see the contamination guard in `packages/server/eval/README.md`), and this
comparison's fused arm runs a BM25 stream over it. With that note dropped from the index copy the same comparison
reads **+0.026 nDCG@10** (95% CI [0.006, 0.048], p=0.014) and **+0.028 recall@10** (p=0.024); the fused arm moved
0.7696 to 0.7740 (32 of 250 queries, 28 up) and the dense baseline 0.7471 to 0.7476. The conclusion stands. Table and
artifacts: `docs/adr/0007-default-promotion-requires-multi-shape-evidence.md`, 2026-10-02 section.

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

## Local embedder model selection

The default `embeddings.provider` moved from `ollama` (requires a separately-run Ollama server) to
`local` (a bundled, fully offline dense embedder — see [Embeddings](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/src/content/docs/configuration/embeddings.md)).
Picking which model backs that default was treated as an empirical question, on the same public
corpus and harness as the rest of this document, not a specs-sheet judgment call.

**MDE stated before running.** The endpoint (strict nDCG@10, non-inferiority floor **−0.015**,
one-sided bootstrap lower bound), the corpus (the 78-query public evergreen set above), and the
comparison shape (candidate vs. acceptance arm, both run through the identical "local" code path)
were all fixed before any candidate was scored. At n=78 this corpus resolves an MDE of ~0.06-0.09
nDCG@10 depending on the specific contrast (see the power lines in the table below) — a real
regression smaller than that would read as "non-inferior" here, the same resolution limit this
document's other n=78 comparisons already carry.

**Candidates.** Three were shortlisted, run through Transformers.js's `feature-extraction`
pipeline (mean pooling, L2-normalized, quantized q8 ONNX), no query/document instruct prefixes on
any of them (a deliberate control — see caveats below):

| Candidate | Params | Dims | License | q8 size |
| --- | --- | --- | --- | --- |
| `all-MiniLM-L6-v2` ([Xenova mirror](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) | 22.7M | 384 | Apache-2.0 | ~23 MB |
| `bge-small-en-v1.5` ([Xenova mirror](https://huggingface.co/Xenova/bge-small-en-v1.5)) | 33.4M | 384 | MIT | ~34 MB |
| `nomic-embed-text-v1.5` ([nomic-ai](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)) — **acceptance arm** | 137M | 768 | Apache-2.0 | ~137 MB |

Two more were evaluated and **dropped before reaching measurement**, both for reasons unrelated to
retrieval quality:

- **EmbeddingGemma-300M** ([onnx-community mirror](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)).
  Model card license is `gemma` — Google's Gemma Terms of Use, not an OSI-approved license. It
  carries a Prohibited Use Policy Google may update unilaterally, and redistribution obligations
  (trademark notice, terms pass-through) that do not fit "auto-downloaded by default from every
  install of an AGPL-3.0 public server" — a user would be bound to those terms without having
  agreed to them.
- **A model2vec/potion static-embedding model** (`minishlab/potion-retrieval-32M`, MIT, the
  low-RAM tier the brief asked for if a loadable export exists). Its ONNX export declares
  `model_type: "model2vec"` / `architectures: ["StaticModel"]`, which Transformers.js 4.3.0 does
  not register. Probed directly (2026-09-24):
  `pipeline("feature-extraction", "minishlab/potion-retrieval-32M")` falls back to a generic
  encoder-only wrapper and fails at inference with `"Missing the following inputs: offsets"` —
  model2vec's bag-embedding ONNX graph has a different input contract than the transformer models
  Transformers.js's generic wrapper assumes. No Transformers.js-loadable export exists for this
  architecture today.

**Acceptance arm.** `nomic-embed-text-v1.5` stands in for what the old zero-config default
(`ollama` + `nomic-embed-text`) actually delivered — same model family, run through the identical
in-process code path every candidate uses, since Ollama itself is not installed on this evaluation
host. Every candidate is compared against it, not against each other.

**Results** (n=78, evergreen corpus, `notes/…` paths, depth 30, no flags — RE-MEASURED after a
review round found the first pass had applied mean pooling uniformly, which is wrong for
`bge-small-en-v1.5`'s own model card (CLS); see `model-info.ts`'s `pooling` field. This table
replaces that first pass's numbers entirely):

| Model | dims | pooling | strict nDCG@10 | strict recall@10 | lenient nDCG@10 | lenient recall@10 | model size | first-index time | peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 | 384 | mean | 0.742 | 0.885 | 0.572 | 0.611 | ~23 MB (q8) | ~18 min | ~1.1-1.3 GB |
| bge-small-en-v1.5 | 384 | cls | 0.788 | 0.861 | 0.564 | 0.564 | ~34 MB (q8) | ~33 min | ~1.2-1.3 GB |
| **nomic-embed-text-v1.5 (acceptance)** | 768 | mean | **0.843** | **0.929** | **0.623** | **0.652** | ~137 MB (q8) | ~80 min | ~2.7 GB |

First-index time and peak RSS were measured on THIS evaluation host (Ampere arm64, 4 vCPU,
**shared with other concurrent work throughout this ticket's own review round** — not a
clean-room benchmark, and nomic's ~80 min in particular is inflated by that contention, not solely
by its larger size; do not read these as a clean per-model speed comparison). Peak RSS is the
highest value observed via periodic `ps` sampling during each run, not a `/usr/bin/time -v`
peak-RSS instrumented measurement — a real observed floor on the true peak, not the true peak
itself. For a precisely-instrumented, small-fixture number instead, see the `local embedder
cold-start budget` step in CI (`packages/server/scripts/check-cold-start-budget.mjs`) — an
informational, generous-ceiling check, not a tight regression gate, since first-index time varies
with the runner's network and CPU far more than any of this document's other numbers.

Paired non-inferiority vs. the acceptance arm, strict binarization (the primary gate; n=78,
one-sided 95% bootstrap lower bound vs. the −0.015 floor; `eval/compare-baseline.ts`):

| Candidate | ΔnDCG@10 mean | one-sided 95% lower | σ_d | MDE@n=78 | permutation *p* | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 | −0.101 | **−0.151** | 0.267 | 0.085 | 0.0014 | **FAILS FLOOR** |
| bge-small-en-v1.5 | −0.055 | **−0.110** | 0.295 | 0.094 | 0.1034 | **FAILS FLOOR** |

Lenient binarization tells the same story (all-MiniLM-L6-v2: Δ −0.052, lower bound −0.085,
*p*=0.0124; bge-small-en-v1.5: Δ −0.059, lower bound −0.100, *p*=0.0135 — both below the −0.015
floor). Recall@10 also fails the floor for both candidates at both binarizations (full numbers in
the harness's own `--json` dumps; not reproduced here since nDCG@10 is the gate metric).

**MiniLM's deficit is real and clearly detected — significant at both binarizations (*p*=0.0014
strict, *p*=0.0124 lenient).** bge-small's deficit is real too (it fails the floor at both
binarizations, correctly-pooled, and its recall@10 is significant at *p*=0.0489 strict) but its
own nDCG@10 permutation test does not clear conventional significance at this n (*p*=0.10 strict) —
read that one number, specifically, as **non-inferiority not established at this corpus's
resolution** for nDCG@10, not as "passes." Every other reported metric and binarization for both
candidates clears the floor's FAILS verdict on its own terms; nothing here flips to non-inferior.

**The default is `nomic-embed-text-v1.5` — the conservative choice under an underpowered
comparison, not a claimed decisive win.** Non-inferiority is a floor a model must
clear to be **eligible**, not a reason to prefer whichever model clears it by the widest margin
toward "smaller" — the ship rule exists to keep a change from being *worse*, not to license
picking the cheapest option that isn't disqualified. Neither smaller model clears the floor here,
so `nomic-embed-text-v1.5` ships as the default: the only evaluated, licensable, loadable candidate
this measurement did not find worse. `all-MiniLM-L6-v2` and `bge-small-en-v1.5` remain selectable
via `embeddings.model` for deployments that value download size or CPU cost over this measurement.

**Caveats that travel with these numbers.**

1. **No instruct prefixes on any candidate.** `bge-small-en-v1.5`'s and `nomic-embed-text-v1.5`'s
   model cards both recommend a query-side (and, for nomic, a document-side) instruct prefix for
   best retrieval performance; none was applied to any of the three models here, for the same
   reason this repo's other comparisons run "no flags" — a consistent, disclosed control beats an
   inconsistent one, and this document has separately measured nomic-style prefixes **harmful** on
   a different corpus (see `queryPrefix`/`documentPrefix` in the config reference). A
   prefix-enabled re-run could shift these numbers; it was not run for this ticket.
2. **The acceptance arm is a stand-in, not the exact old default.** `nomic-embed-text-v1.5` (HF,
   768-dim) is not byte-identical to Ollama's `nomic-embed-text` tag — same model family, different
   serving path (in-process ONNX vs. Ollama's own runtime) and possibly a different checkpoint.
   Ollama is not installed on this evaluation host, so a direct comparison was not possible; the
   in-process HF equivalent was the closest available proxy.
3. **This corpus has zero bridge-labeled queries** (see the caveat on the main published-corpus
   table above) — this comparison says nothing about multi-hop/bridge retrieval quality across
   embedding models, only single-hop nDCG@10/recall@10.

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

*Re-measured 2026-10-02 on the decontaminated vault (graph arm, both arms path-deduped):* nDCG@10 -0.0373
(p 0.0025) with the contaminating note indexed and -0.0396 (p 0.0011) without it; MRR@10 -0.060 in both;
recall@10 +0.011 and +0.012, not significant. The verdict is unchanged.

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

*Re-measured 2026-10-02 on the decontaminated vault, each arm against its own control on one index copy:*
`knnEdges` floor 0.0 (6,771 edges) ΔnDCG@10 -0.0015 (p 0.63), bridge recall -0.008 (p 0.73), `tagEdges` fanout 25 (9,258 edges) ΔnDCG@10 -0.0009 (p 0.76),
bridge recall -0.004 (p 1.0); with the note indexed the replication reads -0.0017 and -0.0018 and reproduces the table
above. Still null on every metric.

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

## Multi-shape suite (2026-10-03)

ADR 0007 asks for three or more corpus shapes before a judgment mechanism earns a default, and until
this section the public record held two (the private multi-hop vault and the evergreen corpus). Part 1
of the suite adds three shapes anyone can fetch, with golden sets fixed before any arm ran. It records
**no mechanism result**: the only scored run is a single harness smoke. Corpora, licences, pins and the
golden-set recipe are in [`packages/server/eval/corpora/README.md`](../packages/server/eval/corpora/README.md);
the dark mechanisms the suite exists to test are inventoried in [`DARK_MECHANISMS.md`](./DARK_MECHANISMS.md).

| corpus | shape | source | notes |
| --- | --- | --- | ---: |
| `quartz-docs` | code documentation, English | `jackyzha0/quartz` `docs/` at a pinned commit, MIT | 111 |
| `knowledge-garden` | personal garden, Chinese, deep folders | `oldwinter/knowledge-garden` at a pinned commit, MIT | 959 |
| `synthetic-multihop` | generated multi-hop chains | `eval/gen-multi-hop-slice.ts`, seed 652 | 638 |

Shape statistics, computed with the indexer's own link extraction (`vault/links.ts`):

| corpus | notes | resolved links | links per note, mean (median) | orphan rate | no inbound link | folder depth, mean (max) | body chars, mean / median | CJK share |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | ---: |
| evergreen | 1357 | 4638 | 3.42 (2) | 0.0% | 0.07% | 1 (1) | 2319 / 1398 | 0% |
| quartz-docs | 111 | 314 | 2.83 (2) | 0.0% | 23.4% | 0.92 (1) | 3146 / 1602 | 0% |
| knowledge-garden | 959 | 2239 | 2.33 (0) | 5.2% | 7.9% | 2.73 (4) | 862 / 306 | 51% |
| synthetic-multihop | 638 | 518 | 0.81 (0) | 0.0% | 18.8% | 1 (1) | 71 / 71 | 0% |

The shapes differ on the axes ADR 0007 names: a small, link-sparse, long-note documentation set; a
large, folder-deep, short-note set in a language the default English tokenisation barely splits; and a
vault whose only structure is the planted chains.

**Golden sets** are mined from the corpus files alone (no arm's ranking is consulted) in five mechanical
classes: exact title, unique heading, unique sentence fragment, link context (a sentence of note A with its
link markup removed, target the note A links to) and bridge 2-hop (A links to B links to C, no A-C link
either way). The generator builds the contamination guard's rule in, so no note carries three or more
queries verbatim, and `--check` regenerates a set and fails on a byte difference.

**n and minimum detectable effect** on nDCG@10 (alpha 0.05 two-sided, power 0.8, through `powerReport`),
planned at the widest paired spread measured so far (sigma_d 0.206) and the narrowest (0.135):

| corpus | n | MDE at 0.206 | MDE at 0.135 |
| --- | ---: | ---: | ---: |
| evergreen (existing) | 78 | 0.065 | 0.043 |
| quartz-docs | 120 | 0.053 | 0.035 |
| knowledge-garden | 220 | 0.039 | 0.026 |
| synthetic-multihop | 120 | 0.053 | 0.035 |

Per-class n: quartz-docs link 20, bridge 10, quote 30, heading 30, title 30; knowledge-garden 40, 30, 50, 50,
50. A per-class cell is far below any of these n, so class means are descriptive only.

**Preregistration.** Before any scored run, `suite-plan.json` (committed beside the tools, sha256
`530470ee61141074d96cd903910c0ab08f04ed63365846c4e3f3fefafa41d2b6`) and the golden-set digests were
written down, together with this scope: one baseline run on `quartz-docs`, alone, a harness smoke with no
hypothesis and no authority to move a default, and two predictions: dense nDCG@10 well above 0.5, and a
graph-minus-baseline delta inside the planned MDE of 0.053.

**Smoke result (`quartz-docs`, default stack, bge-m3 1024d, n=120).** The artifact is
`/data/obsidian-tc-eval/multishape/smoke-quartz-docs/artifact.json`, sha256
`b9b97f52bd63fbbf81331f524d949c59d87b566b4c0188aa73880f0c60aee1e4`; the corpus pin was verified before the
run and the contamination guard passed.

| metric | dense baseline | graph | delta |
| --- | ---: | ---: | --- |
| nDCG@10 | 0.8443 | 0.8952 | +0.051, 95% CI [0.021, 0.084], permutation p = 0.0015 |
| recall@10 | 0.9167 | 0.9736 | +0.057, 95% CI [0.018, 0.103], p = 0.0067 |
| MRR@10 | 0.849 | 0.888 | +0.039 |

Observed sigma_d was 0.177, so the achieved MDE at n=120 is 0.045, narrower than the planned 0.053.
nDCG@10 by class, baseline to graph: link 0.821 to 0.868 (n=20), bridge 0.729 to 0.678 (n=10), quote
0.707 to 0.857 (n=30), heading 0.892 to 0.952 (n=30), title 0.988 to 0.967 (n=30).

How the predictions fared. Dense above 0.5 held (0.844). The delta prediction held on its letter
(+0.051 is below the planned 0.053) and missed on its point: the planned MDE was a conservative spread, the
realised spread was narrower, and the delta is significant. It is also one corpus, one run and the
default stack, so it is a statement about this shape and does not flip anything: ADR 0007 still needs
the other shapes and the mechanisms themselves scored, and none has been. The bridge class moving the
wrong way is a ten-query cell and is noted, not interpreted.

## Multi-shape suite, part 2: the arm matrix (2026-10-04)

Part 1 sourced the shapes. Part 2 runs the dark mechanisms and the shipped defaults on four corpora, one `eval/run.ts` (or
`eval/search-mode.ts`) process at a time, every run recorded with `eval/history.ts` (80 runs in
`/data/obsidian-tc-eval/multishape/part2/runs.db`; artifacts `artifacts/<corpus>--<arm>.json`, none deleted). It changes no
default. Two parts of the planned matrix are **pending**, not run: the reranker re-test (needs a GPU, awaiting the owner's
approval) and the learned-sparse and ColBERT arms (need a multi-vector encoder). Both are listed again at the end.

**Preregistration.** `PREREGISTRATION-part2.md` (sha256 `43863ad7559c9cad0b34e39953059c92ccb5694a75083fd1fbcfa4965bfbd647`,
2026-10-04T03:59:22Z) fixed the corpora, golden sets, MDEs, statistics and verdict rule before any part-2 arm ran; addendum 1
(sha256 `ce937d40d3f56559f129ed95f6697e16baeb6bc5e4035a8e2fa6d79e1b44df8c`, 2026-10-04T04:44:47Z) added the tier C arms below.
Disclosed there: tier A and B had been scored on two corpora when the addendum was written, and nothing in it was tuned on a
result. No preregistered MDE was changed.

| corpus | n | labels | MDE nDCG@10 | index |
| --- | ---: | --- | ---: | --- |
| evergreen | 78 | strict (existing set) | 0.0653 | copy of the reranker-study index (bge-m3 1024d) |
| quartz-docs | 120 | `golden/quartz-docs.json` | 0.0527 | copy of the part-1 smoke index; 575 chunks of 110 of 111 notes |
| knowledge-garden | 220 | `golden/knowledge-garden.json` | 0.0389 | `obsidian-tc index`; 2422 chunks of 832 of 959 notes (see below) |
| synthetic-multihop | 120 | `golden/synthetic-multihop.example.yaml` | 0.0527 | `obsidian-tc index`; 878 chunks of 638 notes |

Embeddings are `BAAI/bge-m3` 1024d through the gateway alias on every corpus. The contamination guard passed in every call. A control
re-run on `quartz-docs` was bit-identical to the part-1 smoke (nDCG@10 0.8443 to 0.8952, p 0.0015), so runs are deterministic.

**Why the knowledge-garden index holds 832 of 959 files.** The pin counts Markdown files; the index counts notes that yield a chunk.
The chunker consumes heading lines into the breadcrumb and drops a section with no body text, so a note that is only frontmatter, or
only headings, has a `notes` row and no chunk. All 127 missing notes were inspected: 123 are frontmatter-only and 4 are
headings-only. None was excluded for size, language or a parse failure (0 embed failures, 0 frontmatter failures, 0 secret-gated). The
same rule leaves 1 of 111 quartz-docs notes and 66 of 1357 evergreen notes unchunked (none has body text beyond headings). Recorded
in [`corpora/README.md`](../packages/server/eval/corpora/README.md), "What the indexer keeps".

**Verdict rule** (mechanical, per arm and corpus, against the MDE above). WIN: delta above zero, Benjamini-Hochberg significant
(q 0.10, one family per corpus, nDCG@10) and delta at least the MDE. LOSS: the mirror image. TIE (within MDE): everything else; a tie
with raw p below 0.05 and a delta below the MDE is annotated "sig, sub-MDE" and is **not** a win. A TIE means "no effect larger than
the MDE", not "no effect". The default stack row compares the control's own two sides (production graph order against dense-only), one
comparison per corpus, raw p below 0.05. `queries changed` counts queries whose ranked list differs from the control's.

**Tier C arms (addendum 1).** `fanout`: three phrasings per golden query from `openai/gpt-5.4-nano` through the gateway (538 short
completions in total, public query text only, written once to a file and reused), against `default-pathdedup` (the fan-out dedupes
by note, so the control must too). `route-weak-text` and `route-hybrid` against `route-text-first` (the shipped route), through
`eval/search-mode.ts` with the pools stage's query vectors. `cluster-cap`: `obsidian-tc cluster --k round(sqrt(chunks))` on an index
copy (k = 24, 55, 49, 30 for quartz-docs, evergreen, knowledge-garden, synthetic-multihop), then `--max-per-cluster 2`, against
`default`. `llm-edges` was **not run** (see the skipped list).

### Per-corpus results

Each table is the output of `bun eval/corpora/matrix-report.ts` on the artifact directory, pasted verbatim. Columns: nDCG@10 of the
control side to the arm side, paired delta with a bootstrap 95% interval, permutation p, Benjamini-Hochberg result within the
corpus family, recall@10 and MRR@10 deltas, bridge nDCG@10 delta where queries declare bridges (n in brackets), queries changed, verdict.
The control row of each group is the comparison of the default stack (or the route or path-dedup control) against dense.

#### evergreen (MDE 0.0653, control: default)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default stack, graph vs dense | 0.8683 to 0.9143 | +0.046 [+0.001, +0.094] | 0.053 | ns | +0.036 (p 0.123) | +0.041 (p 0.180) | n/a | 23 | TIE |
| adaptive-rrf | 0.9143 to 0.9060 | -0.008 [-0.030, +0.013] | 0.481 | no | -0.019 (p 0.495) | -0.004 (p 0.905) | n/a | 10 | TIE |
| class-router | 0.9143 to 0.9143 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | n/a | 0 | TIE |
| cluster-cap | 0.9143 to 0.8862 | -0.028 [-0.054, -0.008] | 0.031 | no | -0.056 (p 0.031) | -0.010 (p 0.251) | n/a | 6 | TIE (sig, sub-MDE) |
| convex | 0.9143 to 0.8966 | -0.018 [-0.045, +0.009] | 0.213 | no | -0.036 (p 0.062) | +0.006 (p 0.778) | n/a | 15 | TIE |
| derived-defaults | 0.9143 to 0.9143 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | n/a | 0 | TIE |
| gated-rerank | 0.9143 to 0.9057 | -0.009 [-0.022, +0.000] | 0.492 | no | -0.013 (p 1.000) | -0.008 (p 0.492) | n/a | 2 | TIE |
| graph-stream | 0.9143 to 0.9072 | -0.007 [-0.022, +0.003] | 0.369 | no | +0.000 (p 1.000) | -0.010 (p 0.363) | n/a | 7 | TIE |
| knn | 0.9143 to 0.9056 | -0.009 [-0.026, +0.000] | 0.509 | no | +0.000 (p 1.000) | -0.011 (p 0.509) | n/a | 2 | TIE |
| metadata-prior | 0.9143 to 0.9143 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | n/a | 0 | TIE |
| mmr | 0.9143 to 0.9132 | -0.001 [-0.004, +0.001] | 0.435 | no | +0.000 (p 1.000) | -0.000 (p 1.000) | n/a | 5 | TIE |
| no-lexical | 0.9143 to 0.8508 | -0.063 [-0.113, -0.015] | 0.011 | no | -0.019 (p 0.495) | -0.062 (p 0.063) | n/a | 25 | TIE (sig, sub-MDE) |
| smooth-expansion | 0.9143 to 0.9141 | -0.000 [-0.002, +0.002] | 1.000 | no | +0.000 (p 1.000) | -0.002 (p 1.000) | n/a | 2 | TIE |
| tag | 0.9143 to 0.9143 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | n/a | 0 | TIE |
| z-router | 0.9143 to 0.9103 | -0.004 [-0.023, +0.008] | 1.000 | no | +0.004 (p 1.000) | -0.008 (p 1.000) | n/a | 4 | TIE |

#### evergreen (MDE 0.0653, control: default-pathdedup)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default-pathdedup (control) vs dense | 0.8683 to 0.9143 | +0.046 [+0.001, +0.094] | 0.053 | ns | +0.036 (p 0.123) | +0.041 (p 0.180) | n/a | 23 | TIE |
| fanout | 0.9143 to 0.7172 | -0.197 [-0.259, -0.134] | <0.001 | yes | -0.019 (p 0.495) | -0.255 (p <0.001) | n/a | 45 | LOSS |

#### evergreen (MDE 0.0653, control: route-text-first)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| route-text-first (control) vs dense | 0.8683 to 0.8491 | -0.019 [-0.068, +0.030] | 0.442 | ns | -0.006 (p 1.000) | -0.017 (p 0.587) | n/a | 10 | TIE |
| route-hybrid | 0.8491 to 0.8865 | +0.037 [+0.002, +0.079] | 0.049 | yes | +0.019 (p 0.502) | +0.036 (p 0.155) | n/a | 9 | TIE (sig, sub-MDE) |
| route-weak-text | 0.8491 to 0.8491 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | n/a | 0 | TIE |

#### knowledge-garden (MDE 0.0389, control: default)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default stack, graph vs dense | 0.7008 to 0.7975 | +0.097 [+0.063, +0.133] | <0.001 | p<0.05 | +0.093 (p <0.001) | +0.096 (p <0.001) | -0.021 (p 0.537) (30) | 98 | WIN |
| adaptive-rrf | 0.7975 to 0.8103 | +0.013 [-0.001, +0.027] | 0.084 | no | +0.002 (p 1.000) | +0.018 (p 0.069) | +0.000 (p 1.000) (30) | 31 | TIE |
| class-router | 0.7975 to 0.7986 | +0.001 [-0.007, +0.010] | 0.752 | no | +0.000 (p 1.000) | +0.002 (p 0.752) | +0.000 (p 1.000) (30) | 5 | TIE |
| cluster-cap | 0.7975 to 0.7750 | -0.022 [-0.035, -0.011] | <0.001 | yes | -0.050 (p <0.001) | -0.005 (p 0.043) | -0.060 (p 0.082) (30) | 36 | TIE (sig, sub-MDE) |
| convex | 0.7975 to 0.6911 | -0.106 [-0.140, -0.075] | <0.001 | yes | -0.139 (p <0.001) | -0.085 (p <0.001) | -0.040 (p 0.248) (30) | 79 | LOSS |
| derived-defaults | 0.7975 to 0.7975 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (30) | 0 | TIE |
| gated-rerank | 0.7975 to 0.7897 | -0.008 [-0.021, +0.003] | 0.204 | no | +0.009 (p 0.501) | -0.013 (p 0.109) | +0.000 (p 1.000) (30) | 7 | TIE |
| graph-stream | 0.7975 to 0.7979 | +0.000 [-0.011, +0.010] | 0.949 | no | -0.002 (p 1.000) | -0.002 (p 0.629) | +0.055 (p 0.069) (30) | 19 | TIE |
| knn | 0.7975 to 0.7944 | -0.003 [-0.013, +0.005] | 0.544 | no | -0.006 (p 0.501) | -0.003 (p 0.625) | +0.017 (p 0.373) (30) | 11 | TIE |
| metadata-prior | 0.7975 to 0.7975 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (30) | 0 | TIE |
| mmr | 0.7975 to 0.7924 | -0.005 [-0.010, -0.001] | 0.022 | yes | -0.002 (p 1.000) | -0.006 (p 0.002) | +0.005 (p 1.000) (30) | 34 | TIE (sig, sub-MDE) |
| no-lexical | 0.7975 to 0.6736 | -0.124 [-0.161, -0.089] | <0.001 | yes | -0.113 (p <0.001) | -0.114 (p <0.001) | -0.032 (p 0.506) (30) | 80 | LOSS |
| smooth-expansion | 0.7975 to 0.8002 | +0.003 [+0.001, +0.006] | 0.032 | yes | +0.005 (p 0.251) | +0.002 (p 0.252) | +0.021 (p 0.254) (30) | 9 | TIE (sig, sub-MDE) |
| tag | 0.7975 to 0.7975 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (30) | 0 | TIE |
| z-router | 0.7975 to 0.8047 | +0.007 [-0.001, +0.015] | 0.072 | no | +0.007 (p 0.509) | +0.003 (p 0.395) | +0.039 (p 0.018) (30) | 22 | TIE |

#### knowledge-garden (MDE 0.0389, control: default-pathdedup)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default-pathdedup (control) vs dense | 0.7008 to 0.7975 | +0.097 [+0.063, +0.133] | <0.001 | p<0.05 | +0.093 (p <0.001) | +0.096 (p <0.001) | -0.021 (p 0.537) (30) | 99 | WIN |
| fanout | 0.7975 to 0.5174 | -0.280 [-0.321, -0.239] | <0.001 | yes | -0.090 (p <0.001) | -0.347 (p <0.001) | -0.064 (p 0.133) (30) | 167 | LOSS |

#### knowledge-garden (MDE 0.0389, control: route-text-first)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| route-text-first (control) vs dense | 0.7008 to 0.8335 | +0.133 [+0.082, +0.184] | <0.001 | p<0.05 | +0.077 (p 0.003) | +0.151 (p <0.001) | +0.000 (p 1.000) (30) | 58 | WIN |
| route-hybrid | 0.8335 to 0.8396 | +0.006 [-0.009, +0.022] | 0.455 | no | +0.039 (p 0.004) | -0.007 (p 0.375) | +0.000 (p 1.000) (30) | 18 | TIE |
| route-weak-text | 0.8335 to 0.8317 | -0.002 [-0.012, +0.009] | 0.726 | no | +0.011 (p 0.249) | -0.008 (p 0.216) | +0.000 (p 1.000) (30) | 8 | TIE |

#### quartz-docs (MDE 0.0527, control: default)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default stack, graph vs dense | 0.8443 to 0.8952 | +0.051 [+0.021, +0.084] | 0.001 | p<0.05 | +0.057 (p 0.007) | +0.039 (p 0.038) | -0.011 (p 0.932) (10) | 34 | TIE (sig, sub-MDE) |
| adaptive-rrf | 0.8952 to 0.8821 | -0.013 [-0.027, -0.003] | 0.015 | yes | +0.000 (p 1.000) | -0.013 (p 0.032) | -0.013 (p 1.000) (10) | 20 | TIE (sig, sub-MDE) |
| class-router | 0.8952 to 0.8863 | -0.009 [-0.026, +0.009] | 0.341 | no | -0.014 (p 0.088) | -0.007 (p 0.597) | +0.026 (p 1.000) (10) | 12 | TIE |
| cluster-cap | 0.8952 to 0.8820 | -0.013 [-0.027, -0.002] | 0.052 | no | -0.031 (p 0.056) | -0.004 (p 0.503) | -0.063 (p 1.000) (10) | 13 | TIE |
| convex | 0.8952 to 0.8193 | -0.076 [-0.117, -0.039] | <0.001 | yes | -0.101 (p <0.001) | -0.066 (p <0.001) | -0.017 (p 0.872) (10) | 35 | LOSS |
| derived-defaults | 0.8952 to 0.8952 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (10) | 0 | TIE |
| gated-rerank | 0.8952 to 0.8893 | -0.006 [-0.028, +0.012] | 0.689 | no | -0.008 (p 1.000) | -0.006 (p 0.737) | +0.000 (p 1.000) (10) | 7 | TIE |
| graph-stream | 0.8952 to 0.8900 | -0.005 [-0.017, +0.005] | 0.392 | no | +0.003 (p 1.000) | -0.008 (p 0.378) | +0.043 (p 1.000) (10) | 17 | TIE |
| knn | 0.8952 to 0.8952 | +0.000 [-0.008, +0.006] | 1.000 | no | +0.006 (p 0.511) | -0.004 (p 1.000) | +0.069 (p 0.504) (10) | 5 | TIE |
| metadata-prior | 0.8952 to 0.8952 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (10) | 0 | TIE |
| mmr | 0.8952 to 0.8921 | -0.003 [-0.008, +0.002] | 0.248 | no | +0.000 (p 1.000) | -0.002 (p 0.695) | -0.013 (p 1.000) (10) | 12 | TIE |
| no-lexical | 0.8952 to 0.8240 | -0.071 [-0.108, -0.038] | <0.001 | yes | -0.072 (p 0.002) | -0.055 (p 0.007) | -0.093 (p 0.254) (10) | 41 | LOSS |
| smooth-expansion | 0.8952 to 0.8931 | -0.002 [-0.012, +0.006] | 0.658 | no | +0.006 (p 0.493) | -0.006 (p 0.502) | +0.018 (p 1.000) (10) | 10 | TIE |
| tag | 0.8952 to 0.8922 | -0.003 [-0.010, +0.001] | 0.570 | no | +0.000 (p 1.000) | -0.004 (p 1.000) | +0.000 (p 1.000) (10) | 5 | TIE |
| z-router | 0.8952 to 0.8977 | +0.002 [-0.003, +0.008] | 0.449 | no | +0.000 (p 1.000) | +0.003 (p 0.251) | +0.030 (p 1.000) (10) | 6 | TIE |

#### quartz-docs (MDE 0.0527, control: default-pathdedup)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default-pathdedup (control) vs dense | 0.8443 to 0.8952 | +0.051 [+0.021, +0.084] | 0.001 | p<0.05 | +0.057 (p 0.007) | +0.039 (p 0.038) | -0.011 (p 0.932) (10) | 33 | TIE (sig, sub-MDE) |
| fanout | 0.8952 to 0.6938 | -0.201 [-0.248, -0.158] | <0.001 | yes | -0.010 (p 0.505) | -0.254 (p <0.001) | -0.012 (p 0.755) (10) | 81 | LOSS |

#### quartz-docs (MDE 0.0527, control: route-text-first)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| route-text-first (control) vs dense | 0.8443 to 0.9085 | +0.064 [+0.016, +0.116] | 0.011 | p<0.05 | +0.042 (p 0.128) | +0.071 (p 0.012) | +0.000 (p 1.000) (10) | 24 | WIN |
| route-hybrid | 0.9085 to 0.9260 | +0.018 [+0.001, +0.036] | 0.093 | no | +0.008 (p 1.000) | +0.021 (p 0.108) | +0.000 (p 1.000) (10) | 7 | TIE |
| route-weak-text | 0.9085 to 0.9085 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (10) | 0 | TIE |

#### synthetic-multihop (MDE 0.0527, control: default)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default stack, graph vs dense | 0.7654 to 0.7849 | +0.020 [+0.010, +0.031] | 0.002 | p<0.05 | +0.028 (p 0.002) | +0.000 (p 1.000) | +0.042 (p 0.002) (120) | 119 | TIE (sig, sub-MDE) |
| adaptive-rrf | 0.7849 to 0.7863 | +0.001 [+0.000, +0.004] | 1.000 | no | +0.003 (p 1.000) | +0.000 (p 1.000) | +0.003 (p 1.000) (120) | 2 | TIE |
| class-router | 0.7849 to 0.9922 | +0.207 [+0.194, +0.219] | <0.001 | yes | +0.294 (p <0.001) | +0.000 (p 1.000) | +0.442 (p <0.001) (120) | 107 | WIN |
| cluster-cap | 0.7849 to 0.9467 | +0.162 [+0.151, +0.171] | <0.001 | yes | +0.300 (p <0.001) | +0.000 (p 1.000) | +0.345 (p <0.001) (120) | 108 | WIN |
| convex | 0.7849 to 0.7665 | -0.018 [-0.030, -0.008] | 0.002 | yes | -0.025 (p 0.005) | +0.000 (p 1.000) | -0.039 (p 0.002) (120) | 12 | TIE (sig, sub-MDE) |
| derived-defaults | 0.7849 to 0.7849 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| gated-rerank | 0.7849 to 0.7849 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| graph-stream | 0.7849 to 0.7849 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| knn | 0.7849 to 0.7654 | -0.020 [-0.031, -0.010] | 0.002 | yes | -0.028 (p 0.002) | +0.000 (p 1.000) | -0.042 (p 0.002) (120) | 11 | TIE (sig, sub-MDE) |
| metadata-prior | 0.7849 to 0.7849 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| mmr | 0.7849 to 0.7917 | +0.007 [+0.001, +0.013] | 0.064 | no | +0.014 (p 0.064) | +0.000 (p 1.000) | +0.023 (p <0.001) (120) | 5 | TIE |
| no-lexical | 0.7849 to 0.7858 | +0.001 [-0.003, +0.006] | 1.000 | no | +0.003 (p 1.000) | +0.000 (p 1.000) | +0.014 (p 0.011) (120) | 110 | TIE |
| smooth-expansion | 0.7849 to 0.7846 | -0.000 [-0.001, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | -0.001 (p 1.000) (120) | 1 | TIE |
| tag | 0.7849 to 0.7849 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| z-router | 0.7849 to 0.8025 | +0.018 [+0.002, +0.033] | 0.049 | no | +0.025 (p 0.048) | +0.000 (p 1.000) | +0.037 (p 0.049) (120) | 18 | TIE (sig, sub-MDE) |

#### synthetic-multihop (MDE 0.0527, control: default-pathdedup)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| default-pathdedup (control) vs dense | 0.7654 to 0.7849 | +0.020 [+0.010, +0.031] | 0.002 | p<0.05 | +0.028 (p 0.002) | +0.000 (p 1.000) | +0.042 (p 0.002) (120) | 119 | TIE (sig, sub-MDE) |
| fanout | 0.7849 to 0.9341 | +0.149 [+0.139, +0.158] | <0.001 | yes | +0.300 (p <0.001) | +0.000 (p 1.000) | +0.344 (p <0.001) (120) | 108 | WIN |

#### synthetic-multihop (MDE 0.0527, control: route-text-first)

| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| route-text-first (control) vs dense | 0.7654 to 0.7654 | +0.000 [+0.000, +0.000] | 1.000 | ns | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| route-hybrid | 0.7654 to 0.7654 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |
| route-weak-text | 0.7654 to 0.7654 | +0.000 [+0.000, +0.000] | 1.000 | no | +0.000 (p 1.000) | +0.000 (p 1.000) | +0.000 (p 1.000) (120) | 0 | TIE |

### Reading the matrix

Delta nDCG@10 and verdict per arm and corpus (the paired control is the one named in the group headings above: `default` for every
row except `fanout` against `default-pathdedup` and the two route arms against `route-text-first`). "inert" marks a cell where no query's
ranking changed.

| arm | evergreen | quartz-docs | knowledge-garden | synthetic-multihop |
| --- | --- | --- | --- | --- |
| default stack (graph vs dense) | +0.046 TIE | +0.051 TIE (sig, sub-MDE) | +0.097 WIN | +0.020 TIE (sig, sub-MDE) |
| no-lexical (ablation of a default) | -0.063 TIE (sig, sub-MDE) | -0.071 LOSS | -0.124 LOSS | +0.001 TIE |
| convex fusion | -0.018 TIE | -0.076 LOSS | -0.106 LOSS | -0.018 TIE (sig, sub-MDE) |
| fanout | -0.197 LOSS | -0.201 LOSS | -0.280 LOSS | +0.149 WIN (templated artifact, below) |
| cluster-cap | -0.028 TIE (sig, sub-MDE) | -0.013 TIE | -0.022 TIE (sig, sub-MDE) | +0.162 WIN (templated artifact, below) |
| class-router | inert | -0.009 TIE | +0.001 TIE | +0.207 WIN (templated artifact, below) |
| route-hybrid vs text-first | +0.037 TIE (sig, sub-MDE) | +0.018 TIE | +0.006 TIE | inert |
| route-weak-text vs text-first | inert | inert | -0.002 TIE | inert |
| adaptive-rrf | -0.008 TIE | -0.013 TIE (sig, sub-MDE) | +0.013 TIE | +0.001 TIE |
| z-router 2.66 | -0.004 TIE | +0.002 TIE | +0.007 TIE | +0.018 TIE (sig, sub-MDE) |
| knn edges | -0.009 TIE | +0.000 TIE | -0.003 TIE | -0.020 TIE (sig, sub-MDE) |
| mmr | -0.001 TIE | -0.003 TIE | -0.005 TIE (sig, sub-MDE) | +0.007 TIE |
| gated-rerank (cosine@0.55) | -0.009 TIE | -0.006 TIE | -0.008 TIE | inert |
| graph-stream | -0.007 TIE | -0.005 TIE | +0.000 TIE | inert |
| smooth-expansion | -0.000 TIE | -0.002 TIE | +0.003 TIE (sig, sub-MDE) | -0.000 TIE |
| shared-tag edges | inert | -0.003 TIE | inert | inert |
| metadata-prior | inert | inert | inert | inert |
| derived-defaults | inert | inert | inert | inert |

What the matrix supports, and what it does not.

- **Nothing flips a default.** No arm wins on a majority of shapes with no loss on another: the only WIN cells outside the default
  stack are the three templated-artifact cells on `synthetic-multihop`, and each of those mechanisms loses or is flat elsewhere
  (fan-out loses on all three other corpora). The mechanisms that lose are `convex` (two LOSS, two TIE) and `fanout` (three LOSS), which
  agrees in sign with the private-vault fan-out loss recorded in "Multi-query fan-out" above (-0.047) at a much larger size. The fan-out golden queries are
  lookup-style (exact title, heading, quote fragment, link context); a paraphrase fan-out dilutes a query that names its target, and the
  MRR@10 deltas (-0.25 to -0.35) show the first hit displaced. That is a statement about these shapes and this generator, not about every
  fan-out.
- **The synthetic class-router win is a templated-query artifact; do not read it as a general win.** The 120 synthetic queries are
  templated ("How does the term-NNNN procedure described in Seed N conclude?"), each carries a minted token that appears in exactly its seed and its target
  note (checked on the first query), which is the kind of query a lexical short-circuit answers straight from the text index. The nDCG@10 move
  (0.7849 to 0.9922) comes with recall@10 +0.294 and MRR@10 +0.000 across 107 of 120 queries. Fan-out (+0.149) and cluster-cap (+0.162)
  show the same signature on this corpus (recall@10 +0.300, MRR@10 +0.000, 108 queries changed); three unrelated mechanisms producing one
  signature points at the corpus and not at the mechanisms, so treat all three synthetic cells as properties of the generated corpus. Its single shape cannot carry a
  mechanism claim. The cause was not diagnosed further here. On the three natural corpora, class-router is inert (evergreen) or a tie (-0.009, +0.001).
- **Inert arms are reported as inert, not as evidence about the mechanism.** `metadata-prior` changed no query on any corpus (none of
  these corpora carries the frontmatter the representative rule set reads), `derived-defaults` changed none (every index above 30 chunks derives
  the same `rrfK` of 10, so the arm is the constant), `shared-tag edges` built zero edges on evergreen, knowledge-garden and
  synthetic-multihop (no tags), `class-router` is inert on evergreen, `route-weak-text` and `route-hybrid` changed nothing on synthetic-multihop (and
  `route-weak-text` also nothing on evergreen and quartz-docs), and `gated-rerank` and `graph-stream` changed nothing on synthetic-multihop. A zero
  delta in these cells says the arm had nothing to act on; it is not a measurement that the mechanism does not help.
- **Significant but sub-MDE ties are not wins.** `default stack` on quartz-docs (+0.051 against an MDE of 0.0527) and synthetic-multihop,
  `no-lexical` on evergreen (-0.063 against 0.0653, BH not significant), `mmr` and `smooth-expansion` on knowledge-garden are
  ties in the preregistered words.
- **Bridge nDCG@10** is reported where the golden set declares bridges (quartz-docs 10 queries, knowledge-garden 30, synthetic-multihop 120,
  evergreen none); per-class cells are descriptive only, far below any of these n.

### Per-default "validated on shapes" labels (ADR 0007)

ADR 0007's rollout asks that every default say what evidence it rests on. This is that label for each current default, after part 2.
Shapes here are evergreen (English notes), quartz-docs (code documentation), knowledge-garden (Chinese, deep folders) and
synthetic-multihop (generated; templated queries). No label below moves a default.

| default | arm that tests it | validated on shapes | label |
| --- | --- | --- | --- |
| dense plus graph expansion (`graph_rrf` order) | default stack, graph vs dense | 4: WIN on knowledge-garden, TIE on the other three (two of them sig, sub-MDE); point estimate above dense on all four | validated on 4 shapes, no negative cell; one WIN, three TIEs; evergreen's interval touches zero (p 0.053) |
| lexical (BM25) stream fused with dense | `--no-lexical` ablation | 3 of 4 shapes show a loss on removal: LOSS quartz-docs and knowledge-garden, TIE (sig, sub-MDE, -0.063) on evergreen; neutral on synthetic-multihop | validated on 3 shapes; the synthetic shape is neutral and templated |
| `rrfK` = 10 | `derived-defaults` | none: the arm is identical to the constant on all four corpora | parity only; k=10 against another k is not tested on any new shape; stays ADR 0007 class (b), unaudited |
| `searchAutoRoute` = `text-first` | `route-text-first` vs dense (`search_vault` auto vs `search_semantic`); `weak-text` and `hybrid` against it | WIN knowledge-garden (+0.133) and quartz-docs (+0.064), TIE evergreen (-0.019), inert on synthetic-multihop (identical to dense) | text-first validated on 2 shapes (WIN), 1 TIE, 1 inert; no other route beats it by the MDE on any shape (hybrid +0.037 on evergreen is sig, sub-MDE) |
| no reranker | `gated-rerank` (cosine@0.55, shipped local MiniLM) vs off; the ungated re-test is pending | TIE on evergreen, quartz-docs, knowledge-garden; inert on synthetic-multihop | off, with a gated variant that ties on 3 shapes; the ungated reranker re-test on these shapes is pending (GPU) |
| `embeddings.chunkContext` = true | none: needs one freshly embedded index per corpus per arm | none | unaudited on these shapes (index-time ablation not run) |
| embedding model (bge-m3 through the gateway in every arm) | not varied | none | held fixed here; model comparisons are in ADR 0007's Gemini sections |

### Skipped before or while running, with the reason

| arm (`DARK_MECHANISMS.md` row) | status | reason |
| --- | --- | --- |
| LLM-inferred edges (5) | not run | `densify-llm` sends every note body to the gateway role `extract`, which is a metered per-token Google model, not a free or included one (about 80 batches of 12 notes, roughly 20k input tokens each, per corpus). New spend; skipped under the no-new-spend rule |
| learned sparse (1), ColBERT (2) | pending | need the bge-m3 multi-vector encoder; the gateway's bge-m3 routes are dense-only and no encoder is deployed |
| reranker re-test (3, 4) | pending | gte-reranker-modernbert needs a GPU (about 12 hours on this box's CPU); awaiting approval |
| query decomposition (10) | not run | the local LLM backend it needs was removed 2026-07-31 |
| note and cluster summaries (21, 22) | not run | the mechanism is gated on a global-query eval and the public golden sets hold no global query |
| activation rerank (20), search-mode preference reader (24) | not run | need recorded retrieval history; no public corpus has any |
| query-product cache (26) | not run | changes latency, not ranking |
| `embeddings.chunkContext` index-time ablation | not run | needs a fresh embedded index per corpus per arm, outside this matrix |

**Pending: reranker re-test (GPU) and learned sparse/ColBERT (encoder).** The reranker re-test (shipped local reranker against
`gte-reranker-modernbert`, same dense top-30 pools, ADR 0007 class (c) rule) is prepared (`eval/modal_rerank_gte.py`, preregistered in
`PREREGISTRATION-part2.md`) and has not been run. Until it is, the reranker label above stands on the gated arm only, and the learned-sparse and
ColBERT rows of `DARK_MECHANISMS.md` have no shape tested.

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
