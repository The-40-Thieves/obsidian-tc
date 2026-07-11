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

**Status 2026-07-11: the set reached n=126 (THE-407)** — MDE is now ~0.05 nDCG, so rule 2's
"statistically significant win once the set is large enough" arm is LIVE (still under BH-FDR,
rule 3). The n≈126 growth items below are historical context.

The measurement floor at n=32: with per-query ΔnDCG SD ≈ 0.20, the SE of a mean paired delta is
≈ 0.035 and the minimal detectable effect (α=.05, power .8) is ≈ **0.10 nDCG** — most real
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

## History

Decision-grade baselines and every measured verdict live in the vault decision notes
(`09-reference/decisions/2026-07-11-*`) and on the Linear tickets (THE-390 … THE-406).
