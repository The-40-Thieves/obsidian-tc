# Citation inference

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Where the transcript comes from (THE-717 / THE-675)

The module header used to say the transcript was "assistant-side text the MCP server itself never
sees," and that sentence got quoted forward for months as proof the whole citation-inference feature
was unbuildable. It was wrong, though not for the reason it looked wrong: it is true of the **MCP
protocol** and says nothing about the **host**. A client is free to ship its own transcripts
somewhere the server can read them, and on at least one deployment it already was. The premise was
never re-tested because the sentence read as authoritative.

The fix was a plain seam rather than a protocol change: a JSONL index file
(`experiential.citationInfer.transcriptIndex`, one object per retrieval) that any client and any log
store can populate, with the producer left out of tree (#708, #709, #707). Do not derive a blocker
from a fact about the protocol — check whether the host actually exposes what the protocol alone
does not promise.

## Two-stage design (2026-05-16 design anchors, de-vendored onto local seams)

- **Stage 1 (cheap filter):** ROUGE-L F of chunk content vs. the transcript, OR max cosine of the
  chunk's stored embedding against embedded transcript blocks. Thresholds 0.05 / 0.30 carried
  forward from the original design; the DoD's hand-labeled validation runs at data maturity.
- **Stage 2 (judge):** the gateway `judge` role, strict-JSON entailment per stage-1 survivor, with a
  kill switch — greater than 5% parse failures aborts stage-2 stamping, leaving survivor rows NULL
  for a clean rerun. Stage-1 negatives are always safe to stamp `cited = 0` without a judge call.

Correlation is by `session_id` (threaded from `ctx` into every retrieval-log call) or a
`retrieved_at` window — the join THE-228's capture bus made trivial.

## Transcript tokenization: hoist and intern once (measured)

`inferCitations` scores every retrieved chunk against the same transcript. The original
`rougeL(chunk, transcript)` signature forced a full `tokenize(transcript, 6000)` — a lowercase pass
plus a global regex match over the whole transcript — to rerun for every chunk, and the LCS DP then
compared JS strings in its innermost cell.

Measured at the module's own bounds (512 × 6000 = 3,072,000 cells): **62.6 ns/cell** with string
compares vs. **40.1 ns/cell** over interned ints, for an identical score. `prepareTranscript` +
`rougeLPrepared` hoist the tokenize out of the per-chunk loop and intern tokens to ints once, which
is pure removed work on top of the per-cell speedup.

## Cosine scoring: batch the crossing (THE-420)

The naive per-pair form — one `cosineSimilarity` call per (transcript block, chunk) pair, up to
`MAX_BLOCKS` (48) crossings per chunk — was measured by THE-420 at **13–22x slower** than the pure-JS
fallback, because `cosineSimilarity`'s `a: number[]` parameter marshals a fresh `Vec<f64>` on every
one of those 48 crossings. `prepareBlocks` + `maxBlockCosine` flatten the block vectors once into a
row-major `Float32Array` so each chunk costs one `cosineBatch` crossing instead of 48. Mirrors
`search/colbert.ts`'s `flattenRectangular`.

Narrowing block vectors from f64 (`number[]` as received) to f32 (the flat buffer) can shift scores
from the old all-f64 query path in the last bits; THE-504 measured that narrowing at **< 1e-6
absolute**, against a stage-1 threshold of 0.30 — well below anything that could flip a pass/fail
decision.

## `MAX_JUDGED`'s counterpart, and why it no longer has one

`maxJudged` (THE-617 item 3, default 25, override via `--max-judged`) used to be documented as the
counterpart to an identically named `MAX_JUDGED` in `reflect.ts`, kept as a separate constant because
citation-inference and episode-evaluation were independent workloads that should stay independently
tunable. THE-701 deleted the episode judge entirely, so `reflect.ts` no longer has such a constant —
there is no longer a second workload to stay tunable apart from, and this is the only `MAX_JUDGED`
left in the codebase (THE-747).
