# THE-459 — Synthetic-vault perf harness + CI gates (design)

- **Ticket:** [THE-459](https://linear.app/the-13th-letter/issue/THE-459) (sub-issue of [THE-458](https://linear.app/the-13th-letter/issue/THE-458), the architecture/efficiency program)
- **Date:** 2026-07-20
- **Status:** design approved, pre-implementation
- **Follow-up spun out:** [THE-494](https://linear.app/the-13th-letter/issue/THE-494) (Node-runtime parity check)

## Problem

THE-459 is the **first** item of the THE-458 program and gates the two XL items
(per-vault storage isolation THE-467, event-loop offload THE-468): those must not
be built before a *measured* bottleneck exists. We need a deterministic,
CI-gated benchmark harness over a synthetic vault that produces the numbers those
go/no-go decisions depend on, kept strictly separate from the existing live-model
golden-set quality eval.

## Goals

- A deterministic synthetic-vault benchmark harness covering the 14 metric
  families named in THE-459.
- A committed baseline + a CI gate that **hard-fails on regressions in
  low-variance (deterministic) metrics** and **warns (never fails) on noisy
  latency metrics**, so the gate is trustworthy on GitHub's shared runners.
- A baseline report for the current architecture, so THE-467/THE-468 can be
  justified or declined on data.

## Non-goals (YAGNI)

- No real embedding provider or live model (that is the separate golden-set eval).
- No historical trend database — the gate is a stateless compare against a
  committed baseline.
- No Node-runtime path — deferred to **THE-494**. This harness runs bun-only.
- We do **not** reuse `benchmark-action/github-action-benchmark`: it applies one
  global ratio threshold and auto-drifts its baseline on `main`, and cannot
  express the per-family hard/warn split or absolute tolerances this design needs.
  (Decision recorded below.)

## Runtime decision (bun, real storage path)

The harness runs under **bun + better-sqlite3 + sqlite-vec**, with the production
PRAGMAs from `src/db/bun-sqlite.ts` (WAL, `synchronous=NORMAL`, `busy_timeout`,
`mmap_size`). This is the path the server actually takes in production: native
ANN vector search, real transaction/lock durations.

Under Node + `node:sqlite` (the vitest path) `sqlite-vec` does not load
(`vec_enabled: false`) and vector search silently falls back to brute-force —
benchmarking a path prod never takes. That path is intentionally excluded here
and captured as THE-494 (deterministic-metric parity only).

## Architecture

New tree, sibling of the golden-set eval, sharing nothing with it:

```
packages/server/eval/perf/
  run.ts          # bun CLI entry: parse flags, run scenarios, write report.json
  harness.ts      # synthetic-vault construction + timing primitives
  scenarios.ts    # deterministic vault tiers (small / medium / large)
  collectors/     # one module per metric family; each returns typed samples
  report.ts       # Report/MetricSample types + json + markdown serialization
  baseline.json   # committed baseline: per-metric {value, tol, mode, class}
  gate.ts         # compare report vs baseline -> annotate + exit 1 on hard-fail
  README.md       # how to run, how to regenerate baseline, why bun-only
```

Each unit has one purpose and a typed interface:

- **harness.ts** — builds a synthetic vault + opens a real bun SQLite DB, and
  exposes timing primitives: `time()` (perf_hooks wall), `quantiles()` over N
  iterations, an event-loop-delay monitor (`perf_hooks.monitorEventLoopDelay`),
  and an RSS sampler. Depends on the server's real `indexer`/`search`/`db`.
- **scenarios.ts** — pure data: named vault tiers with fixed sizes and a fixed
  PRNG seed. No timing logic.
- **collectors/** — each collector takes `(vault, harness)` and returns
  `MetricSample[]`. One file per family keeps each small and independently
  testable. Collectors never decide pass/fail.
- **report.ts** — shapes and serializes results. No IO policy beyond writing the
  report artifact.
- **gate.ts** — the only unit that knows about pass/fail. Pure function
  `evaluate(report, baseline) -> GateResult`; `run.ts` maps a hard-fail to a
  non-zero exit.

## Determinism (the load-bearing property)

- **Seeded corpus.** A fixed PRNG seed generates identical notes, link graph,
  and duplicate-body set every run.
- **Deterministic embeddings.** The existing `src/embeddings/fake.ts` hash-based
  provider — no network, stable vectors.
- The synthetic corpus deliberately contains:
  - a **duplicate-body set** (M notes sharing bodies) to exercise the
    duplicate-embedding-ratio metric,
  - a **multi-hop link structure** to exercise graph candidate counts,
  - a small **in-repo synthetic labelled query set** for recall/nDCG. This is
    NOT the private golden set and shares nothing with it (avoids the THE-421
    leak class entirely); it is a throwaway relevance set whose only job is to
    make recall/nDCG deterministic and non-zero.
- **Tiers/scenarios:** `small` (~100 notes), `medium` (~1k notes),
  `large` (~10k chunks), so memory-per-10k-chunks and throughput are meaningful.

## Measurement methodology

- **Deterministic metrics** (counts, ratios, storage bytes) are measured once —
  the seed guarantees they are exact and run-independent.
- **Latency metrics** use explicit **warmup + N-iteration quantiles**: discard
  the first `W` warmup iterations, then report p50/p95/p99 over `N` measured
  iterations. Defaults `W=3`, `N=20`, both flag-configurable. (Standard
  microbenchmark practice; confirmed against `benchmark-action/github-action-
  benchmark` and the microbenchmark-variance literature during design research.)

## The 14 metric families

Every family is split into a **deterministic invariant (hard-fail)** and a
**latency figure (warn-only)**. This is the mechanism that makes "full 14-family
coverage" compatible with a trustworthy gate on noisy runners.

| # | Family | Hard-fail invariant (deterministic) | Warn-only figure (noisy) | Seam |
|---|---|---|---|---|
| 1 | MCP dispatch overhead | — | p50/p95/p99 = wall around `registry.dispatch` minus `toolDuration` histogram | `mcp/registry.ts:626`, `metrics/registry.ts` toolDuration |
| 2 | write-to-search freshness | becomes-visible == true | latency ms | write tool -> retrieval visibility |
| 3 | notes/chunks indexed per sec | exact chunk/note count | throughput (loose tol) | `search/indexer.ts` indexVault |
| 4 | embedding texts/tokens per sec | exact provider-call count | throughput | `embeddings/fake.ts` call counter |
| 5 | duplicate-embedding ratio | **ratio (absolute tol)** | — | provider-call count vs unique bodies |
| 6 | event-loop delay | — | ELU p99 under a load scenario | `perf_hooks.monitorEventLoopDelay` (net-new) |
| 7 | SQLite txn + lock duration | txn **count** | txn/lock duration | `db/*` transaction wrappers |
| 8 | graph candidate counts per stage | **counts per stage** | — | `search/graph_search.ts` stage instrumentation |
| 9 | recall/nDCG per ms | **recall/nDCG value** | per-ms | synthetic labelled set |
| 10 | peak memory per 10k chunks | — | peak RSS (loose tol) | RSS sampler |
| 11 | vec-model migration time | rebuilt == true | migration ms | `search/vec.ts` `ensureVecChunks` (dim/fingerprint swap) |
| 12 | HTTP cold/warm handshake | create + teardown ok | cold/warm ms | `transports/http.ts` server/transport build |
| 13 | shutdown drain time | drained-within-deadline == true | drain ms | index coordinator drain + sqlite close |
| 14 | per-vault CPU/storage | storage bytes per vault | CPU ms | DB file size + process CPU |

Notes:
- Family 1 needs no new instrumentation: the `toolDuration` prom histogram
  already records handler self-time, so dispatch overhead = measured wall −
  recorded handler time.
- Family 8 may require adding lightweight per-stage counters to `graph_search.ts`
  if none are exposed; this is additive and behavior-preserving, and it is also
  what THE-465 (staged retrieval) will consume later.

## Baseline + gate

`baseline.json` entry per metric:

```jsonc
{
  "index.chunks_per_s":   { "value": 4200, "tol": 0.15, "mode": "ratio", "class": "hard" },
  "embed.dup_ratio":      { "value": 0.00, "tol": 0.01, "mode": "abs",   "class": "hard" },
  "dispatch.p95_ms":      { "value": 12.0, "tol": 0.40, "mode": "ratio", "class": "warn" }
}
```

- `mode: ratio` → fail/warn when `|actual − value| / value > tol`.
- `mode: abs`   → fail/warn when `|actual − value| > tol`.
- `class: hard` → violation exits non-zero. `class: warn` → annotate only.
- **Directionality:** throughput/quality regressions (lower is worse) and
  cost/latency regressions (higher is worse) are both checked one-sided against
  the baseline so an improvement never trips the gate.
- **Baseline is hand-committed and updated deliberately.** Regenerate via
  `--update-baseline`; a baseline change is a reviewed diff with rationale in the
  PR. This is drift-safe by construction: slow regressions cannot silently become
  the new normal (the failure mode of auto-updating the baseline on `main`).
- The full `report.json` (all families, hard + warn) is always uploaded as a CI
  artifact regardless of gate outcome.

## CI wiring

- New `perf` job in `.github/workflows/ci-server.yml`: bun on a single
  `ubuntu-latest` runner (single runner for cross-run consistency; the matrix is
  for correctness, not perf).
- New scripts in `packages/server/package.json`:
  - `perf` → run the harness, write `report.json`.
  - `perf:gate` → run + compare vs `baseline.json`, exit non-zero on hard-fail.
- The job runs `perf:gate` and always uploads `report.json`.

## Testing the harness itself

- **Determinism test (vitest):** same seed → byte-identical deterministic
  metrics across two runs. Load-bearing — if this flakes, the gate is worthless.
- **Gate unit test (vitest):** `evaluate()` tolerance/class/mode logic, including
  one-sided directionality and the abs-vs-ratio branches.

## Risks

- **Runner variance** on latency families → mitigated by warmup+quantiles and by
  gating only deterministic invariants hard.
- **sqlite-vec availability in CI** under bun → the `perf` job must install the
  native path (not `--ignore-scripts`); verify sqlite-vec loads or the ANN
  families silently degrade.
- **graph_search stage counters** may not exist yet → additive instrumentation,
  behavior-preserving, reused by THE-465.

## Open questions

None blocking. Baseline numbers are established empirically by the first harness
run and committed as part of implementation.
