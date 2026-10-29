---
title: Storage state and index resets
description: Which server state must be preserved when rebuilding a search index.
---

`cacheDir` contains both rebuildable indexes and durable state. The name `cache.db` does not mean
that deleting the file is a safe index reset.

| State | Ownership and recovery |
|---|---|
| Vault Markdown and attachments | Authored files; back up the vault independently. |
| Search chunks, embeddings and FTS/vector indexes in `cache.db` | Derived from readable vault content and the configured embedding representation; rebuilding may require model access and time. |
| Memory entities, observations and relations in `cache.db` | SQLite is the source of truth. Materialized Markdown is a projection, not a complete database backup. |
| `write_provenance` and `write_provenance_heads` in `cache.db` | Write-attribution history and chain anchors. Reindexing does not restore them. |
| Other `cache.db` operational state | Includes confirmations, idempotency records, captures, sessions, snapshots and event history. Preserve it unless intentionally applying its specific retention/reset policy. |
| `experiential.db` | Captured retrieval/episode history and derived signals. A fresh index does not reproduce the history. An intentional experiential reset is a separate operation. |
| `<cacheDir>/auth.db` and `auth-keys/` | Revocations, key retirement, signing keys and registry markers. Back them up together; registry-loss recovery is described in the [auth model](../../security/auth-model/). |
| `server-secrets/` | Keys used for wiki seals and HITL confirmation state. Preserve them with the deployment state. |

Stop all processes sharing the state directory before making a cold backup, or use a backup method
that guarantees a consistent SQLite snapshot. Do not copy just a live `.db` file while ignoring
its WAL, and do not delete database files as a shortcut for search maintenance.

## Resetting the search index

Use `reset_vault_cache` with its confirmation flow. It is scoped to a vault and selected table
families, not an entire database file. The default includes chunks, embeddings and idempotency keys;
event-log and committed-capture deletion are opt-in. To preserve operational history while forcing
a fresh index, explicitly set `include.idempotency_keys`, `include.event_log` and
`include.capture_committed` to `false`, with `include.chunks` and `include.embeddings` set to `true`.
Chunk deletion also clears associated chunk FTS/vector entries and may cascade to dependent
derived rows. Memory entities/relations/observation history and write-provenance rows/heads are
outside the tool's reset table set.

The tool does not itself perform a reindex. Follow it with `index_vault` or completed boot
reconciliation, and verify retrieval. For a model or dimension change, follow the coordinated
[embedding migration procedure](../embedding-model-migration/), including all processes and vaults
that share the database.

For cleanup of superseded embedding generations only, use `include.chunks: false` and
`include.embeddings: "inactive"`; leaving chunks enabled would also delete their active embeddings.
Choose the remaining flags explicitly according to the state you intend to retain.
