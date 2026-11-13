---
title: "reset_vault_cache"
description: "Drop the SQLite cache for a vault (chunks, embeddings, idempotency keys; optionally the event log and committed capture_queue rows)."
editUrl: false
---

Drop the SQLite cache for a vault (chunks, embeddings, idempotency keys; optionally the event log and committed capture_queue rows). include.embeddings accepts true (drop every embedding row), false, or "inactive" (drop only superseded embedding generations, keeping the vault's active vectors and search working — pass include.chunks: false too, or the default include.chunks: true cascades and drops the active rows as well). Destructive — requires confirmation.

| | |
|---|---|
| **Domain** | vault |
| **Scopes** | `admin:vault` |
| **Access** | destructive |
| **Tags** | `writes`, `destructive`, `hitl`, `admin`, `domain:vault` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `include` | `object` |  | `{}` | — |
| `include.chunks` | `boolean` |  | `true` | — |
| `include.embeddings` | `boolean \| enum` |  | — | — |
| `include.idempotency_keys` | `boolean` |  | `true` | — |
| `include.event_log` | `boolean` |  | `false` | — |
| `include.capture_committed` | `boolean` |  | `false` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `reset_at` | `string` | yes | — |
| `rows_dropped` | `object` | yes | — |
| `rows_dropped.chunks` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.vec_chunks` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.chunk_fts` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.embeddings` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.idempotency_keys` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.event_log` | `integer` | yes | range ≥ -9007199254740991 |
| `rows_dropped.capture_committed` | `integer` | yes | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`get_vault`](/tools/reference/get_vault/), [`index_vault`](/tools/reference/index_vault/), [`list_vaults`](/tools/reference/list_vaults/), [`refresh_plugin_capabilities`](/tools/reference/refresh_plugin_capabilities/), [`reload_vault`](/tools/reference/reload_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
