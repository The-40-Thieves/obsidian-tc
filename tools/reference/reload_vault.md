---
title: "reload_vault"
description: "Re-read a vault's configuration from disk (does not touch the cache)."
editUrl: false
---

Re-read a vault's configuration from disk (does not touch the cache).

| | |
|---|---|
| **Domain** | vault |
| **Scopes** | `admin:vault` |
| **Access** | write |
| **Tags** | `read-only`, `admin`, `domain:vault` |
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
| `vault` | `string` | yes | — |
| `reloaded_at` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`get_vault`](/tools/reference/get_vault/), [`index_vault`](/tools/reference/index_vault/), [`list_vaults`](/tools/reference/list_vaults/), [`refresh_plugin_capabilities`](/tools/reference/refresh_plugin_capabilities/), [`reset_vault_cache`](/tools/reference/reset_vault_cache/).

Back to the [tool catalog](/tools/tool-catalog/).
