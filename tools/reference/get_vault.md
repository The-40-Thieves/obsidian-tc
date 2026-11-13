---
title: "get_vault"
description: "Inspect a single vault's configuration and cache state."
editUrl: false
---

Inspect a single vault's configuration and cache state.

| | |
|---|---|
| **Domain** | vault |
| **Scopes** | `read:vault` |
| **Access** | read |
| **Tags** | `read-only`, `domain:vault` |
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

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `id` | `string` | yes | — |
| `name` | `string` | yes | — |
| `path` | `string` | yes | — |
| `read_only` | `boolean` | yes | — |
| `acl` | `object` | yes | — |
| `acl.read_paths` | `string[] \| null` | yes | — |
| `acl.write_paths` | `string[] \| null` | yes | — |
| `acl.delete_paths` | `string[] \| null` | yes | — |
| `embeddings` | `object` | yes | — |
| `embeddings.provider` | `string` | yes | — |
| `embeddings.model` | `string` | yes | — |
| `cache` | `object` | yes | — |
| `cache.chunk_count` | `integer` | yes | range ≥ -9007199254740991 |
| `cache.last_synced_at` | `null` | yes | — |
| `cache.db_size_bytes` | `integer` | yes | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`index_vault`](/tools/reference/index_vault/), [`list_vaults`](/tools/reference/list_vaults/), [`refresh_plugin_capabilities`](/tools/reference/refresh_plugin_capabilities/), [`reload_vault`](/tools/reference/reload_vault/), [`reset_vault_cache`](/tools/reference/reset_vault_cache/).

Back to the [tool catalog](/tools/tool-catalog/).
