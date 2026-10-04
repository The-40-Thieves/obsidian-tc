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

**Golden-set contamination guard** (`golden-guard.ts`). Every script that scores a golden set against
a vault (`run.ts`, `search-mode.ts`, `query-cache.ts`, `search-and-read-cost.ts`, `export-rerank-pools.ts`,
`colbert_spike.ts`, `the651-ceiling-probe.ts`) first fails when an indexed note contains 3 or more
golden queries verbatim, naming the note path and count (never the query text). Such a note makes the
text leg hit itself instead of an expected note and skews every lexical/hybrid number measured on the
vault; once, all 94 text-routed `auto` queries on a private corpus hit one note. The fix is to move the
note out of the indexed tree (dot-folders are skipped) AND out of the index you score against (rebuild
it, or `deindexNote` on a copy): the guard reads the vault on disk, so a stale index copy still
carries the note. `EVAL_GOLDEN_CONTAMINATION_THRESHOLD=<n>|off` changes the limit; wikilinks and queries
under 3 tokens are not counted. A new scoring script must call `assertGoldenNotInVault` or join the
exempt list in `test/eval-golden-contamination.test.ts`.

**Index drift is a separate trap from contamination (re-measured 2026-10-02).** A golden set keys queries
to the notes that existed when it was labelled, so settling an old eval index copy against a vault that has
since grown (`eval/densify-index.ts --settle`) changes the corpus, not the engine: on the private set a copy
carrying roughly a quarter more notes scored 0.5542 dense nDCG@10 against 0.7476 on the same copy before the
settle (same code, same query vectors, every target path still indexed; the guard passed, no new note quotes
a query). The new notes are distractors. Keep the pre-drift copy (minus any contaminating note) as the
like-for-like baseline, score a settled copy as a different corpus, and record which state a run used in
`history.ts record --note`: the run's `corpus_sha256` covers the golden set only, so it does not move when the
vault does. See `docs/adr/0007-default-promotion-requires-multi-shape-evidence.md` (2026-10-02 section).

Compare two configs (paired by query id):

```
bun eval/run.ts <config> --json a.json
bun eval/run.ts <config> --graph-stream --json b.json
bun eval/compare.ts a.json b.json
```

## Reranker arms over the same dense top-K (`rerank-arms.ts`)

Three resumable stages, each writing plain JSON; the pool file carries vault text and stays under the
experiment directory:

```
bun eval/rerank-arms.ts pools  <config> <golden> --out pools.json --kind public|private [--query-vecs v.json] [--k 50]
bun --env-file=<keys> eval/rerank-arms.ts rerank <pools.json> --arm <name> --k 30 --out r.json [--neuron-cap N] [--title-prefix]
bun eval/rerank-arms.ts score  <golden> <pools.json> --results a.json,b.json --out-dir <dir> [--gate-classes lexical] [--gate-hop single-hop]
```

`pools` runs the real `search_semantic` handler (the dense control) and the production graph order (a second
control) and records each query's router class. `rerank` sends one arm's calls with per-provider adapters
(`rerank-adapters.ts`: Cloudflare, DeepInfra, NVIDIA, OpenRouter through the unchanged `cohere-compatible`
provider, local MiniLM through `reranker-local`, and a local bge-reranker-v2-m3 latency probe, measured at about 98 s per search and dropped); a query already
answered is never re-sent, `--neuron-cap` bounds Cloudflare spend, and an arm whose provider's terms allow
training on submitted text refuses a private pool (`PUBLIC_ONLY_ARMS`). `score` writes one `history.ts`-shaped
artifact per arm and a `summary.json` with the paired statistics, the pre-registered per-corpus verdict, the
per-class breakdown (hop class, router class, category) and the class-gated arms. Pre-register first.

## Embedder arms over one index (`embedder-arms.ts`)

Does another embedding model beat the shipped one? Every arm embeds the SAME chunks (the source index
copy's chunking and ids) and is scored through the brute-force cosine path, so arms differ only in their
vectors. Pre-register first, then one arm at a time:

```
bun eval/embedder-arms.ts index   <source-config.json> --arm <name> --exp-dir D [--corpus public|private]
bun eval/embedder-arms.ts queries <golden> [<golden> ...] --arm <name> --exp-dir D [--corpus public|private]
bun eval/rerank-arms.ts   pools   D/arms/<arm>/config.json <golden> --out D/pools-<arm>.json \
     --query-vecs D/qvecs-<arm>.json --kind public|private --k 50
bun eval/embedder-arms.ts score   --exp-dir D --golden strict=<path>,lenient=<path> --out-dir D/score
bun eval/history.ts record D/score/artifact-<arm>-<labels>.json --db D/runs.db --corpus <golden> --label <l> --note <index state>
```

`index` copies the source `cache.db` into `D/arms/<arm>/`, writes that arm's `config.json`, re-embeds every
chunk (resumable: a rerun skips chunks already embedded; exit code 3 means incomplete) and logs per-batch
latency. The control arm (`bge-m3`) keeps its production vectors and re-embeds a 24-chunk sample through the
harness's own path, recording the cosine with the stored vectors. `queries` embeds each query with the arm's
query side, one sequential call each after a warm-up, and writes the vectors for `rerank-arms.ts pools`.
`score` reports nDCG@10, MRR@10, recall@10 and recall@50 per arm, paired statistics against the control, the
Benjamini-Hochberg verdict over the decision-bearing arms (`EMBEDDER_ARMS` in `embedder-arms-lib.ts`), the
production `graph_rrf` order under each embedder, latency, a cost table, and the "run the private phase"
decision as `privatePhaseDecision` defines it, plus one `history.ts` artifact per arm and label set.

Gemini is called directly (the gateway has no Gemini embedding alias and passes no task type). The text each
model gets follows its documentation: `gemini-embedding-001` takes `taskType` (`RETRIEVAL_DOCUMENT` for chunks,
`RETRIEVAL_QUERY` for queries); `gemini-embedding-2` has no task type and takes a `title: ... | text: ...`
document prefix and a `task: search result | query: ...` query prefix. Truncated vectors are L2-normalized.
The key is read by environment-variable name: `GEMINI_API_KEY` is the free-tier key and is **public-corpus
only**; `--corpus private` needs a paid project's key in `GEMINI_API_KEY_PAID` (a distinct value) and the
harness refuses otherwise. An empty `GEMINI_API_KEY` exported in the shell shadows `bun --env-file`; start bun
under `env -u GEMINI_API_KEY`. Chunks of paths matched by `egress.excludePaths` are never embedded.

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

## Public multi-shape suite (`corpora/`)

Fetchable corpora of three more shapes (code documentation, a Chinese personal garden, generated multi-hop
chains), each pinned by commit and content digest, with output-derived golden sets and planned power.
Fetch, verify and regenerate commands, licences and the golden-set recipe are in
[`corpora/README.md`](./corpora/README.md); the shape statistics, n, MDE table and the one harness smoke
result are in [`docs/EVALUATION.md`](../../../docs/EVALUATION.md) ("Multi-shape suite"). Score a fetched
corpus with `run.ts` like any other vault, using its config and `corpora/golden/<name>.json`.

## `retrieval.cache` harness (`query-cache.ts`)

Cache ON versus OFF through the real tool dispatch path, on a COPY of an index (it bumps the vault
generation and writes ACL path sets, so never point it at a live `cacheDir`):

```
bun eval/query-cache.ts <config.json> <golden-set> --query-vecs <vecs.json> --mode latency|isolation|bump|memory|embed --json out.json
     [--tool vault_graph_search|search_and_read|vault_context] [--repeat-rate 0.3] [--distinct 250] [--reps 5] [--embed stub|live]
```

`latency` replays a seeded stream (`query-cache-lib.ts` `buildStream`: exact repeat fraction, repeats
within the LRU window) per arm with the arms alternating order, and compares every ON response to the
OFF response byte for byte, naming the top-level keys that differ. `isolation` interleaves an
unrestricted and a folder-restricted caller on one shared cache; `bump` bumps the generation between
replays. Both replay modes automatically size the cache to retain their full first-pass working set;
an explicit `--cache-entries` smaller than that set is rejected instead of producing a vacuous
zero-hit replay. `memory` reports bytes per cached entry at `final_top_k` 10/30/100 and the heap held at the
shipped `maxEntries`. `--embed stub` answers query embeddings from `--query-vecs` (cost ~0 in both arms,
so the win shown is the DB and fusion work alone); `live` calls the configured provider.
`knowledge_search` cannot be driven here (it only serves a docs-kind vault). The artifact is recordable
with `history.ts record`; it holds no query text or note paths. The measured decision for the shipped
default is in `docs/design/search-indexing-and-cache.md`.

## Write-ergonomics harness (`write-ergonomics/`)

How well REAL LLM clients (Claude Code, Codex) write, fix and edit notes through the server, over stdio
with the client spawning it. It is not a retrieval eval: the unit is a task ("fix the typo in Plan.md",
"move this note", "edit a note that changed underneath you"), the verdict is a deterministic checker over
the resulting vault files, and the output is friction (extra calls, errors, whether each error told the
model what to do, tokens, wall time). 28 tasks in two arms: `main` (trusted-local defaults) and
`hardened` (`acl.readPaths`/`writePaths` whitelist plus `writes.requireCas`).

```bash
bun eval/write-ergonomics/template.ts <root>          # corpus copy + seeded notes + warm cache, once
bun eval/write-ergonomics/run.ts --root <root> --client claude [--tasks a,b] [--arm hardened] [--rep 2]
bun eval/write-ergonomics/run.ts --root <root> --client codex
bun eval/write-ergonomics/analyze.ts --root <root> --out results.json --tables tables.md --artifact art.json
bun eval/history.ts record art.json --label write-ergonomics
```

- A logging proxy (`tap-proxy.ts`) sits between the client and the server, so both clients are measured
  from the same wire record (effective tool name unwrapped from `call_capability`, error code, recovery
  text, latency). It can also mutate a vault file after the Nth matching response, which is how a note
  is made to change underneath the model (the compare-and-swap path) without racing it.
- Each trial copies the template vault and cache to one fixed path (the index records the vault path)
  and archives the post-run state under `<root>/runs/<arm>/<client>/<task>__r<N>/`; runs are never
  overwritten and nothing is deleted. Tasks marked `approved` state the user's approval and let the
  client run `obsidian-tc elicit`, the stand-in for a human confirming a HITL prompt.
- The Codex login is copied into a private temp dir for the run and removed afterwards; only the
  secret-free `codex-config.toml` is archived.
- `test/write-ergonomics-harness.test.ts` needs no client: every checker must fail on the wrong state
  and pass on a reference outcome. It is the check to run after editing `tasks.ts`.
- `analyze.ts --artifact` emits a file `history.ts record` accepts by the same structural re-use
  `search-and-read-cost.ts` documents: `baseline` is the first client and `graph` the second;
  recall@10 is task success, mrr@10 call efficiency against `refCalls`, ndcg@10 first-try-clean. Read
  those columns as that mapping, not as retrieval quality.

### Facade-mode study (`--facade`, `--task-set facade`, `facade-analyze.ts`)

The same harness, pointed at the question "which `toolFacade.mode` should each client use". The three
modes (`triad`, `domain`, `flat`) are a run-time flag (`run.ts --facade`), the tap proxy unwraps a
domain meta-tool call (`links` + `action: get_backlinks`) to the capability it names, and the task set
is 16 tasks: six write tasks that begin with a find step plus ten read-and-answer discovery tasks
(`DISCOVERY_TASKS` in `tasks.ts`, seeded under `Discovery/` in `fixtures.ts`).

```bash
bun eval/write-ergonomics/template.ts <root> --omit "Inbox/Messy frontmatter.md"
bun eval/write-ergonomics/run.ts --root <root> --client claude --facade flat --claude-tool-search \
    --task-set facade --rep 1 --runs runs/flat
bun eval/write-ergonomics/facade-analyze.ts --root <root> --tables tables.md --out results.json \
    --artifact-prefix hist --task-set task-set.yaml     # then history.ts record each hist-*.json
```

- `--claude-tool-search` keeps Claude Code's built-in `ToolSearch`, so MCP tools are deferred as in a
  default install. Without it the harness removes every built-in tool, which makes Claude Code load all
  MCP definitions upfront: that is NOT what users get, and the earlier write-ergonomics runs used it.
- The broken-YAML seed is left out of the template (`--omit`): it makes vault-wide reads fail, which
  swamps a comparison between facade modes.
- `facade-analyze.ts` implements the decision rule written down before the runs (tie band of 2 trials,
  default kept unless beaten by more than the band, partial cells undecided) and the artifacts it writes
  are `history.ts`-recordable, one per client with `baseline = triad`, `graph = domain|flat`.
- Metrics beyond the write-ergonomics ones: calls-to-success (server calls plus client tool-search
  calls), tool-not-found (server `unknown tool` plus the client's own "no such tool" for an obsidian-tc
  tool; a disabled built-in does not count).

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
