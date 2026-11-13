---
title: "refresh_plugin_capabilities"
description: "Re-probe the companion plugin for a vault and atomically replace the cached capability snapshot, so installing/enabling a plugin or upgrading the companion takes effect WITHOUT a server restart."
editUrl: false
---

Re-probe the companion plugin for a vault and atomically replace the cached capability snapshot, so installing/enabling a plugin or upgrading the companion takes effect WITHOUT a server restart. Returns what changed (companion state, plugin/version deltas), not a bare ok. Admin-scoped, no HITL.

| | |
|---|---|
| **Domain** | vault |
| **Scopes** | `admin:vault` |
| **Access** | write |
| **Tags** | `read-only`, `admin`, `domain:vault`, `plugin-bridge` |
| **Profile** | full only |

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
| `changed` | `boolean` | yes | — |
| `companion` | `enum` | yes | One of: `"reachable"`, `"missing"`, `"unreachable"` |
| `pluginCount` | `integer` | yes | range ≥ -9007199254740991 |
| `changes` | `object[]` | yes | — |
| `changes[].field` | `string` | yes | — |
| `changes[].before` | `string` | yes | — |
| `changes[].after` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `vault` domain: [`add_vault`](/tools/reference/add_vault/), [`get_vault`](/tools/reference/get_vault/), [`index_vault`](/tools/reference/index_vault/), [`list_vaults`](/tools/reference/list_vaults/), [`reload_vault`](/tools/reference/reload_vault/), [`reset_vault_cache`](/tools/reference/reset_vault_cache/).

Back to the [tool catalog](/tools/tool-catalog/).
