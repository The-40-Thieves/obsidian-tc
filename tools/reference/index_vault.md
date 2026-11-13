---
title: "index_vault"
description: "Chunk and embed the vault (or a folder) into the search index."
editUrl: false
---

Chunk and embed the vault (or a folder) into the search index. Incremental: chunks whose content hash is unchanged are skipped; removed chunks are pruned. response_format=concise drops the bookkeeping counters and keeps the failure, skip and degradation signals.

| | |
|---|---|
| **Domain** | vault |
| **Scopes** | `admin:vault` |
| **Access** | write |
| **Tags** | `read-only`, `admin`, `domain:vault`, `external-network` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | yes |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `folder` | `string` |  | — | length 1–1024 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` |  | — |
| `notes_seen` | `number` |  | — |
| `notes_indexed` | `number` |  | — |
| `chunks_upserted` | `number` |  | — |
| `chunks_deleted` | `number` |  | — |
| `chunks_unchanged` | `number` |  | — |
| `edges_inserted` | `number` |  | — |
| `edges_deleted` | `number` |  | — |
| `secrets_skipped` | `number` |  | — |
| `vec_enabled` | `boolean` |  | — |
| `fts_enabled` | `boolean` |  | — |
| `notes_upserted` | `number` |  | — |
| `notes_deleted` | `number` |  | — |
| `notes_embed_failed` | `number` |  | — |
| `chunks_dedup_reused` | `number` |  | — |
| `chunks_dedup_unresolved` | `number` |  | — |
| `embed_batch_rejections` | `number` |  | — |
| `notes_stale_skipped` | `number` |  | — |
| `notes_epoch_stale_skipped` | `number` |  | — |
| `notes_frontmatter_failed` | `number` |  | — |
| `frontmatter_failures` | `object[]` |  | — |
| `frontmatter_failures[].path` | `string` | with parent | — |
| `frontmatter_failures[].error` | `string` | with parent | — |
| `notes_read_refused` | `number` |  | — |
| `read_refusals` | `object[]` |  | — |
| `read_refusals[].path` | `string` | with parent | — |
| `read_refusals[].error` | `string` | with parent | — |
| `model` | `string` |  | — |
| `dimensions` | `number` |  | — |
| `status` | `enum` |  | One of: `"working"` |

_4 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`get_vault`](/tools/reference/get_vault/), [`list_vaults`](/tools/reference/list_vaults/), [`refresh_plugin_capabilities`](/tools/reference/refresh_plugin_capabilities/), [`reload_vault`](/tools/reference/reload_vault/), [`reset_vault_cache`](/tools/reference/reset_vault_cache/).

Back to the [tool catalog](/tools/tool-catalog/).
