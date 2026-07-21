# THE-459: Synthetic-Vault Perf Harness

A deterministic, CI-gated benchmark for obsidian-tc, isolated from the live-model golden-set evaluation. Measures indexing throughput, embedding efficiency, graph-search recall/nDCG, dispatch latency, storage overhead, runtime memory/eventloop health, and database lifecycle metrics over a seeded synthetic vault.

## Quick Start

From `packages/server`:

```bash
# Run the harness on the small scenario (100 notes)
bun run perf

# Run the harness and fail CI if any hard invariant regresses
bun run perf:gate
```

Both scripts use the `small` scenario by default. To use a different scenario or explore flags:

```bash
# Underlying CLI: explicit scenario, custom output file, gate mode, or baseline regeneration
bun eval/perf/run.ts --scenario small --out my-report.json
bun eval/perf/run.ts --scenario medium --gate
bun eval/perf/run.ts --scenario large --update-baseline
```

## Scenarios

Three deterministic scenarios, each with a fixed PRNG seed (0x5eed), parametrizing the synthetic vault:

| Scenario | Notes | Dup Groups | Link Fanout | Paragraphs | ~Chunks |
|---|---|---|---|---|---|
| `small` | 100 | 20 | 3 | 2 | 200 |
| `medium` | 1000 | 200 | 4 | 3 | 2000 |
| `large` | 3400 | 400 | 4 | 3 | ~10k |

Each scenario:
- Uses the same seed (0x5eed), so results are **deterministic** across runs on the same codebase.
- Generates synthetic notes from a fixed word vocabulary and body pool (no random dates, no `Math.random()`).
- Reuses note bodies verbatim across duplicate groups to test embedding deduplication.
- Generates per-note distinct wikilinks to build a meaningful graph structure.

## Gate Model: Hard vs. Warn

Metrics are classified into two enforcement levels:

### Hard Invariants (class: hard)
- **Deterministic counts** (chunk count, call counts, graph candidate cardinality, etc.) must not change.
- **Core quality metrics** (recall, nDCG, storage bytes, memory ratio) are hard gated to catch regressions.
- **Violations fail CI** — a hard regression cannot land.
- Specified with `direction: "exact"` (exact count, zero tolerance) or `direction: "lower-worse" | "higher-worse"` (quality thresholds, ±15% tolerance).

### Warn Invariants (class: warn)
- **Noisy latency figures** (throughput, dispatch overhead, eventloop delay, shutdown drain, etc.) that vary across shared CI runners.
- **Violations emit warnings only**, never fail CI.
- Specified with ±50% or ±25% tolerance (per metric type).

**One-sided directionality:** Improvements (better than baseline) never trigger a violation. Only regressions (worse than baseline, exceeding tolerance) do.

## Why Bun-Only

The harness runs **under bun**, not node, because:

- **sqlite-vec is the blocker**: The real ANN search path uses `sqlite-vec` for dense-vector similarity queries.
- `bun` + `better-sqlite3` load sqlite-vec correctly.
- `node` + `sqlite` (the Node.js built-in) does NOT load sqlite-vec; queries that depend on it fail.
- This means `migration.rebuilt` (vec-index rebuild metric) and `graph.candidates_*` (ANN-based graph traversal counts) only work under bun.

**Node.js parity is deferred to [THE-494](https://linear.app/the-40-thieves/issue/THE-494).**

## Determinism

Two mechanisms ensure results are byte-identical across runs:

1. **Seeded PRNG (Mulberry32):** Vault corpus generation uses a fixed seed (0x5eed), not `Date.now()` or `Math.random()`.
   - Same seed → identical note bodies, links, and structure.
   - Each scenario fixes its seed; results are stable across runtimes.

2. **Fake embedding provider:** The harness uses a deterministic embedding provider (hardcoded vectors derived from query text, not a real model).
   - Embedding calls always return the same vectors for the same text.
   - No network, no model inference, no variance.

**Result:** Exact counts (families 3, 4, 5, 8, 11, 12, 13) are **always identical**. Latency figures (families 1, 2, 6, 10) vary naturally but are gated as warn-only.

## Baseline and Regeneration

The baseline lives in `eval/perf/baseline.${scenario}.json`, e.g., `eval/perf/baseline.small.json` for the small scenario. Each metric entry has:

```json
{
  "key": {
    "value": 123,         // baseline measurement
    "tol": 0.15,          // absolute (abs) or relative (ratio) tolerance
    "mode": "ratio",      // "abs" for counts/ratios, "ratio" for per-second metrics
    "class": "hard",      // "hard" (fails CI) or "warn" (informational)
    "direction": "exact"  // "exact", "lower-worse", or "higher-worse"
  }
}
```

### Intentional Regeneration

To regenerate the baseline after an intentional change (e.g., optimization that reduces latency), run:

```bash
bun eval/perf/run.ts --scenario small --update-baseline
```

This:
1. Runs the scenario.
2. Writes a new `eval/perf/baseline.small.json` with fresh measurements.
3. Prints the report to stdout.

**Important:** Baseline changes must be **manually committed** and **justified in the PR**. The baseline is drift-safe because you hand-commit it, not because it auto-updates. Include a rationale in your commit message explaining why the baseline shifted (e.g., "optimize graph traversal → 5% faster nDCG/ms").

## Synthetic Labelled Set

For family 9 (recall/nDCG) metrics, the harness uses a small, **throwaway synthetic relevance set**. It:

- **Is NOT the private golden set** (see THE-421 leak class). No real vault data, no user queries, no secret information.
- **Is co-generated** with the seeded synthetic vault: queries + paths are deterministic artifacts of the corpus.
- **Is in-repo** and can be freely shared in PRs, GitHub, etc., without leak concerns.
- Uses sentinel tokens (`zqmarker${i}`) to distinguish body groups in queries (hard to confuse with other groups via the shared word vocabulary).

See `packages/server/eval/perf/labelled.ts` for the definition (5 queries, 20 relevant notes per query for small scenario).

## Metric Families

The harness collects 14 metric families across 6 collector modules. **Family 12 (HTTP handshake) is deferred to a follow-up ticket** ([THE-494](https://linear.app/the-40-thieves/issue/THE-494)), but its deterministic invariant is still emitted.

| Family | Type | Metrics | Module | Class | Notes |
|---|---|---|---|---|---|
| 1 | Dispatch overhead | `dispatch.overhead_p{50,95,99}_ms` | dispatch.ts | warn | Measures the ToolRegistry pipeline cost in isolation |
| 2 | Freshness | `freshness.{visible, ms}` | dispatch.ts | {hard, warn} | Time from write to search-visible |
| 3 | Index throughput | `index.{chunk_count, chunks_per_s}` | indexing.ts | {hard, warn} | Indexing rate; count is deterministic |
| 4 | Embed throughput | `embed.{call_count, texts_per_s}` | indexing.ts | {hard, warn} | Embedding API usage; call count deterministic |
| 5 | Embed dedup ratio | `embed.dup_ratio` | indexing.ts | hard | Fraction of chunks sharing a body (exact deterministic) |
| 6 | Event-loop delay | `runtime.eventloop_p99_ms` | runtime.ts | warn | P99 event-loop delay under load |
| 8 | Graph candidates | `graph.candidates_{seed, expand, fused}` | retrieval.ts | hard | ANN graph traversal stage cardinality (exact deterministic) |
| 9 | Recall/nDCG | `retrieval.{recall_at10, ndcg_at10, ndcg_per_ms}` | retrieval.ts | {hard, hard, warn} | Relevance metrics over synthetic labelled set |
| 10 | Storage | `storage.{bytes, txn_count, txn_ms, cpu_ms}` | storage.ts | {hard, hard, warn, warn} | DB page size, transaction perf |
| 11 | Vec migration | `migration.{rebuilt, ms}` | lifecycle.ts | {hard, warn} | Vec-index rebuild latency; rebuilt = bun-only true |
| 12 | HTTP handshake | (deferred) | — | — | Deferred to THE-494; deterministic invariant logged |
| 13 | Shutdown drain | `shutdown.{drained, ms}` | lifecycle.ts | {hard, warn} | Graceful DB close under deadline; runs last |

**Collector execution order** (in `run.ts`):
1. indexing (families 3, 4, 5)
2. retrieval (families 8, 9)
3. dispatch (families 1, 2)
4. storage (family 10)
5. runtime (families 6, 10)
6. lifecycle (families 11, 13) — **closes vault.db, must run last**

## Interpreting Results

### Success (no output)
```bash
$ bun run perf:gate
perf gate OK (0 warnings)
```

### Warnings (latency variance, does not fail CI)
```bash
$ bun run perf:gate
WARN dispatch.overhead_p95_ms: 1.5 vs baseline 1
WARN runtime.eventloop_p99_ms: 0.5 vs baseline 0
perf gate OK (2 warnings)
```

### Hard failure (blocks merge)
```bash
$ bun run perf:gate
FAIL retrieval.recall_at10: 0.85 vs baseline 0.96 (tol 0.15)
exit code 1
```

A hard failure means a deterministic invariant (chunk counts, call counts, recall thresholds) has regressed and **must be fixed before landing**.

## Testing

Harness self-tests verify:
- Determinism: running the same scenario twice produces identical counts.
- Gate logic: violations are correctly classified as hard/warn.
- Baseline format: entries are parsed correctly.

Run via:
```bash
bun run test
```

(Harness tests live in `test/perf.test.ts` and import `runScenario` from this module.)

## References

- Task brief: [THE-459 issue](https://linear.app/the-40-thieves/issue/THE-459)
- Private golden set (THE-421 leak class): see `/data/llm-stack/obsidian-tc-eval/` on Cave.
- Node.js parity: [THE-494 issue](https://linear.app/the-40-thieves/issue/THE-494)
