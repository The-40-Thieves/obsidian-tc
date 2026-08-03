# Evaluation methodology

obsidian-tc publishes **no headline benchmark score**. This document explains what is measured
instead, how, and what that does and does not let you conclude. It exists because the corpus is
private and the method does not have to be.

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
The golden set is now **n=250**, and the spread was later
re-measured at σ_d 0.204 / MDE 0.036 — *worse* resolution than the earlier figure, not better. Both
numbers are kept rather than quietly replaced.

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

A published score requires a corpus that is public, link-structured, and permission-aware. None
exists. The options under consideration are a synthetic link-structured vault published alongside
the harness, an existing openly-licensed markdown corpus, or a partial BEIR number carrying an
explicit caveat about which stages it fails to exercise. The current position is that publishing
this methodology — including the negative results and the resolution limits — is worth
more than a borrowed number measured on the wrong shape of data.

If you are evaluating obsidian-tc against alternatives, the honest summary is: the retrieval
mechanisms here are gated by a pre-registered statistical rule, two of them failed it and shipped
dark with their numbers recorded, and the corpus that produced those numbers is private. Weigh that
against a competitor's headline figure accordingly — in either direction.
