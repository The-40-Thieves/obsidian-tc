---
title: Performance benchmarks
description: Reproducible cold-boot, indexing, retrieval and HTTP numbers for obsidian-tc, recorded on a public CI runner with a variance gate that refuses a noisy run.
---

Every number on this page was recorded by `packages/server/eval/perf` on a GitHub-hosted
`ubuntu-latest` runner, committed to the repository as a baseline, and gated on each subsequent
push. Nothing here was measured by hand.

:::note[What makes these reproducible rather than merely published]
The harness **refuses to record** a run whose own calibration channels look contended. That refusal
is the feature: a benchmark that always produces a number produces a number even when the machine
was busy. The gate, the thresholds and the raw sample series are all in the repository, so a third
party can re-run the same workflow and compare like for like.
:::

## Method

- **Fresh subprocess per sample, median aggregation** (`eval/perf/isolate.ts`). Timing a loop inside
  a process that already ran it measures a warm JIT, not the operation.
- **5 samples per key**, recorded in `isolated-median` mode.
- **Two calibration channels** run alongside the measurement and decide whether it counts at all
  (`eval/perf/contention.ts`):

  | channel | CV threshold | max/median | reference tolerance |
  | --- | --- | --- | --- |
  | `cpuMs` | 0.20 | 1.6 | 0.5 |
  | `ioMs` | **0.45** | 2.5 | 1.0 |

  The I/O bound is deliberately looser than CPU's: a quiet reference host was itself measured at
  io CV 0.229, so a 0.2 bound would refuse clean recordings.

- **Recorded at** `9d1b2fbf`, 2026-08-09, on `linux / x64 / 4 CPUs`.

### What the runner actually achieved

| scenario | `cpuMs` CV | of allowance | `ioMs` CV | of allowance |
| --- | --- | --- | --- | --- |
| `small` | 0.0175 | 8.8% | 0.0578 | 12.8% |
| `densify` | 0.0267 | 13.4% | 0.0627 | 13.9% |

Both recordings used well under a sixth of the variance they were allowed.

:::caution[The sampling is biased, and that has to be said]
Reporting only runs that clear a variance gate is a **selected sample** of runner conditions. Stated
honestly: **6 of 6 isolated dispatches cleared the gate, and 0 of 2 batched dispatches did.**

The two failures are methodology, not the runner. GitHub holds only **one** pending run per
concurrency group, so firing five dispatches at once cancelled three and let two race each other —
they recorded io CV 0.641 and 1.642, 3.6× and 9.2× the sequential maximum, and were refused.
**Dispatch sequentially, or the measurement measures itself.**
:::

## Scenarios

Both scenarios build the same synthetic corpus from a fixed seed (`0x5eed`): **100 notes → 200
chunks**, 20 duplicate-body groups, link fan-out 3. `densify` differs in exactly one axis —
derived-edge densification (`tagEdges` + `knnEdges`) is ON. Holding the corpus identical is what
makes the pair a clean A/B on densification cost.

## `small` — the default path

| | value |
| --- | --- |
| **Cold boot** | |
| module evaluation | 261.53 ms |
| tool registration (157 tools) | 24.32 ms |
| first `tools/list` | 36.44 ms |
| **Indexing** | |
| chunks/s | 1,583.25 |
| notes/s | 791.63 |
| embed tokens/s | 20,400.18 |
| **Retrieval** | |
| nDCG@10 | 0.8414 |
| recall@10 | 0.9600 |
| **HTTP** | |
| cold request | 28.50 ms |
| warm request | 1.25 ms |
| 8-way concurrent p99 | 5.04 ms |
| **Runtime** | |
| peak RSS | 144.52 MB |
| event-loop p99 | 66.42 ms |
| shutdown | 0.09 ms |

A warm HTTP request is **22.8× faster** than a cold one, which is the connection-reuse path doing
its job rather than a caching claim about retrieval.

## `densify` — what derived edges cost

Same corpus, densification on. It produces 865 shared-tag edges and 533 kNN edges — **1,398 edges
across 200 chunks, ~7.0 per chunk** — and the cost lands on ingest:

| | `small` | `densify` | delta |
| --- | --- | --- | --- |
| index chunks/s | 1,583.25 | 681.24 | **−57.0%** |
| embed tokens/s | 20,400.18 | 8,777.75 | **−57.0%** |
| storage bytes | 1,241,088 | 1,572,864 | +26.7% |
| peak RSS | 144.52 MB | 167.68 MB | +16.0% |
| nDCG@10 | 0.8414 | 0.8577 | — |

:::caution[Do not read the nDCG column as a densification win]
These are two separate baseline recordings on a **synthetic 100-note corpus**, not a paired A/B with
a significance test. The retrieval ship rule for this project is a paired permutation test on a
real golden set, and by that rule deterministic densification measured **flat** — see
[the published negative result](https://github.com/the-40-thieves/obsidian-tc/blob/main/docs/EVALUATION.md#published-negative-results).
The number above is a regression tripwire, not evidence.
:::

## What these numbers are not

- **Not a competitive comparison.** No other Obsidian MCP server has been run through this harness.
- **Not retrieval quality evidence.** The corpus is synthetic and 100 notes. Retrieval quality is
  measured separately, on a public third-party corpus, in
  [EVALUATION.md](https://github.com/the-40-thieves/obsidian-tc/blob/main/docs/EVALUATION.md).
- **Not a merge gate.** The `perf` CI job runs `if: github.event_name == 'push'` — post-merge on
  `main` only, never on a PR, and deliberately not among the required checks. It is a trend signal.
- **Not a large-vault claim.** These are 200-chunk scenarios. Scale scenarios exist in the harness
  (`vault1k`, `medium`, `large`, `vault100k`) but are not part of the committed baseline.

## Reproducing this

```bash
gh workflow run perf-baseline.yml --ref main -f scenario=small
```

Dispatch **one at a time** and wait for each to finish — see the caution above. The workflow hands
back the recording as an artifact; `packages/server/eval/perf/README.md` documents the recording
and re-baselining procedure.

A baseline is a *recording*, not a config file. Hand-editing a value fails the provenance coherence
check: the sidecar snapshots every exact-class key at record time, so an edited key means the timing
keys beside it were measured against a different build.
