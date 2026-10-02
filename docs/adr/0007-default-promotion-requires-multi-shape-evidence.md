# Default promotion requires multi-shape evidence; single-vault wins ship as preset evidence

ADR 0003 governs what happens when a mechanism *loses*: it ships dark, reachable, with its numbers
on the ticket. Nothing in this project ever governed what happens when a mechanism *wins* — every
flag that clears the non-inferiority gate has defaulted ON project-wide off a single golden set
measured against one private ~1,150-note personal vault. That asymmetry is the gap this ADR closes.
A ship rule that audits losses this carefully and lets wins through unaudited is not a stricter gate,
it is a gate with one open side.

**A single-collection win is not general evidence, and the field has known this for a while.**
BEIR's own contribution was showing that retrievers ranked on one collection routinely reorder on
the next — there is no universal winner across its corpora, only per-shape ones. Armstrong et al.
(CIKM 2009) found ad-hoc retrieval "improvements" published against a single TREC collection
frequently failed to beat a strong baseline once compared honestly across collections. Fuhr (SIGIR
Forum 2017) named the underlying failure mode directly: a significance test answers "is this real on
*this* sample," never "does this generalize," and treating the two as the same question is how a
field accumulates findings that do not replicate. None of this is a knock on the harness in
`packages/server/eval/` — its statistics are sound for the question it asks. The problem is the
question a single vault can answer at all.

**Production search engines have already converged on the fix, and it is not "measure harder."**
Elasticsearch, Qdrant and Vespa all ship RRF with a fixed rank constant, opt-in re-ranking and fusion
knobs, and eval tooling handed to the operator rather than baked into the product's own defaults.
The pattern is: ship the flat-optimum constant everywhere, gate anything corpus-shaped behind an
opt-in, and let the deployer measure their own collection instead of inheriting the vendor's. That
is the shape this ADR adopts.

**Three classes of flag, three different evidence bars.**

*(a) Corpus-insensitive mechanisms* — flat-optimum constants whose behavior does not meaningfully
change with corpus shape — may default ON on single-vault evidence. RRF's rank constant is the
textbook case: the folklore k=60 is documented as insensitive enough that Elasticsearch, Qdrant and
Vespa all ship it unconditionally, with no per-corpus tuning path. Note what this class does *not*
cover: `graph_search.ts`'s own `rrfK=10` default (THE-397) is not this project's example of class
(a) — its own code comment says the k=10-over-k=60 effect "appears only below the pool-size
crossover," which is a statement about pool depth, a corpus fact, not a flat optimum. It belongs in
class (b) below, mis-filed as a settled default until this ADR named the category.

*(b) Vault-fact-conditional settings* — flags whose right value depends on measurable properties of
the index (language, note count, doc-length variance, link density, retrieval-pool depth) — should
derive from those measured statistics at index time, not ship as a fixed constant tuned on one
vault's statistics and assumed portable. The mechanism for this class now exists but ships dark
(see Status below): making `rrfK` depend on measured index stats is built behind
`retrieval.derivedDefaults`, and no default has moved.

*(c) Judgment-dependent mechanisms* — everything whose ranking effect is a genuine judgment call
rather than a corpus-measurable fact — defaults OFF until it wins-or-ties on a majority of a
multi-shape eval suite: three or more corpora of different shape, size and language, with no
catastrophic loss on any of them. A single-vault win on this class does not earn a global default.
It earns a narrower, still-real claim: the mechanism is "validated on: personal-notes shape," which
qualifies it for a vault-shape preset a personal-notes user can opt into — never a flip of the
project-wide default.

**The statistical case for the floor, not just the taxonomy.** Every default-flip decision in this
project's history has been drawn from the same uncorrected α = 0.05 gate, one decision at a time.
Fifteen such gates — a plausible count for a project that has now shipped this many retrieval flags
— carry a family-wise false-flip probability of 1 − 0.95¹⁵ ≈ 53.7%: coin-flip odds that *at least
one* of the flags currently defaulted on on the strength of a single-vault win is there by chance
rather than by a real effect. The Benjamini–Hochberg control `packages/server/eval/stats.ts` already
runs (q = 0.1) covers the *within-run* family — the metrics compared in one sweep — and was never
designed to, and does not, cover the *across-experiment* family this 53.7% describes. One measured
data point makes the risk concrete rather than hypothetical: THE-397's own recorded numbers (n=32,
ΔnDCG 0.444 → 0.426, i.e. a 0.018 mean delta) sit below the ≈0.10 minimum detectable effect this
project's own harness later established as necessary at that same n. That is not grounds to flip
`rrfK` back — doing so would itself be an unaudited single-vault change, the exact move this ADR
argues against — it is grounds to be honest about what evidence a shipped default currently rests
on. Single-vault permutation tests are not devalued by this; they are demoted to the job they can
actually do reliably: **regression tests**, catching a change that breaks the measured corpus. That
was always their most valuable use; this ADR just stops asking them to also answer a generalization
question they were never powered for.

**Rollout.** No existing default flips as a result of this ADR — `rrfK=10` and every other flag
promoted on single-vault evidence keep their current setting. What changes is the label: each such
default is documented with the evidence it actually rests on (flat-optimum constant, vault-shape
preset candidate, or unaudited single-vault win awaiting the suite below), not left to read as
though it cleared a bar it never faced. The multi-shape suite itself is future work, gated on public
corpora existing to build it from. Shape #1 already exists and is in use — the Matuschak evergreen
notes corpus this project already publishes a number against (`docs/EVALUATION.md`, "Published on a
public corpus"). The two missing shapes are a code-documentation corpus and a CJK corpus; both are
named rather than merely implied because sourcing them is tracked work, referenced here in prose as
THE-884 and THE-637. Until the suite exists, no *new* mechanism is promoted to a global default off
a single-vault win — it may still ship dark per ADR 0003, or ship labeled as a personal-notes-shape
preset per class (c) above.

## Status (2026-09-30): class (b) mechanism built, dark; the evidence bar is not met

**Built.** `retrieval.derivedDefaults` (default `false`) derives `rrfK` from each vault's measured
index statistics. One resolver, `search/retrieval-defaults.ts`, replaces every hardcoded `10`
(in-query graph search, federated search, multi-query fusion, the federated tool, the retrieval-policy
record, the gap sweep, the episode fuser) with the precedence *per-call argument > explicit config >
derived (only with the flag on) > the shipped constant*. With the flag off the effective value at
every call site is the constant main shipped. The per-vault stats (chunk, note and authored-edge
counts, chunks per note, edges per note) are cached against the vault generation. The derivation is
`k = clamp(round(min(seedCount, chunkCount) * 10/30), 2, 60)`: the pool depth the constant was
measured at (30) reproduces it exactly, so every vault with at least 30 chunks derives `10` and only a
vault smaller than the seed pool differs. It is skipped for an ACL-partition-restricted caller (a
whole-vault stat steering that caller's ranking would leak the vault's size). `knnMinSim` goes
through the same resolver for its constant and its diagnostic but is **not derived**: the index
records no neighbour-similarity distribution to derive a floor from. `get_server_config` reports, per
vault, the `rrfK` in effect and which source won.

**Measured** (`eval/run.ts --derived-defaults` against the constant, same index copy, same
precomputed query vectors, paired by query id; artifacts and `runs.db` under
`/data/obsidian-tc-eval/stat-defaults/`):

| shape | chunks | n | derived k | nDCG@10 constant / derived | recall@10 | MRR@10 | queries that differ |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: |
| Matuschak evergreen, strict labels (public) | 2,986 | 78 | 10 | 0.9143 / 0.9143 | 0.9786 / 0.9786 | 0.9053 / 0.9053 | 0 |
| Matuschak evergreen, lenient labels | 2,986 | 78 | 10 | 0.6895 / 0.6895 | 0.6958 / 0.6958 | 0.9402 / 0.9402 | 0 |
| private multi-hop vault (index copy carried the contaminating note; clean copy 0.7740 / 0.7740, see 2026-10-02) | 13,746 | 250 | 10 | 0.7696 / 0.7696 | 0.8602 / 0.8602 | 0.8364 / 0.8364 | 0 |
| constructed 6-note vaults (8 subsamples of the evergreen corpus) | 13-20 | 73 | 4-7 | 0.9949 / 0.9949 | 1.0000 / 1.0000 | 0.9932 / 0.9932 | 0 (metrics) |
| constructed 10-note vaults (8 subsamples) | 18-34 | 115 | 6-10 | 0.9968 / 0.9968 | 1.0000 / 1.0000 | 0.9957 / 0.9957 | 0 (metrics) |

The two real shapes are identical under both arms for the reason the formula predicts: each vault is
past the 30-deep pool, so derivation returns the constant. That is a parity result, not an
effectiveness result. The only place the derived value differs is sub-pool vaults, and no organically
small corpus exists locally, so those are constructed subsamples (a synthetic shape, labelled as such).
On them the derived `k` changed the top-10 *order* for 20 of 188 queries and never the top-1 or the
top-10 set, and nDCG@10 sits at its ceiling (0.995 to 0.997), so the metrics cannot see it. The stated
minimum detectable effects (alpha 0.05, power 0.8) were 0.066 nDCG@10 on the strict evergreen labels,
0.043 on the lenient ones, 0.035 on the private set, and roughly 0.08 to 0.09 pooled on the tiny
vaults; every observed delta is exactly 0.

**Verdict: the class (b) evidence bar is not met, and no default is flipped.** The bar is a win or
tie on a majority of three or more corpora of different shape, size and language. Locally there are
two real shapes, both English, and they are tied only because the derivation is the identity on them.
The code-documentation and CJK corpora this ADR names are still unsourced. Nothing here recommends
flipping `retrieval.derivedDefaults` on. The mechanism stays reachable for an operator who wants to
measure their own collection, which is the pattern this ADR adopts.

## Status (2026-09-30): class (c) mechanism built, dark; it regresses, and the evidence bar is not met

**Built.** `retrieval.useSearchModePreference` (default `false`) lets `search_vault` read the caller's stored
`preferred.search_mode` when a call names no `mode`. The design, the scope rules and why extraction is not
scheduled are in `docs/design/experiential-reflection.md`. Only a stored `search_text` maps to a mode
(`text`); off is byte-identical to before (17 calls across the search tools diffed against `origin/main`).

**Measured** (`eval/search-mode.ts`: the real `search_vault` handler, mode omitted, `auto` against the reader
wired to a profile of `search_text` at the documented 3.0 threshold; same index copy and query vectors, paired
by query id; artifacts and `runs.db` under `/data/obsidian-tc-eval/search-mode-reader/`):

| shape | n | nDCG@10 auto / preference | recall@10 | MRR@10 | queries that change (all worse) | one-sided 95% lower bound on ΔnDCG@10 (floor -0.015) |
| --- | ---: | --- | --- | --- | ---: | ---: |
| Matuschak evergreen, strict labels (public) | 78 | 0.8491 / 0.2543 | 0.9359 / 0.2885 | 0.8472 / 0.2500 | 52 | -0.678 |
| Matuschak evergreen, lenient labels | 78 | 0.6266 / 0.1800 | 0.6345 / 0.1814 | 0.8694 / 0.2547 | 53 | -0.514 |
| private multi-hop vault (CONTAMINATED and path-bug deflated, see corrections below and the 2026-10-02 status) | 250 | 0.1009 / 0.0000 | 0.1083 / 0.0000 | 0.1123 / 0.0000 | 32 | -0.130 |

The arms are identical wherever the text leg finds a hit, and `auto` only falls back to the semantic leg when it
finds none; forcing `text` removes that fallback, so every change is a loss (0 queries improve on any corpus,
permutation p 0.0001 throughout). The stated minimum detectable effects (0.065, 0.043 and 0.035 nDCG@10) are far
below the observed deltas. The profile is constructed because the eval corpora carry no episodes; to see how
often a realistic profile makes the reader fire, the production extractor was run over a copy of the live
store's recorded episodes: one caller partition, `search_text`, weight 1.5 after one run (below the threshold)
and 5.0 after five, because extraction re-counts unchanged evidence (a cron of `obsidian-tc reflect` would
reach the threshold with no new evidence).

**Verdict: the class (c) evidence bar is not met, and the mechanism loses on the two shapes that exist locally.**
Two English shapes are fewer than the three the bar asks for, and the preference arm is a catastrophic loss on
all of them. The flag stays off, per the ADR 0003 pattern for a mechanism that loses. A side observation for
follow-up: `auto` itself scores well below dense-only `search_semantic` on the private vault (0.1009 against
0.4005 nDCG@10) because a text-leg hit, however irrelevant, prevents the semantic fallback.

**Correction (2026-10-01): the private multi-hop row above is contaminated.** All 94 text-routed `auto` queries hit
one note, a decision note in the private vault that quotes the golden-set candidates verbatim, so the 0.1009 is a
self-reference artifact, not a property of `auto`. With that note moved out of the indexed tree (and dropped from a
copy of the same index) every one of the 250 queries falls through to the semantic leg: `auto` scores 0.4016 nDCG@10
(recall@10 0.4523, MRR@10 0.4284), identical to dense-only search, and the forced-`text` preference arm still scores
0.0000 (no query is quoted anywhere, so the text leg returns nothing). The direction of the verdict stands; the private
`auto` figure and the "0.1009 against 0.4005" observation do not. The two public rows are unaffected (evergreen corpus
carries no such note). Numbers and artifacts: `/data/obsidian-tc-eval/golden-contamination-20261001/`. Eval runs now
refuse a vault in this state (`eval/golden-guard.ts`).

## Status (2026-10-01): class (c) mechanism built, dark; it helps on every local corpus, and the evidence bar is not met

**Built.** `retrieval.searchAutoRoute` (default `text-first`) changes how `search_vault`'s `auto` mode treats a
string query's text hits. `text-first` is the shipped rule: run the literal whole-phrase text leg and fall back to
semantic only when it matched no note, so any text hit, however irrelevant, blocks the fallback. `weak-text` also runs
the semantic leg when the text leg matched exactly one note; `hybrid` always runs it. Both fuse the legs by reciprocal
rank over distinct notes (rrfK 10) and report `mode_used: "hybrid"`; a failing semantic leg on a query text already
answered leaves the text result. `text-first` is byte-identical to before (the same decision as the old zero-hit rule).

**Where `auto` routes today** (`eval/search-mode.ts`, text-first arm, per-query): on the evergreen corpus 24 of 78
queries stop at the text leg (short queries, median 2 tokens, whose phrase matches 1 to over 20 notes, always including
an expected note) and 54 fall back to semantic. On the private multi-hop vault 94 of 250 stop at the text leg and 156 fall
back; every one of those 94 text hits is exactly one note, never an expected one, and it is the same note, a decision note
that quotes the golden-set candidates verbatim. The private gap against dense-only search is therefore a self-reference
artifact of the eval vault (the queries were copied into the vault they are scored on), real as a shape but inflated as a
size: with that note absent the text leg returns nothing on those queries and `auto` equals the dense ranking.

**Measured** (pre-registered before any candidate arm ran, sha256 `4c24c0dd4ba30b9a37bf62b7321384add980307a034741810a4b6db0b7f2d737`;
same index copies and query vectors, paired by query id; artifacts, `runs.db` and the per-query breakdown under
`/data/obsidian-tc-eval/search-auto-fallback/`):

| shape | n | text-first | weak-text | hybrid (nDCG@10; one-sided 95% lower bound on the delta) | queries changed (hybrid) |
| --- | ---: | --- | --- | --- | ---: |
| Matuschak evergreen, strict labels (public) | 78 | 0.8491 | 0.8491 (0 changed) | 0.8865, +0.037 (lower +0.007, p 0.049) | 9 (8 up, 1 down) |
| Matuschak evergreen, lenient labels | 78 | 0.6266 | 0.6296 (+0.003) | 0.6550, +0.028 (lower +0.010, p 0.010) | 15 (12 up, 3 down) |
| private multi-hop vault (CONTAMINATED and path-bug deflated, see corrections below and the 2026-10-02 status) | 250 | 0.1009 | 0.3609 (+0.260) | 0.3609, +0.260 (lower +0.222, p 0.0001) | 94 (all up) |

Recall@10 and MRR@10 move the same way (private: recall 0.1083 to 0.4497, MRR 0.1123 to 0.3639; strict hybrid recall
0.9359 to 0.9551, MRR 0.8472 to 0.8835). Zero-text-hit queries are identical in every arm. Fused `hybrid` stays below
dense-only search on the private vault (0.3609 against 0.4005) and above it on the evergreen text-routed queries
(0.9481 against 0.8889 strict). The stated minimum detectable effects were 0.065 (strict), 0.043 (lenient) and 0.035
(private) nDCG@10; the strict hybrid delta (+0.037) is below its MDE, so that row is underpowered rather than a
confirmed win. Predictions that missed: the evergreen `hybrid` deltas were predicted at +0.01 and about 0, and came
out at +0.037 and +0.028; `weak-text` was predicted to improve no evergreen query and improved one lenient query.

**Verdict: the class (c) evidence bar is not met, and no default is flipped.** Non-inferiority holds for both
candidates on both evergreen label sets (every one-sided lower bound is above the -0.015 floor), but the bar also asks
for a win or tie on a majority of three or more corpora of different shape, size and language, and locally there are two
real shapes, both English, one of which is contaminated (the strict and lenient sets are one corpus under two label
sets). The code-documentation and CJK corpora this ADR names are still unsourced. `hybrid` also embeds, and sends to the
embeddings provider, every string `auto` query that `text-first` answers locally, which is a cost and an egress change an
operator should choose. The flag stays off; it is the first thing to re-measure when a third shape exists.

**Correction (2026-10-01): the private multi-hop row is contaminated, and the cleaned vault carries no evidence either
way.** The single note behind the 94 text hits (a decision note quoting the golden-set candidates verbatim) was moved
out of the indexed tree and dropped from a copy of the same index (15 chunks, nothing else changed), then all three
arms were re-run with the same command shape and query vectors. On the cleaned vault no query's whole phrase appears in
any indexed note, so the text leg returns nothing for all 250 and every arm routes every query to the semantic leg:
text-first, weak-text and hybrid all score 0.4016 nDCG@10 (recall@10 0.4523, MRR@10 0.4284), identical to dense-only
search, with 0 queries changed. The +0.260 for `weak-text` and `hybrid` above, and the 0.3609 against 0.4005 gap to
dense-only, were produced by the contamination and are withdrawn. The private vault is therefore a corpus on which the
class (c) mechanism is a no-op, not one where it wins, which strengthens the verdict that the evidence bar is unmet
(the contaminated shape no longer counts as a shape with a measured win). The public evergreen rows are unaffected.
Artifacts, `runs.db` and the before/after comparison: `/data/obsidian-tc-eval/golden-contamination-20261001/`.

## Status (2026-10-02): the other private-vault evals re-measured on the decontaminated vault; no conclusion changes

The contaminating note quoted the golden queries verbatim, so every eval that ran a lexical stream on that vault was
in doubt, not only the `auto` rows corrected on 2026-10-01. The inventory is every eval that scores the private
multi-hop set (n=250) through a path with a text or BM25 leg: the `search_vault` `auto` routing evals (above), the
search-mode reader eval, the `rrfK` derivation eval, the retrieval-cache eval, and the paired contrasts recorded in
`docs/EVALUATION.md` (graph against dense, multi-query fan-out, kNN and tag edge densification). The public evergreen
corpus carries no such note, so none of its rows are in scope. `eval/run.ts` fuses a chunk-level BM25 stream
(`chunk_fts`); `eval/search-mode.ts` calls the real `search_vault` handler, whose literal text leg follows the files on
disk (the old index copy, which still carries the note, scored dense-only 0.4005 once the file was moved).
The contamination therefore reached the two harnesses differently, which is why the `auto` numbers moved by
0.30 and the `run.ts` numbers by under 0.01.

**Index state is its own variable.** Three copies of the same bge-m3 index were scored with the same code and the
same precomputed query vectors (`history.ts` keys a run on the golden set only, so each run carries its vault state in
its note):

| index copy | notes / chunks | note quoting the queries |
| --- | ---: | --- |
| old (the copy every earlier run used) | 1,182 / 13,746 | indexed |
| clean (the same copy, that note dropped with `deindexNote`) | 1,181 / 13,731 | absent |
| settled (clean, reconciled to today's vault) | 1,493 / 16,790 | absent |

**Measured** (`eval/run.ts`, paired by query id; artifacts, `runs.db` and the scripts under
`/data/obsidian-tc-eval/private-vault-remeasure-20261002/`; the `old` row reproduces the recorded 0.7471 / 0.7696):

| index copy | dense nDCG@10 | fused+graph nDCG@10 | graph minus dense (95% CI, p) | graph recall@10 | graph MRR@10 |
| --- | ---: | ---: | --- | ---: | ---: |
| old | 0.7471 | 0.7696 | +0.023 ([0.002, 0.044], 0.033) | 0.8602 | 0.8364 |
| clean | 0.7476 | 0.7740 | +0.026 ([0.006, 0.048], 0.014) | 0.8615 | 0.8387 |
| settled (a different corpus, see below) | 0.5542 | 0.5974 | +0.043 ([0.019, 0.067], 0.0005) | 0.7414 | 0.6280 |

Dropping the note changes 6 of 250 dense queries (all up, +0.0005) and 32 of 250 fused+graph queries (28 up, 4 down,
+0.0044, p 0.006): the BM25 stream had been returning that one note as a distractor. With the lexical stream off
the fused arm is 0.7099 (old) and 0.7112 (clean), so the stream is worth +0.063 on the clean copy and the
contamination had cost it about 0.004 of that. The detectable effect for these paired contrasts was stated before
running as 0.035 nDCG@10 (sigma_d 0.198 from the harness's own table, alpha 0.05, power 0.8) for a contrast
that moves most queries, and 0.0097 where few queries move (sigma_d 0.055, as in the kNN sweep); the
decontamination effect sits between the two, so it is a detectable but small shift.

| eval and recorded row | before | after (clean copy) | conclusion |
| --- | --- | --- | --- |
| `rrfK` derivation, private row (above) | constant and derived both 0.7696; 0 queries differ | both 0.7740; 0 queries differ | unchanged: parity |
| graph against dense, private corroboration (`docs/EVALUATION.md`) | +0.023 nDCG@10, p 0.033 | +0.026, p 0.014 | unchanged, slightly firmer |
| class router (lexical short-circuit) | 0.7712 | 0.7770 | unchanged: within 0.004 of the default path |
| multi-query fan-out against single query (graph nDCG@10) | -0.0373 (p 0.0025), recall +0.011 (p 0.16) | -0.0396 (p 0.0011), recall +0.012 (p 0.11) | unchanged: significant regression, same documents in a worse order |
| `tagEdges` fanout 25 against its control | nDCG -0.0018 (p 0.56), bridge recall +0.000, 30 queries reorder | nDCG -0.0009 (p 0.76), bridge recall -0.004 (p 1.0), 33 reorder | unchanged: null |
| `knnEdges` k 8 floor 0.0 against its control | nDCG -0.0017 (p 0.59), bridge recall -0.008 (p 0.73), 36 reorder | nDCG -0.0015 (p 0.63), bridge recall -0.008 (p 0.73), 37 reorder | unchanged: null |
| retrieval cache, 10% repeat stream (`docs/design/search-indexing-and-cache.md`) | repeat calls 842 / 3.7 ms p50 OFF / ON; identity gap `coverage` only; 238 of 240 queries differ across callers | 416 / 0.8 ms; same single-key gap; 236 of 240 | unchanged: stays off |
| `search_vault` `auto`, private row (corrected 2026-10-01) | 0.1009 recorded | 0.4016 (all three routes) | already withdrawn and annotated |
| forced-`text` preference arm (search-mode reader) | 0.0000 | 0.0000 | unchanged: the text leg finds nothing |

The `old` copy of the fan-out and densification contrasts reproduces the recorded figures (fan-out -0.043 to -0.047
on the earlier code; `tagEdges` 9,260 edges and 30 reordered queries; `knnEdges` 6,777 edges), so the "before" column
is a replication on the current code, not a quotation. The retrieval-cache eval is covered in
`docs/design/search-indexing-and-cache.md`.

**Verdict: no recorded conclusion changes.** The contamination was a distractor in a chunk-level BM25 stream that
cost the fused arm about 0.004 nDCG@10 and moved no contrast across its significance line or its non-inferiority
floor; it was decisive only where a literal whole-phrase text leg decides the route, which is the `auto` rows already
withdrawn. The `weak-text` and `hybrid` `auto` routes are still a no-op on the settled copy too (0.2460 for all three
routes, 0 queries changed).

**Do not compare the settled copy with the others.** Reconciling the copy to today's vault added 312 notes (about a
quarter more, mostly reference and research notes) and nothing was removed; every target path is still indexed, the
contamination guard passes (no note quotes even one query), and the code and query vectors are unchanged. Dense
nDCG@10 fell from 0.7476 to 0.5542 (190 of 250 queries changed, 36 up) and `auto` from 0.4016 to 0.2460. The golden
set was labelled against the 1,182-note vault, so notes written since are distractors for it. The clean copy stays the
like-for-like baseline for private-vault runs; a settled copy is a different corpus and any run on it must say so.
`history.ts` keys a run on the golden set, which did not change, so it cannot flag this on its own: record the index
state in the run's note.

## Status (2026-10-02): rerankers over dense top-K lose as wired; the reranker stays off

**Correction first: the private multi-hop `search-mode.ts` numbers above are deflated by a path bug, not only by
contamination.** The private golden set labels notes with Windows-style paths (204 of its 382 labelled paths carry
backslashes) while an index stores forward slashes. `eval/run.ts` and `eval/score-reranked.ts` normalized the
separators; `eval/search-mode.ts`, `eval/query-cache.ts` and `eval/search-and-read-cost.ts` did not, so every
backslash-labelled target counted as a miss. `computeQueryMetrics` (`eval/metrics.ts`) now normalizes both sides itself,
once, and a unit test pins it (`test/eval-ndcg.test.ts`, "Windows-style golden paths"). Same index copy, same query
vectors: private dense-only nDCG@10 is **0.7515** (dense top-50 pool; 0.7476 truncated to 30, the figure `run.ts`
reported for the clean copy) and production `graph_rrf` is **0.7746** (+0.023, p 0.032), not 0.4016 / 0.4005.

Which rows are affected. Unaffected: every `run.ts` row (dense 0.7471 / 0.7476 / 0.5542, fused+graph, the fan-out,
`tagEdges` and `knnEdges` contrasts, the `rrfK` row), and every public evergreen row (no backslash labels). Deflated
(scored by `search-mode.ts`, private shape only): 0.4005 (dense-only), 0.4016 (`auto` on the decontaminated copy, all
three routes), 0.2460 (`auto` on the settled copy), and the contaminated 0.1009 / 0.0000 and 0.3609 / +0.260 rows, in
the 2026-09-30, 2026-10-01 and 2026-10-02 sections above. The 2026-10-02 sentence "the `auto` numbers moved by 0.30" is
the contamination plus this bug mixed. The retrieval-cache eval (`query-cache.ts`) paired its two sides through the same
scorer, so its ON/OFF comparisons stand, but any absolute private nDCG it printed is deflated; the latency and
identity-gap findings do not use a metric.

Conclusions that need re-checking on the corrected scorer (not re-run here): (1) that the `weak-text` and `hybrid`
`auto` routes are a no-op on the decontaminated private vault ("identical to dense-only search, 0 queries changed" is a
rank comparison and most likely stands, but the 0.4016 level it was reported at is wrong); (2) the size of the private
`auto`-versus-dense gap, withdrawn for contamination but never re-measured at the right scale; (3) the settled-copy `auto` level 0.2460, which the section above set against a `run.ts` dense figure of
0.5542 (the 0.5542 is unaffected; the 0.2460 is deflated, so the two are not comparable and the gap between them says nothing). The class (c) verdicts above all rest on the public rows or on arms that lose
catastrophically, so none flips on this alone; the private-shape `search-mode.ts` rows need re-scoring before they count either way.

**Question and pre-registration.** Does a cross-encoder reranker, applied to the same dense top-K, beat the shipped
order on a single-hop public shape and a multi-hop private shape? Pre-registered before any reranker arm was scored on a
real pool: sha256 `3788364025edc60311952107dbbf46acefbfd4ab94dc267ad62dffee3a61a7ba` (written 2026-10-02T10:39:24Z).
Addendum 1, a post-hoc title-prefix sensitivity variant, was written after the primary arms and after the evergreen
title runs finished (sha256 `c1543d806d50cda6691a70b8ede50fc5defd314b27e47e7bff8fc51c1d4ffa10`, 2026-10-02T11:45:03Z),
scored in its own Benjamini-Hochberg family and labelled exploratory throughout. Harness: `eval/rerank-arms.ts`. Pools:
the real `search_semantic` handler, K=30 primary and K=50 secondary, one precomputed query vector set shared by every
arm, metrics over unique result paths with both sides path-normalized. Index copies: the evergreen corpus (n=78,
strict and lenient labels, one shape) and the private multi-hop vault (n=250; 103 queries declare bridge notes) on the
pre-drift index copy minus the contaminating note (`golden-guard` passes). Paired by query id, permutation p,
bootstrap CI, BH q 0.10 across the arms of one family, non-inferiority floor -0.015. Artifacts, per-arm results,
`runs.db` (128 recorded runs, the index copy in each run's note) and the scripts are under
`/data/obsidian-tc-eval/reranker-2026-10/`.

**Privacy handling.** The NVIDIA API trial terms (3.3) allow collecting submitted content to improve NVIDIA products
and models, and the OpenRouter `:free` nemotron model is served by that same endpoint. Those two arms therefore ran on the
public corpus only, enforced in the harness (`PUBLIC_ONLY_ARMS`); the private vault's text was sent only to Cloudflare
Workers AI (no training on Customer Content), DeepInfra (zero retention) and the local CPU. Candidate text also passes the
production `egress.excludePaths` guard. Skipped with reason: Novita and Cohere (no key), Vertex AI Ranking (project not set up).

**Controls** (nDCG@10): evergreen strict dense 0.8683, `graph_rrf` 0.9143 (+0.046, p 0.053); evergreen lenient dense
0.6277, `graph_rrf` 0.690 (+0.062, p 0.0002); private dense 0.7515, `graph_rrf` 0.7746 (+0.023, p 0.032).

**Primary result: raw chunk text (what the product hands a reranker today), pure rerank order, K=30.** Dense to arm
nDCG@10, paired delta, verdict under the pre-registered rule:

| arm | evergreen strict (n=78) | evergreen lenient (n=78) | private multi-hop (n=250) |
| --- | --- | --- | --- |
| local MiniLM-L6 int8 | 0.868 to 0.670 (-0.198) CATASTROPHIC | 0.628 to 0.571 (-0.057) CATASTROPHIC | 0.748 to 0.656 (-0.092) CATASTROPHIC |
| Cloudflare bge-reranker-base | 0.868 to 0.654 (-0.214) CATASTROPHIC | 0.628 to 0.583 (-0.045) LOSS | 0.748 to 0.678 (-0.069) CATASTROPHIC |
| DeepInfra Qwen3-Reranker-0.6B | 0.868 to 0.686 (-0.182) CATASTROPHIC | 0.628 to 0.578 (-0.050) LOSS | 0.748 to 0.696 (-0.052) CATASTROPHIC |
| NVIDIA nemotron-rerank-vl-1b (public only) | 0.868 to 0.785 (-0.083) CATASTROPHIC | 0.628 to 0.643 (+0.015, p 0.45) UNDERPOWERED | not run |
| OpenRouter nemotron-rerank-vl-1b free (public only) | identical to NVIDIA (same model) | identical | not run |

Every arm loses on the strict labels of the public shape and every arm that ran on the private shape loses there. K=50
is worse or equal everywhere (private: Cloudflare -0.096, DeepInfra -0.069; evergreen strict -0.088 to -0.245). Recall@10
barely moves (private 0.833 to 0.824 to 0.833); the damage is ordering, MRR@10 falls from 0.82 to 0.67 to 0.72 on the
private shape.

**Secondary: reciprocal-rank fusion of the dense and rerank orders (k=10), K=30** (delta nDCG@10 against dense;
p in parentheses):

| arm | evergreen strict | evergreen lenient | private multi-hop |
| --- | --- | --- | --- |
| local MiniLM-L6 int8 | -0.046 (0.074) | +0.004 (0.82) | -0.023 (0.018) |
| Cloudflare bge-reranker-base | -0.066 (0.007) | +0.013 (0.38) | -0.007 (0.40) |
| DeepInfra Qwen3-Reranker-0.6B | -0.025 (0.26) | +0.019 (0.20) | +0.005 (0.55) |
| NVIDIA / OpenRouter nemotron | +0.004 (0.85) | +0.038 (0.003) | not run |

Fusion removes most of the loss but buys nothing the dense order did not already have: about neutral, and below the
+0.023 to +0.062 that `graph_rrf` already adds.

**Secondary: class-gated reranking.** Rerank only the router classes with a positive mean delta and n >= 10 on the
private set (the lexical route, n=13): +0.002 (MiniLM), +0.002 (Cloudflare), +0.005 (DeepInfra), none significant, and
n=13 cannot resolve anything. The oracle ceiling, rerank only queries labelled single-hop, a label no live query carries,
still loses on the private shape (MiniLM -0.061, Cloudflare -0.043, DeepInfra -0.026). The evergreen corpus has no hop
labels (every query is single-hop), so its oracle rows equal the ungated arms. Gating does not rescue the reranker.

**Per-class (private, K=30, pure rerank).** Multi-hop queries lose -0.062 to -0.075, single-hop -0.045 to -0.103, the
lexical route gains +0.035 to +0.086 (n=13, not significant), the temporal route loses -0.118 to -0.213. The prior
mechanism ("a reranker demotes bridge notes") is not supported: bridge-note nDCG@10 over the 103 bridge queries rose for
every arm (0.209 to 0.224 / 0.246 / 0.256; DeepInfra p 0.039). The losses are in ordinary single-document ranking. On
evergreen strict the largest are `keyword` (-0.22 to -0.52) and `author-work` (-0.21 to -0.41) queries, where the
expected note is identified by its title, and a raw chunk carries no title.

**Exploratory, not pre-registered as a primary: title-prefixed passages** (addendum 1; passage is
`<note title>\n\n<chunk>`, K=30, same pools, its own BH family; the dense index already sees the title through graph
context, the reranker did not). Dense to arm nDCG@10, pure rerank:

| arm | evergreen strict | evergreen lenient | private multi-hop |
| --- | --- | --- | --- |
| local MiniLM-L6 int8 + title | 0.868 to 0.912 (+0.044) WIN | 0.628 to 0.657 (+0.030) WIN | 0.748 to 0.758 (+0.010, p 0.43) TIE |
| Cloudflare bge-reranker-base + title | -0.040 UNDERPOWERED | +0.030 WIN | +0.014 (p 0.29) TIE |
| DeepInfra Qwen3-Reranker-0.6B + title | -0.031 UNDERPOWERED | +0.010 UNDERPOWERED | 0.748 to 0.781 (+0.033, p 0.014) WIN |
| NVIDIA nemotron + title (public only) | 0.868 to 0.937 (+0.069) WIN | 0.628 to 0.693 (+0.065) WIN | not run |

With RRF fusion the title-prefixed arms are not worse than dense on any cell (private +0.012 to +0.023, evergreen
strict +0.010 to +0.042, lenient +0.026 to +0.047), and the private bridge-note nDCG@10 rises (DeepInfra +0.048,
p 0.019). The best cells (nemotron on evergreen strict, 0.937) pass the `graph_rrf` control (0.914). This is a
post-hoc variant formed after reading the primary per-category table, tested on the same queries it was formed from for
the public shape, so the public wins are hypothesis-generating; the private shape is the nearer thing to a held-out
check and there the wins are small (+0.010 to +0.033, one of three clears significance). It cannot change a primary
verdict.

**Latency and cost** (provider call from the Cave host, load average 5 to 9 on 4 cores, so local figures are inflated;
p50 / p95 ms at K=30): Cloudflare 564 to 637 / 1,321 to 1,784, DeepInfra 341 to 381 / 791 to 839, NVIDIA 412 / 509,
OpenRouter free 444 / 489, local MiniLM 2,881 to 3,460 / 3,400 to 7,863 (6,017 at K=50). Cloudflare costs about 1.9
estimated neurons per search at K=30 (3.2 at K=50), DeepInfra about $0.01 per million tokens, the rest are free. A local
`bge-reranker-v2-m3` (int8 ONNX, CPU) was probed on three queries only: 91 to 130 s per search (p50 98 s, at a load
average of about 11), roughly thirty times the MiniLM arm on the same host, so it is dropped as an arm (threshold 5 s).

**Verdict (ADR 0007 class (c)): no default flips, and the reranker stays off as wired.** A catastrophic loss on every
raw-chunk arm on at least one shape rules out a default under the rule, and two English shapes could not meet the
three-shape bar regardless. The September 2026 conclusion ("no reranker beats the production order; keep it off")
holds against dense-only and against `graph_rrf`: `graph_rrf` is above dense on every shape (+0.023 to +0.062) and no
raw-chunk arm gets above dense on the strict or private shape; it holds on the corrected private baseline (0.7515, not
0.4016). Do not enable a reranker as wired.

**Follow-up, not a decision.** The loss is in the passage, not (only) the model: a reranker that sees the note title
stops losing and, on the public shape, wins. If this is revisited, rerank title-prefixed passages and run a
pre-registered confirmatory eval on corpora not used to form the hypothesis (a title-bearing passage is a `src/`
change, which this study does not make). The cheapest candidates are DeepInfra Qwen3-0.6B + title (private +0.033,
about 0.35 s) and local MiniLM + title (free, +0.010 on private, +0.044 on evergreen strict, but about 3 s per search
on one CPU thread). Class gating does not help.
