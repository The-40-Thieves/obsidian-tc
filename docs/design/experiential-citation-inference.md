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

## A typed judge seam, and the opt-in TypeSafe Jev provider (THE-1078)

The stage-2 judge used to be a single inline block: build a gateway chat-completions request with
the `JUDGE_SYSTEM`/`JUDGE_SYSTEM_UNCERTAIN` prompt, call `judge()`, parse the JSON reply. That
tied stage 2 to one shape of judge — a chat-completions role — with no seam for a second one.
`experiential/citation-judge.ts` now defines one `CitationJudge` function type
(`(source, response, sourcePaths) -> {kind: "ok"|"unparseable"|"transport", ...}`) and two
adapters behind it: `chatCitationJudge`, which builds the EXACT same request as before (pinned by
a byte-identity test), and `typesafeCitationJudge`, new in this ticket. `citation.ts`'s stage-2
loop calls only the seam, so `parseFailures`/`judgeErrors`/the >5% kill switch mean the same thing
regardless of which provider answers a call — a provider swap must not require re-deriving what
"unusable" means.

TypeSafe Jev is reached over `gateway/typesafe.ts`, a minimal client for TypeSafe's `/v1/systemone`
endpoint and its "Noul" question type (a single yes/no-with-confidence answer, 0..1). It mirrors
`gateway/client.ts`'s per-attempt-timeout/fresh-AbortController/exponential-backoff shape, with one
deliberate deviation from THE-615's rule that a bare 429 (no `Retry-After`) is not retryable:
TypeSafe documents a bare 429 as transient ("rate limits adjusting dynamically"), unlike the
self-hosted gateway's 429, which is a quota/config answer about OUR request. Different providers,
different contracts.

The judge question asked is fixed and narrow: does the response use SPECIFIC content from the
source (states, paraphrases, or relies on facts/names/numbers/steps/claims that appear in it),
as opposed to merely sharing a topic with it. `cited = noul >= threshold`; there is no "uncertain"
verdict from this provider — Noul has no third answer, unlike the chat judge's opt-in
`allowUncertain` abstention.

`judge.model` must be a pinned, versioned id (rejected at config load if it ends in `-latest` or
`-preview`): a Noul threshold is tuned against one specific model version, and a floating alias
would silently move the decision boundary underneath a threshold picked for a fixed version.
`judge.threshold` has deliberately no shipped default — a boundary tuned for one deployment's
tolerance for false positives is not a safe default for another's, and TypeSafe's own customer
agreement bars publishing the benchmark numbers that would justify picking one here regardless.

`buildCitationJudge` (the factory both `cli/commands/citation-infer.ts` and
`runtime/plane-wiring.ts` call) throws at CONSTRUCTION time — never a silent fallback to the
gateway judge — when `provider: "typesafe"` is configured without a resolvable model, threshold,
or API key. A quietly-ignored typesafe block that ran the gateway judge instead would look
identical to a correctly-configured one in every log line that matters.

## `MAX_JUDGED`'s counterpart, and why it no longer has one

`maxJudged` (THE-617 item 3, default 25, override via `--max-judged`) used to be documented as the
counterpart to an identically named `MAX_JUDGED` in `reflect.ts`, kept as a separate constant because
citation-inference and episode-evaluation were independent workloads that should stay independently
tunable. THE-701 deleted the episode judge entirely, so `reflect.ts` no longer has such a constant —
there is no longer a second workload to stay tunable apart from, and this is the only `MAX_JUDGED`
left in the codebase (THE-747).
