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

**Status 2026-07-19 (THE-440/441 recalibration): the set is n=136, and the MDE is now MEASURED,
not assumed.** Running `eval/run.ts` prints a `power ΔnDCG@10` line computed from the actual
per-query paired-delta spread on the live golden set:

```
power ΔnDCG@10  : σ_d 0.155  SE 0.0133  MDE@n=136 0.037 (α=0.05, power=0.8)  |  Δ=0.05→n≥76  Δ=0.03→n≥210  Δ=0.02→n≥472
```

So the real σ_d is **0.155** (nomic enrichment tightened it below the old 0.20 assumption), the
MDE at n=136 is **~0.037 nDCG**, and the golden-set sizes needed for smaller effects are
**Δ=0.05 → n≥76** (already cleared), **Δ=0.03 → n≥210**, **Δ=0.02 → n≥472**. Read a null result
against this line: a non-significant arm with |Δ| well under 0.037 is *underpowered*, not
*disproven*. Sub-0.03 gains (the THE-441 reranker regime) cannot be resolved at n=136 — grow the
set to ~210 first or accept the result as directional only.

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
