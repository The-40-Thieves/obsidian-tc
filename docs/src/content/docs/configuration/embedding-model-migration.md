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

1. **Pause ordinary clients and background writers, and back up the state.** Stop every server
   process sharing this `cacheDir` before taking a consistent backup of the directory and your
   config. `cache.db` contains durable write provenance and the source-of-truth memory entity graph;
   a vault reindex cannot restore them. Keep `experiential.db`, `<cacheDir>/auth.db`, `auth-keys/` and
   `server-secrets/` too. See [Storage state and index resets](../storage-state/).

2. **Clear only the index rows through the existing tool.** Start one administrative server with
   the old config, keep ordinary clients and writes paused, and call `reset_vault_cache` for each
   affected vault. This requires `admin:vault` and the normal confirmation flow. Use these explicit
   input flags so the reset keeps idempotency records, event history and committed captures:

   ```json
   {
     "vault": "your-vault-id",
     "include": {
       "chunks": true,
       "embeddings": true,
       "idempotency_keys": false,
       "event_log": false,
       "capture_committed": false
     }
   }
   ```

   The tool deletes that vault's chunks and embeddings, with the corresponding chunk FTS/vector
   entries. It leaves the database files, memory graph and write-provenance chain in place. Chunk
   deletion can also remove dependent derived rows through foreign keys. This reset is destructive
   to the selected index; it does not preserve an old-vector rollback copy. Wait for any old-config
   indexing work to finish before resetting, then stop the administrative server.

3. **Edit the config** and use it consistently for every process sharing the database:

   ```json
   {
     "embeddings": {
       "provider": "ollama",
       "model": "qwen3-embedding:4b",
       "dimensions": 2560
     }
   }
   ```

4. **Full reindex.** Start the server with the new config and let boot reconciliation complete, or
   call `index_vault` for every affected vault. The indexer recreates the sqlite-vec table when its
   representation fingerprint or dimensions change and embeds the missing chunks. You do not need
   to delete a database file or issue manual `DROP TABLE` statements. The vector table is shared,
   so a representation change can affect every vault using that database; coordinate their reindex.

5. **Verify before resuming clients.** Check index status and reconcile health, investigate any
   degraded or skipped-note result, and exercise `search_semantic` / `vault_graph_search` against
   known notes. A successful process start alone does not prove the re-embed completed.

An ordinary model-identity change already causes unchanged notes to be re-embedded during
reconciliation. The explicit reset above also forces fresh embeddings for representation changes
that retain the same provider/model ID, such as a changed document prefix or output dimensions.
It avoids relying on a vector-table rebuild to regenerate document embeddings: rebuilding that
table can copy existing embedding rows and is not, by itself, a full re-embed.

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
| `maxBatchTokens` | max estimated tokens per request (splits a dense sub-batch) | 2048 |
| `concurrency` | embed requests in flight | 4 |

`maxBatchTokens` must stay under the provider's **loaded context** — Ollama defaults to `n_ctx`
4096 and rejects (HTTP 400) any request whose summed tokens exceed it, and the internal chars/4
estimate undercounts real tokenization (~2-2.5x on link-dense markdown). A rejected batch is
bisected and retried automatically (extra round-trips, logged to stderr); a chunk rejected even as
a single-text request is quarantined — its note is skipped that pass, reported via
`notes_embed_failed` and degraded reconcile health, and retried on the next reconcile.

## Rollback

Restore the previous embedding configuration, including provider, model, dimensions, revision,
prefixes and truncation, then repeat the same table-scoped reset and reindex procedure. Keep clients
paused until the old representation is usable again. A partially completed migration can contain
mixed embedding generations; do not assume changing the config alone has already repaired them.
Restore database backups only as a coordinated state restore, accounting for any writes made since
the backup.
