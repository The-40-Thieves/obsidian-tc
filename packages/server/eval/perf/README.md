# THE-459/THE-503: Synthetic-Vault Perf Harness

A deterministic, CI-gated benchmark for obsidian-tc, isolated from the live-model golden-set evaluation. Measures indexing throughput, embedding efficiency, graph-search recall/nDCG, dispatch latency, storage overhead, runtime memory/eventloop health, and database lifecycle metrics over a seeded synthetic vault.

## Quick Start

From `packages/server`:

```bash
# Dev-fast single-shot (one process, one sample) -- for iterating locally
bun run perf
bun run perf:gate

# THE-503: isolated (5 fresh subprocess samples, gated on the median, contention-checked) --
# what CI actually runs. Slower; use this before trusting a number.
bun run perf:isolated
bun run perf:gate:isolated
```

Both pairs use the `small` scenario by default. To use a different scenario or explore flags:

```bash
# Underlying CLI: explicit scenario, custom output file, gate mode, or baseline regeneration
bun eval/perf/run.ts --scenario small --out my-report.json
bun eval/perf/run.ts --scenario medium --gate
bun eval/perf/run.ts --scenario vault1k --samples 5 --gate
bun eval/perf/run.ts --scenario large --samples 5 --update-baseline
```

## Isolation & Statistics (THE-503)

**The incident that motivated this:** a perf run once overlapped the Vitest suite. Index/embedding throughput read ~51% below baseline and dispatch p99 was 16ms vs an isolated 1ms — and **the gate still passed**, because latency/throughput are warn-only and nothing was watching for the contention itself.

`--samples N` (default 5, what `perf:*:isolated` use) switches to the isolated path (`sample.ts` + `isolate.ts` + `contention.ts`):

1. **Fresh subprocess per sample.** Each of the N samples is a genuinely separate `bun eval/perf/run.ts` process — no shared module cache, event loop, JIT state, or GC pressure with the harness's own runtime or with each other.
2. **Gate on the median, never a single observation.** `isolate.ts`'s `aggregate()` computes the median across all N samples per metric; the gate compares the median against the baseline.
3. **Coefficient of variation (CV) is tracked and reported** for every metric, alongside the full raw series — the artifact (`--out`) preserves every raw sample, not just the aggregate.
4. **Host-contention detection** (`contention.ts`): each subprocess also runs a fixed, scenario-independent CPU busy-loop ("calibration"), timed alongside the real scenario. Two complementary checks over the N calibration times:
   - **Relative** (CV / max-over-median): catches *intermittent* contention (comes and goes between samples, or stalls one sample hard). Needs no external reference.
   - **Absolute** (vs a committed `eval/perf/calibration-reference.json`): catches *sustained, uniform* contention that the relative checks miss — e.g. the motivating incident, where the interfering process ran for the WHOLE measurement, slowing every sample by roughly the same amount (low CV, still wrong). This gap was found empirically while validating the detector, not hypothesized: an artificial constant 4-core CPU load produced `cv=0.159` ("clean") despite the calibration median itself being roughly double a quiet run's.
   - **Baselines are refused, not silently recorded, under detected contention.** `--update-baseline` in isolated mode exits 1 and leaves the existing baseline file untouched if contention is detected. A plain `--gate` run still completes (CI must run regardless of transient noise) but prints a `WARN host contention detected` line.
5. **Hard-class metrics must agree EXACTLY across all N samples**, independent of the baseline comparison. `isolate.ts`'s `checkHardStability()` treats any disagreement as its own hard failure (`HARD-UNSTABLE`, exit 1) — a "deterministic" invariant that varies across identically-seeded runs means the determinism assumption itself broke (real nondeterminism or a corrupted run), which is a different and more serious problem than a tolerance violation.
6. **CI concurrency**: the `perf` job in `ci-server.yml` carries its own (non-ref-scoped) `concurrency: group: perf-exclusive` so at most one `perf` job runs anywhere in the repo at a time.

Recalibrating the quiet-host reference happens automatically as part of a successful (non-contended) `--update-baseline` run in isolated mode — it is committed and reviewed exactly like the metric baseline, for the same drift-safety reason (see "Baseline and Regeneration" below).

## Scenarios

Deterministic scenarios, each with a fixed PRNG seed (0x5eed), parametrizing the synthetic vault. Chunk count is always `notes * 2` (one body-section chunk + one links-section chunk per note — see `harness.ts`).

| Scenario | Notes | Dup Groups | Link Fanout | Paragraphs | Chunks | CI-gated? | Measured single-shot wall time |
|---|---|---|---|---|---|---|---|
| `small` | 100 | 20 | 3 | 2 | 200 | **yes** (`baseline.small.json`) | ~4-12s |
| `vault1k` | 500 | 100 | 3 | 2 | 1,000 | no | ~10s |
| `medium` | 1000 | 200 | 4 | 3 | 2,000 | no | ~15s |
| `large` | 5000 | 1000 | 4 | 3 | 10,000 | no | ~2min |
| `vault100k` | 50,000 | 10,000 | 4 | 3 | 100,000 | no — `expensive: true`, deliberately excluded from every script | not run in this session (see below) |

Only `small` has a committed baseline and a CI gate today (`ci-server.yml`'s `perf` job). The others are available for manual/ad-hoc use (`bun eval/perf/run.ts --scenario <name> ...`) when a THE-467/THE-468 decision needs a specific scale point.

**THE-503 scope note on `vault100k`:** cost scales super-linearly with corpus size (10,000 chunks measured ~2m23s single-shot on the reference dev host during this work — see git history for the exact number), so a single `vault100k` run is expected to take on the order of tens of minutes, and the 5-sample isolated mode proportionally longer. It was **not executed** in this session for that reason (and because this host itself has ambient multi-tenant noise — see the contention section above, which would make the numbers untrustworthy anyway). The scenario is fully defined and usable; running it and capturing a baseline is left as deliberate follow-up work, ideally on a dedicated (not shared) host.

Each scenario:
- Uses the same seed (0x5eed), so results are **deterministic** across runs on the same codebase.
- Generates synthetic notes from a fixed word vocabulary and body pool (no random dates, no `Math.random()`).
- Reuses note bodies verbatim across duplicate groups to test embedding deduplication.
- Generates per-note distinct wikilinks to build a meaningful graph structure.

## What this harness does NOT cover (THE-503 audit finding)

The synthetic vault is built via `harness.ts`'s `buildVault()`, which calls `indexVault()` **without** the `densify` option. `indexVault`'s graph-densification pass (shared-tag co-occurrence + vec0 kNN neighbor edges — see `docs/plans/2026-07-13-graph-densification.md`, `src/search/derived-edges.ts`) is opt-in and off by default, so **this harness never exercises it at all**, in any scenario. A change to that subsystem's cost (e.g. THE-486's delta-only densification rewrite) is invisible to every metric this harness collects, not just under-tolerated — there is no code path connecting them. Multi-vault contention, concurrent indexing+retrieval, ACL-heavy over-fetch, sparse/ColBERT embedding scenarios, same-dimension model migration, scheduler-during-traffic, and failure injection (locked DB, slow provider, canceled shutdown) are also not yet covered — see the THE-503 ticket for the full target list and the implementation notes for what was prioritized this pass.

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

**Result:** Deterministic invariants (families 3, 4, 5, 7, 8, 9, 11, 13, 14 — counts, ratios, recall/nDCG, storage bytes, booleans) are **always identical** run-to-run. Latency figures (families 1, 2, 6, 10 and the `*_ms` sub-metrics) vary naturally and are gated warn-only. Family 12 (HTTP handshake) is deferred (THE-495) and not emitted.

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

**THE-503:** in isolated mode (`--samples N --update-baseline`), the same file is written from the **median** across N fresh-subprocess samples, and the run is **refused outright (exit 1, file untouched)** if host contention was detected during sampling — see "Isolation & Statistics" above. `eval/perf/calibration-reference.json` (the committed "quiet host" calibration median used for sustained-contention detection) is written alongside it, under the same refusal discipline, and should be regenerated whenever the reference CI hardware changes materially.

## Synthetic Labelled Set

For family 9 (recall/nDCG) metrics, the harness uses a small, **throwaway synthetic relevance set**. It:

- **Is NOT the private golden set** (see THE-421 leak class). No real vault data, no user queries, no secret information.
- **Is co-generated** with the seeded synthetic vault: queries + paths are deterministic artifacts of the corpus.
- **Is in-repo** and can be freely shared in PRs, GitHub, etc., without leak concerns.
- Uses sentinel tokens (`zqmarker${i}`) to distinguish body groups in queries (hard to confuse with other groups via the shared word vocabulary).

See `packages/server/eval/perf/labelled.ts` for the definition (5 queries, 20 relevant notes per query for small scenario).

## Metric Families

The harness collects all 14 THE-459 metric families across 7 collector modules, plus a THE-503 concurrent-HTTP addition.

| Family | Type | Metrics | Module | Class | Notes |
|---|---|---|---|---|---|
| 1 | Dispatch overhead | `dispatch.overhead_p{50,95,99}_ms` | dispatch.ts | warn | Measures the ToolRegistry pipeline cost in isolation |
| 2 | Freshness | `freshness.{visible, ms}` | dispatch.ts | {hard, warn} | Time from write to search-visible |
| 3 | Index throughput | `index.{chunk_count, chunks_per_s}` | indexing.ts | {hard, warn} | Indexing rate; count is deterministic |
| 4 | Embed throughput | `embed.{call_count, texts_per_s}` | indexing.ts | {hard, warn} | Embedding API usage; call count deterministic |
| 5 | Embed dedup ratio | `embed.dup_ratio` | indexing.ts | hard | Fraction of chunks sharing a body (exact deterministic) |
| 6 | Event-loop delay | `runtime.eventloop_p99_ms` | runtime.ts | warn | P99 event-loop delay under REAL concurrent load (THE-503: see below — this used to read 0 almost every run) |
| 7 | SQLite txn/lock + write-txn count | `storage.{txn_count, txn_ms}`, `index.txn_count` | storage.ts, indexing.ts | {hard, warn} | `storage.txn_count` is a synthetic fixed-size (200) scratch-table microbench timing raw commit overhead — NOT connected to indexVault. `index.txn_count` (THE-503, new) IS the real write-transaction count indexVault used (via a `db.exec("BEGIN")` counting wrapper), gated hard as "lower is better" (`direction: "higher-worse"`) rather than exact-match, so THE-500's batching can register as an improvement instead of tripping an invariant that could never recognize one. |
| 8 | Graph candidates | `graph.candidates_{seed, expand, fused}` | retrieval.ts | hard | ANN graph traversal stage cardinality (exact deterministic) |
| 9 | Recall/nDCG | `retrieval.{recall_at10, ndcg_at10, ndcg_per_ms}` | retrieval.ts | {hard, hard, warn} | Relevance metrics over synthetic labelled set |
| 10 | Peak memory | `runtime.peak_rss_mb` | runtime.ts | warn | Peak process RSS during the run, in MB. NOT normalized per chunk: RSS is whole-process, so a per-chunk figure attributes memory it cannot account for (THE-459). Scenarios are fixed-size, so absolute RSS is comparable run-to-run. |
| 11 | Vec migration | `migration.{rebuilt, ms}` | lifecycle.ts | {hard, warn} | Vec-index rebuild latency; rebuilt = bun-only true |
| 12 | HTTP handshake | `http.handshake_ok`, `http.cold_ms`, `http.warm_ms` | http.ts | hard / warn | MCP `initialize` round-trip through the real Hono app via `app.fetch()` — **no network listener is bound**. Cold vs warm separates one-time init from steady-state per-request cost (the build THE-463 proposes caching). `handshake_ok` requires a protocol-level `result`, so a degraded handshake fails rather than passing on a 200. |
| 12b | Concurrent HTTP callers (THE-503) | `http.concurrent{2,8}_{ok_count,p99_ms}` | http.ts | {hard, warn} | 2 and 8 concurrent `initialize` calls fired via `Promise.all` over `app.fetch()` (still no network listener). `ok_count` must equal the concurrency level (hard) — a degraded/racy handshake under load fails rather than passing silently. |
| 13 | Shutdown drain | `shutdown.{drained, ms}` | lifecycle.ts | {hard, warn} | Graceful DB close under deadline; runs last |
| 14 | Per-vault storage | `storage.{bytes, cpu_ms}` | storage.ts | {hard, warn} | DB page bytes (exact); CPU over the txn batch |

**Collector execution order** (in `run.ts`):
1. indexing (families 3, 4, 5, 7's `index.txn_count`)
2. retrieval (families 8, 9)
3. dispatch (families 1, 2)
4. storage (families 7's `storage.*`, 14)
5. runtime (families 6, 10)
6. http (family 12, then 12b) — needs a live db
7. lifecycle (families 11, 13) — **closes vault.db, must run last**

### THE-503: event-loop delay used to silently read 0

`runtime.eventloop_p99_ms` used to read 0 on almost every run. Root cause, confirmed empirically: the old load loop `await`ed one `graphSearch` call at a time. Each call resolves through nothing but microtasks, and microtasks always drain completely before the event loop returns to its poll phase — so control never crossed a macrotask boundary while the load ran, and `monitorEventLoopDelay`'s internal check (driven off that boundary) recorded **zero samples at all** (`h.count === 0`), not "delay below resolution". A histogram with no samples reports 0 from `.percentile()`, silently indistinguishable from "no delay".

Fixed per the ticket's own two remedies, applied together: resolution dropped to 1ms (the minimum `monitorEventLoopDelay` accepts), and the load loop now runs concurrent batches (4 at a time, 20 batches) with an explicit `setImmediate` yield between batches — a genuine macrotask boundary the monitor can sample at, run long enough to accumulate a non-degenerate distribution. Verified non-zero under both Node (vitest) and real bun.

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
- Gate logic: violations are correctly classified as hard/warn (`test/perf-gate.test.ts`).
- Baseline format: entries are parsed correctly.
- THE-503: aggregation (median/CV/raw preservation, `test/perf-isolate.test.ts`), contention
  detection (`test/perf-contention.test.ts`), subprocess orchestration against a fake spawn
  (`test/perf-sample.test.ts`), and a REAL end-to-end subprocess-isolation run
  (`test/perf-isolate-integration.test.ts` — actually spawns 2 fresh `bun` processes; slower by
  design, this is what proves isolation rather than asserting it).

Run via:
```bash
bun run test
```

(Harness tests live in `test/perf-*.test.ts`; `test/perf-run.test.ts` imports `runScenario` from this module.)

## References

- Task brief: [THE-459 issue](https://linear.app/the-40-thieves/issue/THE-459), [THE-503 issue](https://linear.app/the-40-thieves/issue/THE-503) (isolation + statistics + scenario coverage)
- Private golden set (THE-421 leak class): see `/data/llm-stack/obsidian-tc-eval/` on Cave.
- Node.js parity: [THE-494 issue](https://linear.app/the-40-thieves/issue/THE-494)
