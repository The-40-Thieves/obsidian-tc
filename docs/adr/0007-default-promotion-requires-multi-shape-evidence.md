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
| private multi-hop vault | 13,746 | 250 | 10 | 0.7696 / 0.7696 | 0.8602 / 0.8602 | 0.8364 / 0.8364 | 0 |
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
| private multi-hop vault (CONTAMINATED, see correction below) | 250 | 0.1009 / 0.0000 | 0.1083 / 0.0000 | 0.1123 / 0.0000 | 32 | -0.130 |

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
| private multi-hop vault (CONTAMINATED, see correction below) | 250 | 0.1009 | 0.3609 (+0.260) | 0.3609, +0.260 (lower +0.222, p 0.0001) | 94 (all up) |

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
