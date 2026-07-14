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
| `bench-walk.json` | graph-walk latency, both arms, with its sampling protocol inline |

Every arm is the SAME index snapshot (nomic-768, `chunkContext: true`) with different edge rows, so the
embeddings are byte-identical across arms and only the graph differs.

## What is and is not here

Metrics only. **Query ids are hashed** (`sha256(id)[0:12]`, class prefix preserved) because the originals
are topic slugs derived from real note titles. Hashing is deterministic, so arms still pair on id — which
is all `compare.ts` needs — and the per-class split still works off the prefix. No note paths, no note
content, no vault structure. `bench-walk.json` was aggregate-only to begin with.
