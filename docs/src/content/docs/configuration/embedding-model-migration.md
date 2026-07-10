---
title: Changing the embedding model
description: How to migrate obsidian-tc to a different embedding model or dimension — a coordinated re-embed, not a flag flip.
---

Changing `embeddings.model` (or `embeddings.dimensions`) is a **coordinated migration**, not a
drive-by config edit. The sqlite-vec (`vec_chunks`) table is created at a **fixed dimension**, and a
query vector must come from the **same model** as the stored document vectors, or cosine similarity
compares vectors from different spaces and recall collapses.

Treat a model change like a schema migration: plan it, run a full re-embed, and keep a rollback path.

## Why it is not a flag flip

- **Dimension is locked into the vector index.** `vec_chunks` is declared as `float[N]` at first
  index. A model whose output width differs from the stored `N` makes sqlite-vec reject the query (a
  dimension mismatch), and obsidian-tc's semantic path then falls back to the (correct but slower)
  brute-force scan. Stored vectors at the old dimension are not comparable to new ones.
- **Query and document vectors share the model by construction.** obsidian-tc uses one embedding
  provider for both indexing and querying, so there is no query/document split-brain to manage — the
  only risk is a mismatch between the *configured* model/dimension and the *stored* vectors.

## Pre-flight

1. **Confirm the new model's output dimension** and set `embeddings.dimensions` to it (or see
   [MRL truncation](#mrl-truncation) to store fewer than native).
2. **Confirm the provider is reachable**: `provider`, `baseUrl`, `apiKey` (for a hosted model), and
   for a local model that the runtime is up and the model pulled (e.g. `ollama pull qwen3-embedding:4b`).
3. **Note the cost/time.** A re-embed is proportional to chunk count: every chunk is re-sent to the
   provider. On a local runner this can be slow — tune `embeddings.timeoutMs`, `batchSize`,
   `maxBatchTokens`, and `concurrency` (see below) before a large reindex.

## The migration

1. **Edit the config**:

   ```json
   {
     "embeddings": {
       "provider": "ollama",
       "model": "qwen3-embedding:4b",
       "dimensions": 2560
     }
   }
   ```

2. **Drop the vector index** so it is recreated at the new dimension. Delete the cache database (it
   is a regenerable derivative of the vault) — `rm <cacheDir>/cache.db*` — or drop just `vec_chunks`
   if you want to keep other cached state. The next boot recreates `vec_chunks` at the new
   `dimensions`.

3. **Full reindex.** Start the server (the boot reconcile re-embeds the whole vault) or call
   `index_vault`. `chunk_embeddings`, `vec_chunks`, and the FTS/notes tables are rebuilt.

4. **Verify.** A `search_semantic` / `vault_graph_search` query should return sensible hits; a boot
   with no `[index] boot reconcile degraded` warning on stderr means the re-embed settled.

## MRL truncation

Matryoshka (MRL) models — Qwen3-Embedding, voyage-3, cohere embed-v4, openai text-embedding-3-large —
produce a wide native vector whose leading components are meaningful on their own. To store fewer
dimensions than the model emits, set `embeddings.truncate`:

```json
{
  "embeddings": {
    "provider": "ollama",
    "model": "qwen3-embedding:8b",
    "dimensions": 1024,
    "truncate": true
  }
}
```

With `truncate: true`, a returned vector wider than `dimensions` is truncated to the first
`dimensions` components and L2-renormalised. A **non-MRL** width mismatch (or a narrower-than-expected
vector) still errors rather than silently truncating meaningless prefixes, so leave `truncate` off
unless the model is genuinely MRL.

## Throughput knobs (local runners)

Local embedding runners are far slower than hosted APIs and can crash on a token-dense batch. The
reindex throughput is governed by:

| Field | Meaning | Default |
|---|---|---|
| `timeoutMs` | per-request embed timeout | 120000 |
| `batchSize` | max inputs per request | 512 |
| `maxBatchTokens` | max estimated tokens per request (splits a dense sub-batch) | 8192 |
| `concurrency` | embed requests in flight | 4 |

## Rollback

Revert `embeddings.model` + `dimensions` (+ `truncate`) to the previous values and reindex again.
Because stale vectors at the old dimension are incompatible with the new one, there is no partial
state to clean up — the reindex re-converges the store to whatever the config declares.
