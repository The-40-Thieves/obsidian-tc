# Retrieval eval — running it, and the ship rule

## Run

```
bun eval/run.ts <config.json> [golden-set.yaml] [flags] [--json out.json]
```

Flags A/B one mechanism each: `--adaptive-rrf`, `--graph-stream`, `--mmr`, `--no-lexical`,
`--sparse`, `--gated-rerank`, plus `RRF_K`-style env overrides where noted in `run.ts`. Every run
reports recall@10 / nDCG@10 / MRR@10 / bridge recall for the semantic baseline and the graph side, a
hard-subset slice, and (THE-399) a **paired permutation p-value + bootstrap 95% CI** for
graph-vs-baseline ΔnDCG@10 and Δrecall@10 on the same queries.

**`--gated-rerank`'s reranker** comes from `RERANK_URL` (a Cohere/Jina-shaped `/rerank` HTTP
backend — TEI or vLLM) when set, else from the config JSON's `reranker` block, resolved through the
SAME provider registry production uses (THE-806 step 2) — `{ "reranker": { "provider": "local" } }`
reaches THE-705's bundled offline cross-encoder with no separate server to stand up. **Its hardness
rule** (cosine top-1 vs z-margin, and the threshold) comes from the config's
`retrieval.gatedRerankHardness` block, via the SAME `gatedRerankOptionsFromConfig` function
`retrieval-runtime.ts` calls at boot — so a golden-set `--gated-rerank` result now measures exactly
the gate a deployment reading that config file would run. `GATED_HARD_Z` still overrides the
z-margin threshold for a quick sweep, but only takes effect in `zMargin` mode.

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

## gatedRerank hardness — calibration and the mode decision (THE-806, 2026-08-18)

THE-806 step 1 (PR #778) gave `gatedRerank`'s hardness rule a config surface
(`retrieval.gatedRerankHardness`) so production and the eval harness could construct the SAME
gate object — but the harness's own `--gated-rerank` flag never actually read it, so a golden-set
result still measured a rule production couldn't reproduce. This section is step 2/3: the harness
fix (see "`--gated-rerank`'s reranker" above), the calibration this repo owed THE-400 since
2026-07-11, and the resulting default decision. Measured against a **reachable, live-probed
reranker** for the first time — THE-705's bundled offline cross-encoder
(`{ "reranker": { "provider": "local" } }`), confirmed serving via `obsidian-tc doctor`
(`reranker.buildable` — resolved via source-checkout) and via `assertFlagDependencies`'s real probe
call (THE-807): both arms below stamp `gated-rerank` in their `--json` artifact, which only happens
when that preflight passed.

**Corpus:** the private multi-hop golden set (n=250) against the live BAAI/bge-m3 / 1024d
representation (`cache-the748-fresh`, 13,746 chunks) — the deployment's actual backbone; the
schema's shipped default (`nomic-embed-text`) does not describe it and the 0/32-fired figure in
`graph_search_stages/types.ts` was measured on nomic, not this corpus.

### Z1 calibration table

The z-margin distribution over the golden set's dense top-30 seed pool (`seedZMargin`, printed by
every run — no reranker required):

| min | p25 | median | p75 | max |
| --: | --: | --: | --: | --: |
| 1.57 | 2.27 | 2.66 | 3.26 | 4.69 |

**The floor is 1.57 — above the harness's own `hardZ` default of 1.0.** That default was never
calibrated against this backbone; it is the z-margin threshold `--gated-rerank` has hardcoded since
THE-400 (2026-07-11), carried forward unchanged. On bge-m3, `zMargin < 1.0` cannot fire on ANY of
these 250 queries — the exact same structural-zero shape as `top1 < 0.55` firing 0/32 on nomic
(the defect THE-400 was filed to replace). The two thresholds "currently in play" were both
miscalibrated for the backbone that measures them; this ticket's premise (one construction, so the
arms are comparable) was necessary but not sufficient — the *values* still needed calibrating, and
still do, for anyone revisiting `hardZ`'s default.

### The A/B: cosine@0.55 vs zMargin@1.0 vs off

Three arms, same config (`reranker.provider: "local"`) except for `retrieval.gatedRerankHardness`,
same golden set, paired by query id:

| comparison | ΔnDCG@10 | Δrecall@10 | ΔMRR@10 | Δbridge | permutation p (nDCG) | MDE@n=250 (nDCG) |
| --- | --: | --: | --: | --: | --: | --: |
| off → cosine@0.55 (production's shipped default) | +0.002 | +0.000 | +0.002 | +0.000 | 0.6270 | 0.009 |
| off → zMargin@1.0 (harness's long-standing default) | +0.000 | +0.000 | +0.000 | +0.000 | 1.0000 | 0.000 |
| cosine@0.55 → zMargin@1.0 | −0.002 | +0.000 | −0.002 | +0.000 | 0.6270 | 0.009 |

**zMargin@1.0 vs off is not a small effect — it is byte-identical on every metric, for every one of
the 250 paired queries** (σ_d = 0.000, MDE = 0.000). That is the calibration table's floor of 1.57
made concrete: the gate never fires, so the arm scores its control against itself by construction.
`cosine@0.55` does reach a nonzero (if tiny) fraction of queries — nDCG/MRR move a hair while
recall/bridge stay exactly 0.000, consistent with reranking reordering ranks inside an
already-identical retrieved set rather than changing which chunks are retrieved — but the movement
is far inside a **0.009 MDE**, one of the tightest this harness has measured (contrast: the
generic graph-vs-baseline MDE is 0.030–0.035 on this same corpus/metric, `docs/EVALUATION.md`).
This is a well-powered null, not an underpowered one.

### Step 3 decision: no default change

Neither candidate hardness rule clears `retrieval.gatedRerank`'s own claim bar (80%, its schema
comment) — one is a structural no-op, the other an unmeasurable-at-this-n null. Per this repo's ship
rule, a null result inside the MDE is a legitimate outcome, not license to pick a side:

- `retrieval.gatedRerankHardness.mode` stays `cosine` (the schema default, unchanged) — not because
  it measurably wins, but because it is the only one of the two thresholds that reaches any query in
  this corpus at all, and its effect is at least non-negative and non-inferior.
- `retrieval.gatedRerank` stays `false` (dark) — unchanged; this result does not meet the bar to
  flip it on.
- No config schema change. THE-806 step 1 already collapsed the "three thresholds" (0.55 / 1.0 /
  the audit's rejected 1.5) to a `mode`-switched surface that emits exactly one at a time; there is
  no ranking evidence here to justify moving the value either switch reads.
- What *should* change, as a follow-up rather than blocking this PR: `hardZ`'s default (1.0) is
  demonstrably miscalibrated for bge-m3 (floor 1.57) the same way `hardTop1`'s default (0.55) was
  for nomic. A future recalibration attempt should pick a threshold from this corpus's own quantiles
  (e.g. a quartile of z1) rather than carry either legacy constant forward unexamined.

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
