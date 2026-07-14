# Densification experiment: raw data (2026-07-14)

Per-query results for every arm in the graph-densification experiment, plus the walk-latency benchmark.
Published so the statistics in
[../../2026-07-14-densification-measurement.md](../../2026-07-14-densification-measurement.md) can be
checked without access to the vault.

## Reproducing the headline numbers

```
cd packages/server
bun eval/compare.ts <A>.json <B>.json      # paired by query id; permutation p + bootstrap CI
```

| command | expected |
|---|---|
| `compare ctl.json tag.json` | dNDCG **+0.004**, CI [0.001, 0.010], **p=0.0102** |
| `compare ctl.json knn.json` | dNDCG -0.001, p=0.83 |
| `compare ctl.json knn80.json` | dNDCG +0.001, CI [-0.003, 0.004], p=0.6074 |
| `compare ctl.json knn80-strict.json` | dNDCG +0.001, CI [-0.003, 0.004], p=0.6074 (the rounding-boundary check: identical) |
| `compare ctl.json trt.json` | dNDCG +0.002, p=0.51 |
| `compare tag.json trt.json` | dNDCG -0.002, CI [-0.006, 0.000], **p=0.3164** (adding kNN on top of tag: no significant change) |

## Arms

| file | composition |
|---|---|
| `ctl.json` | control — authored edges only (10,828 `links_to` + 205 `unresolved`) |
| `tag.json` | control + 8,377 `shared_tag` |
| `knn.json` | control + 5,754 `similar_to` (k=8, no floor) |
| `knn80.json` | control + 3,173 `similar_to` (confidence >= 0.80) |
| `knn80-strict.json` | control + 3,122 `similar_to` (confidence > 0.80) |
| `trt.json` | control + both derived layers |
| `bench-walk.json` | graph-walk latency (the mechanism), both arms, sampling protocol inline |
| `bench-serve.json` | `graphSearch()` serving latency (the bill), both arms, protocol inline |

Every arm is the SAME index snapshot (nomic-768, `chunkContext: true`) with different edge rows, so the
embeddings are byte-identical across arms and only the graph differs.

## The two benchmarks are not the same number

`bench-walk` measures the graph expansion alone: **2.6-2.75x**. `bench-serve` measures `graphSearch()`,
which is what a query actually runs — dense retrieval, the walk, RRF fusion, scoring: **1.48x**, or
**+44%** user-visible once the (arm-independent) 34 ms query embedding is added. The walk ratio is the
mechanism's cost; the serving ratio is what anyone actually pays. Do not quote the first as the second.

Neither is the wall clock of `eval/run.ts` — that harness runs a semantic baseline search *and* a graph
search per query in order to compare them, so its timings describe the harness, not a serving path. An
earlier version of the record made exactly that mistake.

## What is and is not here

Metrics only. **Query ids are random opaque tokens** (class prefix preserved), generated once from a
CSPRNG with the mapping discarded. They are deliberately NOT hashes of the originals: the originals are
low-entropy title-derived slugs, so a digest — even a truncated one — would be dictionary-attackable by
anyone holding a list of candidate note titles. `compare.ts` only needs ids to be stable *across arms*,
never to be derived from anything. The per-class split works off the prefix.

No note paths, no note content, no vault structure. The benchmark artifacts were aggregate-only to begin
with.
