# Dark retrieval mechanisms: inventory

A **dark** mechanism is one that is built, reachable and tested, and off by default. This file lists
every one the config schema or the search code exposes, with the config key that turns it on, the
storage it owns, the outside service it needs, and the A/B result on the public record. It is the
inventory half of relocating the dark mechanisms out of the default code path; it changes no default.

Two things it is **not**: a recommendation to flip anything, and a measurement. The evidence column
quotes [`EVALUATION.md`](./EVALUATION.md) and [ADR 0007](./adr/0007-default-promotion-requires-multi-shape-evidence.md)
and the eval README; where those hold no number, the cell says so rather than borrowing one from
elsewhere. `test/dark-mechanisms-doc.test.ts` keeps the list honest in both directions: every
default-off retrieval flag in the generated config schema must be named here, and every config key
named here must still exist in the schema.

**How to read the evidence.** The only shapes with recorded results are **private multi-hop** (one
personal ~1,150-note English vault, n=250, bridge-labelled; its minimum detectable effect on nDCG@10
is 0.035) and the public **evergreen** corpus (Matuschak notes, English, n=78 under two label sets,
MDE 0.065 strict and 0.043 lenient). ADR 0007 asks for three or more shapes before a judgment
mechanism earns a default, so no row below could flip on today's evidence. The suite built to supply
the missing shapes is in [`packages/server/eval/corpora/`](../packages/server/eval/corpora/README.md).
Since 2026-10-04 the **recorded A/B** and **shapes tested** cells also carry the multi-shape matrix
([`EVALUATION.md`](./EVALUATION.md), "Multi-shape suite, part 2"): evergreen, quartz-docs, knowledge-garden and
synthetic-multihop, each arm judged against the preregistered MDE (WIN, LOSS, TIE; "inert" where no query's
ranking changed). The synthetic cells are templated-query artifacts and carry no mechanism claim. Rows 1, 2,
5, 10, 20, 21, 22, 24 and 26 were not run, and the reranker re-test (rows 3, 4) is pending.

## Summary

| # | mechanism | config key | needs | recorded A/B | shapes tested |
| ---: | --- | --- | --- | --- | --- |
| 1 | learned-sparse stream | `retrieval.sparse` | multi-vector encoder | none on record; pending (encoder) | none |
| 2 | ColBERT late-interaction rerank | `retrieval.colbert` | multi-vector encoder | none on record; pending (encoder) | none |
| 3 | gated cross-encoder rerank | `retrieval.gatedRerank` | reranker backend | null; TIE on 3 new shapes (inert on 1) | private multi-hop, evergreen, quartz-docs, knowledge-garden |
| 4 | reranker passage format | `reranker.passageFormat` | reranker backend | win or tie, opt-in; new shapes pending (GPU) | evergreen, private multi-hop |
| 5 | LLM-inferred edges | `retrieval.densify.llmEdges` | inference gateway | none on record; not run (spend) | none |
| 6 | kNN edges | `retrieval.densify.knnEdges` | none | null; fails floor on evergreen strict; TIE on 4 new shapes | private multi-hop, evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 7 | shared-tag edges | `retrieval.densify.tagEdges` | none | null; inert on 3 new shapes, TIE on quartz-docs | private multi-hop, quartz-docs |
| 8 | derived edges in the walk | `retrieval.densify.includeInWalk` | edges 5 to 7 | the toggle behind rows 6 and 7 | private multi-hop |
| 9 | convex fusion | none (search option) | none | LOSS on 2 new shapes, TIE on 2 | quartz-docs, knowledge-garden, evergreen, synthetic-multihop |
| 10 | query decomposition | none (eval flag, prompt) | local LLM for the flag | none on record; not run | none |
| 11 | multi-query fan-out | `query_variants` tool argument | none | loss; LOSS on 3 new shapes, WIN on synthetic (artifact) | private multi-hop, evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 12 | MMR final pick | none (search option) | none | TIE on 4 new shapes | evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 13 | cluster-diversity cap | none (search option) | offline clustering | "negative at every k", no figures; TIE on 3 new shapes, WIN on synthetic (artifact) | private multi-hop, evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 14 | class router | `retrieval.classRouter` | none | tie, below MDE; TIE on 2 new shapes, inert on evergreen, WIN on synthetic (artifact) | private multi-hop, quartz-docs, knowledge-garden, synthetic-multihop |
| 15 | z-margin router | none (search option) | none | TIE on 4 new shapes | evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 16 | adaptive RRF | `retrieval.adaptiveRrf.enabled` | none | TIE on 4 new shapes | evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 17 | capped graph-expansion stream | `retrieval.graphStream.enabled` | none | neutral, non-inferior; TIE on 3 new shapes (inert on 1) | private multi-hop, evergreen, quartz-docs, knowledge-garden |
| 18 | smooth expansion scoring | none (search option) | none | TIE on 4 new shapes | evergreen, quartz-docs, knowledge-garden, synthetic-multihop |
| 19 | metadata prior | `ranking.metadataPrior.enabled` | frontmatter rules | inert on 4 new shapes | none with an effect |
| 20 | activation rerank and bubble pass | `experiential.activationRerank` | experiential store | none on public record; not run | none |
| 21 | note summaries | `retrieval.summaries.enabled` | inference gateway | none; not run | none |
| 22 | cluster summaries | `retrieval.summaries.clusters.enabled` | inference gateway, clustering | none; not run | none |
| 23 | derived defaults (`rrfK`) | `retrieval.derivedDefaults` | none | parity; inert (identical) on 4 new shapes | evergreen, private multi-hop, quartz-docs, knowledge-garden, synthetic-multihop |
| 24 | search-mode preference reader | `retrieval.useSearchModePreference` | experiential store | catastrophic loss; not run on new shapes | evergreen, private multi-hop |
| 25 | `auto` routes beyond text-first | `retrieval.searchAutoRoute` | embeddings provider | helps on evergreen, no-op on private; text-first WIN on 2 new shapes, hybrid and weak-text TIE or inert | evergreen, private multi-hop, quartz-docs, knowledge-garden, synthetic-multihop |
| 26 | query-product cache | `retrieval.cache.enabled` | none | results identical; latency only; not run on new shapes | private (15.9k chunks) |

## Per mechanism

### 1. Learned-sparse stream

- **Key:** `retrieval.sparse` (default `false`). Eval flag `--sparse`.
- **Storage:** `chunk_sparse` (`chunk_id`, `vault_id`, `weights_packed`), created on demand in `cache.db` and
  written at index time only when the embeddings provider returns the sparse head.
- **Outside dependency:** a bge-m3 multi-vector encoder. Either the Python `services/bge-m3-service`
  (`POST /v1/encode`, all three heads in one call) behind `embeddings.provider: model-tier`, or a vLLM
  pooling server behind `provider: bge-m3`. One vLLM server cannot serve all three heads, so there the
  sparse head degrades to empty and the stream is a silent no-op; the eval's flag-liveness check refuses
  to run `--sparse` against such a provider.
- **A/B on record:** none. `docs/src/content/docs/roadmap.md` and `ARCHITECTURE.md` say the numbers are
  recorded in this evaluation document; they are not (see [Gaps](#gaps-found-while-writing-this)).
- **Multi-shape (2026-10-04):** not run. Pending: needs the bge-m3 multi-vector encoder. Shapes tested: none.

### 2. ColBERT late-interaction rerank

- **Key:** `retrieval.colbert` (default `false`). Spike script `eval/colbert_spike.ts`.
- **Storage:** `chunk_colbert` (`chunk_id`, `vault_id`, `vectors`), on demand, read only for the fused top-K.
- **Outside dependency:** the same multi-vector encoder as row 1. The scorer in `search/colbert.ts` is a
  JavaScript max-sim, not a PLAID index; the workload-partition plan records real late interaction as
  needing the model and a GPU.
- **A/B on record:** none.
- **Multi-shape (2026-10-04):** not run. Pending: needs the bge-m3 multi-vector encoder. Shapes tested: none.

### 3. Gated cross-encoder rerank

- **Keys:** `retrieval.gatedRerank` (default `false`), `retrieval.gatedRerankHardness.{mode,hardTop1,hardZ,pool}`
  (defaults `cosine`, 0.55, 1.0, 20), plus a `reranker` block. Eval flag `--gated-rerank`.
- **Storage:** none.
- **Outside dependency:** a reranker: the model-tier BGE cross-encoder, a gateway `/rerank` passthrough, any
  Cohere-format endpoint, or the bundled int8 MiniLM from the optional `reranker-local` package.
- **A/B on record** (eval README, "gatedRerank hardness"): private multi-hop, n=250, MDE 0.009. `cosine@0.55`
  against off: nDCG@10 +0.002 (p 0.63), recall and bridge +0.000. `zMargin@1.0` against off is byte-identical on
  every metric: the dense seed pool's z-margin has a floor of 1.57 on bge-m3, so a threshold of 1.0 never fires.
  A well-powered null, so the flag stays off.
- **Ungated reranking** over the dense top-30 (ADR 0007, 2026-10-02): every raw-chunk arm loses on the evergreen
  strict labels (-0.08 to -0.21 nDCG@10, called catastrophic) and on private multi-hop (-0.05 to -0.09).
- **Multi-shape (2026-10-04):** `cosine@0.55` against off is a TIE on evergreen (-0.009), quartz-docs (-0.006) and knowledge-garden (-0.008), and inert on synthetic-multihop (0 queries changed). Shapes tested: 3 new, plus 1 inert. The ungated reranker re-test on the new shapes is pending (GPU).

### 4. Reranker passage format

- **Key:** `reranker.passageFormat`, `chunk` (default when unset) or `title+chunk`.
- **Storage / dependency:** none of its own; it changes the text a configured reranker sees.
- **A/B on record** (ADR 0007, 2026-10-03, pre-registered): the title-prefixed passage stops losing. Local MiniLM
  wins on evergreen strict and lenient and ties on private multi-hop; DeepInfra Qwen3-0.6B wins on private
  (+0.033) but is underpowered on evergreen. Two English shapes, queries the variant was formed on, so ADR 0007
  keeps the default at `chunk`.
- **Multi-shape (2026-10-04):** not run on the new shapes; part of the pending reranker re-test (GPU). Shapes tested: none new.

### 5. LLM-inferred edges

- **Key:** `retrieval.densify.llmEdges` (default `false`), `confidenceFloor` 0.55.
- **Storage:** `vault_edges` rows with `edge_type = 'semantically_similar_to'`, plus the `confidence` and
  `source_fingerprint` columns added for derived edges.
- **Outside dependency:** the configured inference gateway, batch only. Note text leaves the machine, so it is
  subject to `egress.excludePaths`.
- **A/B on record:** none. The densification study measured rows 6 and 7 only.
- **Multi-shape (2026-10-04):** not run: `densify-llm` needs the metered `extract` model, which is new spend. Shapes tested: none.

### 6. kNN edges

- **Keys:** `retrieval.densify.knnEdges` (default `false`), `knnK` 8, `knnMinSim` 0.
- **Storage:** `vault_edges` rows with `edge_type = 'similar_to'`, built from the existing `vec_chunks` neighbours.
- **Outside dependency:** none.
- **A/B on record** (EVALUATION.md, "Deterministic edge densification"; each arm is its own
  control): private multi-hop, n=250, 103 bridge queries. Floors 0.0, 0.6 and 0.8: nDCG@10 -0.002, bridge recall
  -0.008, -0.008 and +0.000 (p 0.73 to 1.0). Re-measured on the decontaminated vault: -0.0015 (p 0.63). On the
  public evergreen corpus the floor-0.0 arm **fails** the -0.015 non-inferiority floor on strict labels
  (-0.009, lower bound -0.026).
- **Multi-shape (2026-10-04):** TIE on all four: evergreen -0.009, quartz-docs +0.000, knowledge-garden -0.003, synthetic-multihop -0.020 (sig, sub-MDE). On evergreen strict the interval is [-0.026, +0.000] (n=78), the same lower end as the earlier floor-0.0 record. Shapes tested: 4.

### 7. Shared-tag edges

- **Keys:** `retrieval.densify.tagEdges` (default `false`), `maxTagFanout` 25.
- **Storage:** `vault_edges` rows with `edge_type = 'shared_tag'`. **Outside dependency:** none (6.5 s to build).
- **A/B on record:** private multi-hop, n=250: nDCG@10 -0.002, bridge recall +0.000 (p 1.0), 30 queries reordered;
  re-measured -0.0009 (p 0.76). Not run on evergreen.
- **Multi-shape (2026-10-04):** inert on evergreen, knowledge-garden and synthetic-multihop (no tags, so no edges were built); TIE on quartz-docs (-0.003, 5 queries changed). Shapes with an effect to measure: 1.

### 8. Derived edges in the walk

- **Key:** `retrieval.densify.includeInWalk` (default `false`), `derivedWeight` 0.5.
- This is the switch rows 6 and 7 are measured through: edges 5 to 7 are built either way and only this flag
  lets the graph walk traverse them.
- **Multi-shape (2026-10-04):** the same runs as rows 6 and 7 (`DENSIFY=1` on an edge-built index copy); no separate verdict.

### 9. Convex fusion

- **Key:** none. `fusionMode: "convex"` on the search options (alpha 0.7), eval flags `--fusion convex` and
  `CONVEX_ALPHA`. No running server sets it, so it is reachable only from the harness.
- **Storage / dependency:** none. **A/B on record:** none; the release note that added it says "pending its A/B
  against RRF k=10".
- **Multi-shape (2026-10-04):** LOSS on quartz-docs (-0.076) and knowledge-garden (-0.106); TIE on evergreen (-0.018) and synthetic-multihop (-0.018, sig, sub-MDE). Shapes tested: 4. Two LOSS cells, no WIN.

### 10. Query decomposition

- **Key:** none. Eval flag `--decompose` splits z-hard queries into two or three sub-queries with a small local
  instruct model (`DECOMPOSE_URL`, default an Ollama daemon on `llama3.2:3b`) and merges by RRF. The Ollama
  backend was removed from the stack on 2026-07-31, so the flag-liveness check refuses to run it unless the
  variable points at a live backend. The product-side counterpart is the `decompose_and_research` MCP prompt, where
  the client's own model does the decomposing.
- **A/B on record:** none for the spike. See row 11 for the fan-out the prompt can drive.
- **Multi-shape (2026-10-04):** not run: the local LLM backend was removed 2026-07-31. Shapes tested: none.

### 11. Multi-query fan-out

- **Key:** none in config; the caller passes `query_variants` to `vault_graph_search`. Off unless they do.
- **A/B on record** (EVALUATION.md, "Multi-query fan-out"): private multi-hop, n=250, three phrasings against single
  query, paired: nDCG@10 -0.047 (p 0.0004), MRR@10 -0.063, recall@10 -0.002 (not significant). The same documents
  in a worse order. Re-measured on the decontaminated vault: -0.0396 (p 0.0011). Not run on evergreen.
- **Multi-shape (2026-10-04):** LOSS on evergreen (-0.197), quartz-docs (-0.201) and knowledge-garden (-0.280), paired against a path-deduped control; WIN on synthetic-multihop (+0.149), a templated-query artifact (the same signature as rows 13 and 14 on that corpus). Shapes tested: 4.

### 12. MMR final pick

- **Key:** none. `diversify.mmr` (`lambda` 0.7) on the search options, eval flag `--mmr`.
- **Storage / dependency:** none. **A/B on record:** none.
- **Multi-shape (2026-10-04):** TIE on all four (knowledge-garden -0.005 is significant and below the MDE). Shapes tested: 4.

### 13. Cluster-diversity cap

- **Key:** none. `maxPerCluster` on the search options, eval flag `--max-per-cluster`. Needs the offline
  `obsidian-tc cluster` pass, which fills `chunks.cluster_id`; on an unclustered index the harness refuses.
- **A/B on record:** EVALUATION.md says "measured negative at every k tested" and gives no table.
- **Multi-shape (2026-10-04):** TIE on evergreen (-0.028, sig, sub-MDE), quartz-docs (-0.013) and knowledge-garden (-0.022, BH-significant, below the MDE); WIN on synthetic-multihop (+0.162), a templated-query artifact. `--max-per-cluster 2`, k = round(sqrt(chunks)). Shapes tested: 4.

### 14. Class router

- **Key:** `retrieval.classRouter` (default `false`): a temporal auto-stream plus a lexical short-circuit that
  skips the embedding round trip. Eval flags `--class-router` and `--temporal`.
- **Storage / dependency:** none of its own; it reads the existing text index.
- **A/B on record** (ADR 0007, 2026-10-02 re-measure): private multi-hop, n=250. Router arm 0.7712 on the old index
  copy and 0.7770 on the decontaminated copy, against the default path 0.7696 and 0.7740: within 0.004, far below
  the 0.035 MDE. No per-class aggregate is recorded on the public side.
- **Multi-shape (2026-10-04):** inert on evergreen; TIE on quartz-docs (-0.009) and knowledge-garden (+0.001); WIN on synthetic-multihop (+0.207), a templated-query artifact (likely because the lexical short-circuit meets queries whose minted token appears in the seed and target note; not diagnosed further), not a general win. Shapes tested: 4, with 1 inert and 1 artifact.

### 15. z-margin router

- **Key:** none. `router.zThreshold` on the search options skips graph expansion on a confident dense lock; eval
  flag `--z-router`. **A/B on record:** none.
- **Multi-shape (2026-10-04):** TIE on all four, threshold 2.66 fixed in advance (synthetic-multihop +0.018 is sig, sub-MDE). Shapes tested: 4.

### 16. Adaptive RRF

- **Keys:** `retrieval.adaptiveRrf.enabled` (default `false`), `gain` 0.5. Eval flag `--adaptive-rrf`.
- **Storage / dependency:** none (uses lexical specificity from the text index). **A/B on record:** none.
- **Multi-shape (2026-10-04):** TIE on all four (quartz-docs -0.013 is sig, sub-MDE). Shapes tested: 4.

### 17. Capped graph-expansion stream

- **Keys:** `retrieval.graphStream.enabled` (default `false`), `expansionSeeds` 8, `perSeedCap` 3, `hubDegreeCap` 40.
- **A/B on record** (config schema description): private multi-hop, n=250: 0 of 8 metrics significant after
  Benjamini-Hochberg, non-inferior on nDCG@10 (lower bound -0.002 against the -0.015 floor); it removes about 22%
  of the expansion candidate pool. A cost lever, corpus-specific.
- **Multi-shape (2026-10-04):** TIE on evergreen (-0.007), quartz-docs (-0.005) and knowledge-garden (+0.000); inert on synthetic-multihop. Shapes tested: 3 plus 1 inert.

### 18. Smooth expansion scoring

- **Key:** none. `smoothExpansion` (`lambda` 0.8, `hubMu` 75, `hubGamma` 6) on the search options.
- **A/B on record:** none; the release note says "pending its A/B". Its defaults were tuned on the private vault.
- **Multi-shape (2026-10-04):** TIE on all four (knowledge-garden +0.003 is sig, sub-MDE). Shapes tested: 4.

### 19. Metadata prior

- **Keys:** `ranking.metadataPrior.enabled` (default `false`), `rules`, `clampFraction` 0.5. Eval flag
  `--metadata-prior`. **Storage / dependency:** none (reads frontmatter). **A/B on record:** none.
- **Multi-shape (2026-10-04):** inert on all four corpora (none carries the frontmatter the representative rule set reads); no verdict on the mechanism. Shapes tested: none with an effect.

### 20. Activation rerank and bounded bubble pass

- **Key:** `experiential.activationRerank` (default `false`); `experiential.activationDecay` sets the decay.
  Eval flags `--activation` and `--bubble-safe`, which the harness requires together.
- **Storage:** the experiential store (`chunk_retrievals`, `activation_state`) and the cached scores the offline
  activation-recompute pass writes. Inert without recorded retrievals.
- **A/B on record:** none in this repo's docs. The pre-registered paired test (nDCG@10 gain of at least 0.010 after
  Benjamini-Hochberg) has artifacts under the eval data directory but no write-up here.
- **Multi-shape (2026-10-04):** not run: no public corpus has recorded retrieval history. Shapes tested: none.

### 21 and 22. Note and cluster summaries

- **Keys:** `retrieval.summaries.enabled`, `retrieval.summaries.clusters.enabled` (both `false`).
- **Storage:** `note_summaries`; `cluster_summaries` and `cluster_summary_members`.
- **Outside dependency:** the inference gateway (summary extraction) and the embeddings provider; clusters also
  need the offline cluster pass.
- **A/B on record:** none. The mechanism is gated on a pre-registered global-query eval, and the canonical n=250
  set holds no global queries.
- **Multi-shape (2026-10-04):** not run: gated on a global-query eval and the public golden sets hold no global query. Shapes tested: none.

### 23. Derived defaults

- **Key:** `retrieval.derivedDefaults` (default `false`): `rrfK` derived from the vault's chunk count.
- **A/B on record** (ADR 0007, class (b)): evergreen strict and lenient, private multi-hop: identical to the
  constant (every vault with 30 or more chunks derives `k = 10`). On constructed 6- and 10-note vaults the
  derived `k` reordered 20 of 188 queries and moved no metric (nDCG@10 at its 0.995 to 0.997 ceiling). Parity,
  not effectiveness.
- **Multi-shape (2026-10-04):** inert (identical to the constant) on all four corpora: every index above 30 chunks derives `rrfK` 10. Parity, not effectiveness. Shapes tested: 4 for parity.

### 24. Search-mode preference reader

- **Key:** `retrieval.useSearchModePreference` (default `false`); needs the experiential store.
- **A/B on record** (ADR 0007, class (c)): forced `text` is worse on every query it changes. Evergreen strict
  0.8491 to 0.2543; private multi-hop 0.7515 to 0.0000 on the decontaminated copy; lower bounds far below the
  -0.015 floor.
- **Multi-shape (2026-10-04):** not run: needs recorded retrieval history. Shapes tested: none new.

### 25. `auto` routes beyond text-first

- **Key:** `retrieval.searchAutoRoute`, `text-first` (default), `weak-text` or `hybrid`.
- **Outside dependency:** the embeddings provider, which now sees query text that `text-first` answers locally.
- **A/B on record** (ADR 0007, 2026-10-01): evergreen strict `hybrid` +0.037 nDCG@10 (p 0.049, below its 0.065
  MDE), lenient +0.028 (p 0.010). On the decontaminated private vault all three routes are identical (the text
  leg returns nothing), so the mechanism is a no-op there.
- **Multi-shape (2026-10-04):** against `text-first`: `hybrid` is a TIE on evergreen (+0.037, sig, sub-MDE), quartz-docs (+0.018) and knowledge-garden (+0.006) and inert on synthetic-multihop; `weak-text` is inert on three corpora and a TIE on knowledge-garden (-0.002). `text-first` itself against dense `search_semantic`: WIN on knowledge-garden (+0.133) and quartz-docs (+0.064), TIE on evergreen (-0.019), inert on synthetic-multihop. Shapes tested: 4.

### 26. Query-product cache

- **Keys:** `retrieval.cache.enabled` (default `false`), `maxEntries` 64, `ttlSeconds` 60.
- **Storage:** in-process only. A latency optimisation, not a ranking change.
- **A/B on record** (config schema description, `docs/design/search-indexing-and-cache.md`): results byte-identical
  to cache-off; a hit answers in about 1 to 4 ms against about 850 ms; a hit omits `coverage` from the
  `vault_graph_search` response, and the live store showed one repeated call in 251.

## What the multi-shape suite can test

The suite corpora differ in the ways ADR 0007 names (language, size, link density, document length); their shape
statistics are in [`packages/server/eval/corpora/README.md`](../packages/server/eval/corpora/README.md).

| needs | rows | quartz-docs (code docs) | knowledge-garden (CJK) | synthetic-multihop | evergreen |
| --- | --- | --- | --- | --- | --- |
| nothing beyond dense + BM25 + links | 6, 7, 8, 12 to 19, 23, 26 | yes | yes | yes | yes |
| bridge-labelled queries | 5 to 8, 17 | 10 bridge queries | 30 bridge queries | 120 chains | none |
| multi-vector encoder (`model-tier`) | 1, 2 | yes | yes | yes | yes |
| reranker backend | 3, 4 | yes | yes | yes | yes |
| inference gateway (text leaves the box) | 5, 21, 22 | MIT text | MIT text | generated text | public text |
| experiential store with recorded use | 20, 24 | no | no | no | no |

Rows 20 and 24 need recorded usage the public corpora do not have, so they stay measurable on the private vault
only.

## Gaps found while writing this

- `docs/src/content/docs/roadmap.md` and `ARCHITECTURE.md` say the numbers for learned sparse, ColBERT, convex
  fusion, query decomposition, MMR and the class router "are recorded in the evaluation notes". For the first five
  there is no number in `EVALUATION.md`, the ADR or the eval README. Rows 1, 2, 9, 10, 12 say "none on record"
  rather than inherit that claim.
- Rows 13, 16 and 19 are described as measured ("negative at every k", "an already-measured lever") with no
  figures on the public side.
- Rows 9, 10, 12, 13, 15 and 18 have no config key at all: a running server cannot turn them on, only the eval
  harness or a caller-supplied argument can.
- **Multi-shape (2026-10-04):** not run: it changes latency, not ranking. Shapes tested: none.

