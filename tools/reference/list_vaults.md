---
title: "list_vaults"
description: "List configured vaults and their cache state."
editUrl: false
---

List configured vaults and their cache state. Domain: vault.

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

This tool takes no parameters.

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vaults` | `object[]` | yes | — |
| `vaults[].id` | `string` | yes | — |
| `vaults[].name` | `string` | yes | — |
| `vaults[].kind` | `string` | yes | — |
| `vaults[].path` | `string` | yes | — |
| `vaults[].read_only` | `boolean` | yes | — |
| `vaults[].embeddings_provider` | `string` | yes | — |
| `vaults[].chunk_count` | `integer` | yes | range ≥ -9007199254740991 |
| `vaults[].last_synced_at` | `null` | yes | — |

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`get_vault`](/tools/reference/get_vault/), [`index_vault`](/tools/reference/index_vault/), [`refresh_plugin_capabilities`](/tools/reference/refresh_plugin_capabilities/), [`reload_vault`](/tools/reference/reload_vault/), [`reset_vault_cache`](/tools/reference/reset_vault_cache/).

Back to the [tool catalog](/tools/tool-catalog/).
