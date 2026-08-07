# Evaluation methodology

obsidian-tc publishes **no headline benchmark score**. This document explains what is measured
instead, how, and what that does and does not let you conclude. It exists because *our* corpus is
private and the method does not have to be.

Read ["What would change this"](#what-would-change-this) before concluding that a published score is
impossible here. As of 2026-08-07 it is not — a public, wikilink-structured corpus with a peer's
published number exists, so "no headline score" is a choice rather than a constraint.

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

### Why there is still no replacement number, and the trap to avoid

The obvious move is to re-derive the figures against one of the bge-m3 indexes already on the eval
host. **That does not work, and the reason is worth writing down.**

`vec_index_fingerprint` records the embedding provider, model and dimensionality — it says nothing
about the *schema* the rest of the index was built under. Those caches were built on 2026-08-01 at
v1.13.0 and carry **22 applied migrations; the manifest now holds 42.** Running current retrieval
code against them exercises a 20-migration-old FTS and edge layout. The pure-dense baseline is
unaffected (it reads vec0 and the embeddings, which have not moved), so it reproduces byte-identical
across runs — which makes the setup look valid. The RRF-fused graph arm reads the tables those
migrations touched, and it does not.

Concretely: on that stale index the graph arm scores ~0.64 nDCG@10 where the same arm scored ~0.77
on 2026-08-01 code, while the baseline is unchanged at 0.7484. **A one-sided regression of that
shape is the signature of a stale index, not a retrieval result**, and it is not evidence about the
graph walk in either direction.

So a valid re-derivation needs a **fresh index on current code** — the ~6 minute, ~$0.078 re-index
THE-748 originally sized. "Same embeddings" is not "same index"; check `schema_migrations` against
the manifest before trusting any eval artifact built on a reused cache.

## Published negative results

The gate is only credible if it has refused things. Two mechanisms were built, measured, and left
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

*It is not permission-aware.* Folder ACLs remain untested by any public corpus, so one of the three
original criteria still genuinely has nothing behind it.

*The comparable number was not measured on a comparable embedder.* That 0.753 comes from
`Xenova/multilingual-e5-small` running locally. This engine runs `BAAI/bge-m3` at 1024d. The same
project's third evaluation (LongMemEval-S, 22,419 notes, 470 queries) **does** use `baai/bge-m3` and
reports nDCG@5 0.895 — but on a conversational corpus, which is the shape problem this document
already describes. So there is no single row that is comparable on both corpus shape and embedder.

*Their numbers come from their harness.* Comparing across harnesses makes boundary differences more
dangerous, not less — retrieval-vs-answer cut, judge model, and top-k all move a score. Running
their public corpus through *this* harness is the comparison that would mean something; citing their
figure next to ours is not.

The options therefore stand, re-ordered: run the Matuschak corpus through this repo's own harness
and publish both the number and the method; publish a synthetic link-structured vault; or a partial
BEIR number with an explicit caveat about which stages it fails to exercise. The first is now the
cheapest and the most credible, and it was previously believed impossible.

The position that publishing this methodology — including the negative results and the resolution
limits — beats a borrowed number measured on the wrong shape of data is unchanged. What has changed
is that a right-shaped corpus is now available, so "we publish no score" is a choice from here on
rather than a constraint.

If you are evaluating obsidian-tc against alternatives, the honest summary is: the retrieval
mechanisms here are gated by a pre-registered statistical rule, two of them failed it and shipped
dark with their numbers recorded, and the corpus that produced those numbers is private. Weigh that
against a competitor's headline figure accordingly — in either direction.
