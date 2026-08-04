# Retrieval eval — running it, and the ship rule

## Run

```
bun eval/run.ts <config.json> [golden-set.yaml] [flags] [--json out.json]
```

Flags A/B one mechanism each: `--adaptive-rrf`, `--graph-stream`, `--mmr`, `--no-lexical`,
`--sparse`, `--gated-rerank` (with `RERANK_URL`), plus `RRF_K`-style env overrides where noted in
`run.ts`. Every run reports recall@10 / nDCG@10 / MRR@10 / bridge recall for the semantic baseline
and the graph side, a hard-subset slice, and (THE-399) a **paired permutation p-value + bootstrap
95% CI** for graph-vs-baseline ΔnDCG@10 and Δrecall@10 on the same queries.

Compare two configs (paired by query id):

```
bun eval/run.ts <config> --json a.json
bun eval/run.ts <config> --graph-stream --json b.json
bun eval/compare.ts a.json b.json
```

## The ship rule (THE-399)

**Status 2026-08-02 (THE-674): the MDE is MEASURED on the engine that actually runs, and it is
METRIC-SPECIFIC.** Quote the row for the metric you are gating on, and name that metric when you
quote it.

| metric | n | σ_d | MDE (α=0.05, power=0.8) |
| --- | ---: | ---: | ---: |
| `bridge_recall` | 250 | 0.1257 | **0.0223** |
| `recall_at_10` | 250 | 0.1444 | **0.0256** |
| `ndcg_at_10` | 250 | 0.1984 | **0.0352** |
| `mrr_at_10` | 250 | 0.3090 | **0.0548** |
| `bridge_ndcg_at_10` | **103** | 0.2236 | **0.0617** |
| `expected_found_in_top10` | 250 | 0.3948 | 0.0699 |

**Two traps this table exists to close.**

1. **The spread across metrics is 2.5×.** A ticket gating on `recall_at_10` has a *better* bar than
   the headline; one gating on `mrr_at_10` has a materially worse one. A bare "MDE 0.035" is the
   `ndcg_at_10` number and is correct only for an nDCG gate.
2. **`bridge_ndcg_at_10` is scored on n=103, not 250.** The bridge metrics are `None` on unlabelled
   queries. Quoting an n=250 MDE for it is a fiction — and the bridge metrics are exactly the ones
   graph-expansion work (THE-693, THE-695) will want to gate on.

Sample sizes for smaller effects on `ndcg_at_10`: **Δ=0.030 → n≥344**, **Δ=0.020 → n≥773**,
**Δ=0.010 → n≥3,091**. The set is at n=250, so **Δ=0.030 is not yet resolvable at 80% power on
nDCG** — though it is on `recall_at_10` and `bridge_recall`.

Read a null against the row for your metric: a non-significant arm whose |Δ| is under that row's
MDE is *underpowered*, not *disproven*. THE-422 was cancelled on exactly this distinction.

### Provenance — why the older figures in this file were retired

The `σ_d 0.155 / MDE@n=136 0.037` line this section used to carry was a genuine measurement, taken
2026-07-19 at n=136 against the **nomic-embed-text / 768d** representation. That representation no
longer exists (Ollama was deleted 2026-07-31), so the figure describes an engine nothing runs. This
section also used to say the MDE "has **not** been re-measured at n=250 … treat that as an open
follow-up". **THE-674 closed that follow-up on 2026-08-02**; leaving the sentence in place was
sending readers to redo finished work.

THE-674 re-measured on the live **BAAI/bge-m3 / 1024d** store at `be4962d`, over the same n=250
golden set and the same control-vs-fanout contrast. Two results worth carrying forward:

* **σ_d moved only −2.7% across a full embedding-model swap** (0.2039 → 0.1984), which is why this
  table is expected to hold until the representation changes again rather than until the next PR.
* **Fan-out replicated as a regression on the new model** (−0.0430, t=−3.43, against −0.0474,
  t=−3.68 on nomic), so THE-448's conclusion survives a representation change — a stronger result
  than the original single measurement.

Note that **σ_d is contrast-specific**: the table above is the fan-out contrast. `eval/run.ts`
prints a live `power ΔnDCG@10` line computed from the actual per-query paired deltas of *that* run,
and for a specific contrast that line is the number to use.

The harness now computes the whole gate instead of leaving it to hand-arithmetic:
- **`power ΔnDCG@10`** — measured σ_d, SE, MDE at n, and n-needed table (`describePower`).
- **`non-inferiority`** — one-sided 95% bootstrap lower bound vs the Δ>−0.015 floor, per metric
  (`pairedNonInferiority`), so rule 2(a) is a computed verdict, not a CI eyeballed by hand.
- **`bridge nDCG@10`** — the Bridge Evidence (arXiv 2607.15253) static-vs-trajectory proxy:
  nDCG restricted to the bridge_paths (multi-hop, load-bearing-but-statically-weak docs) reported
  apart from static nDCG. It is a retrieval-only stand-in; true Counterfactual Trajectory Utility
  needs an agent leave-one-doc-out replay harness (follow-up), which this static eval cannot produce.
- **`eval/compare.ts`** now applies **Benjamini-Hochberg at q=0.10 across the metric family** and
  prints the non-inferiority + power lines for a two-config comparison — the multi-config sweep
  policy is no longer "by hand".

### Historical measurement floor (context)

The floor at n=32: with per-query ΔnDCG SD ≈ 0.20, the SE of a mean paired delta was
≈ 0.035 and the minimal detectable effect (α=.05, power .8) was ≈ **0.10 nDCG** — most real
improvements are smaller than that. Until the golden set reaches **n ≈ 126** (detects Δ=0.05):

1. **A point-estimate win alone never ships.** Report the permutation p and CI with every claim.
2. A default flips only on **(a) non-inferiority** — Δ > −0.015 on EVERY gate metric — **and (b) a
   mathematically identified structural fix** (e.g. the RRF k=10 crossover, THE-397), or on a
   statistically significant win once the set is large enough.
3. **Multiple comparisons:** a session that tests many configs applies Benjamini-Hochberg at
   q = 0.10 across its raw p-values before believing any single one.
4. Golden-set growth: fold the single-hop q031–q060 donor pool (KMS era) toward n≈126 — queries
   count toward gates only after Suavecito approves them (THE-171 convention). That expansion also
   adds the lexical/exact-term query class the multi-hop set lacks, which is required before any
   verdict on the BM25-stream default.

## Publishing the golden-set size to the docs

The wiki homepage's "At a glance" block cites the golden-set size and the headline enrichment gain.
Those live in `docs/project-facts.json` (the docgen single source) because the public repo can't
derive them — the golden set is private. Keep them current with the bridge instead of hand-editing:

```bash
# After a golden-set expansion — recount and refresh the DERIVED size (human-gated: writes the
# file, never commits). The golden set is private; pass its path (or set $OBSIDIAN_TC_GOLDEN):
bun run docgen:sync-facts --golden ~/obsidian-tc-eval/multi-hop-golden-set.yaml

# When a default-on mechanism wins its ship gate — set the CURATED headline claim explicitly
# (never auto-scraped from a run):
bun run docgen:sync-facts --enrichment "+0.223 nDCG"

# CI-style freshness check: exits 1 if project-facts.json is stale vs the golden set.
bun run docgen:sync-facts --golden ~/obsidian-tc-eval/multi-hop-golden-set.yaml --check
```

Then `bun run docgen:render`, review `git diff docs/`, and commit — merging republishes the wiki.

## Run history

`run.ts --json` writes an artifact wherever you point it, which is how runs ended up as
`eval-n216.json`, `eval-n252.json`, `review.json` with nothing recording which config produced
which. `history.ts` is the bookkeeping layer over those artifacts. It records **no new
statistics** — `diff` shells out to `compare.ts`, which owns the ship gate.

```bash
bun eval/run.ts <config.json> <golden-set.yaml> --json /tmp/candidate.json
bun eval/history.ts record /tmp/candidate.json --corpus <golden-set.yaml> --label "adaptive-rrf"
bun eval/history.ts list                # recent runs, one line each
bun eval/history.ts show 7              # provenance + both sides' aggregates
bun eval/history.ts diff 7              # vs the previous run on the SAME corpus
bun eval/history.ts export history.html # self-contained static page
```

Store is `eval/runs.db` (gitignored, as is the export — both derive from the private golden set).

**Pass `--corpus`.** It is optional only so old artifacts can be backfilled. With it, the run
records the golden set's sha256 and its *parsed* length, and `diff` refuses to compare two runs
whose corpus hashes differ. Without it there is nothing to check and you are back to trusting
that two files were measured against the same thing — which is how a 136-query corpus and a
250-query corpus got compared once already. `record` also warns when the artifact's row count
disagrees with the corpus length, which means a partial run.

## History

Decision-grade baselines and every measured verdict live in the vault decision notes
(`09-reference/decisions/2026-07-11-*`) and on the Linear tickets (THE-390 … THE-406).
