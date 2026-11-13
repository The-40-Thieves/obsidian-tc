---
title: "search_dql"
description: "Run a Dataview DQL query via the companion plugin bridge."
editUrl: false
---

Run a Dataview DQL query via the companion plugin bridge. Returns headers/rows and the matched note paths. Requires the Dataview bridge; reports plugin_missing when it is not configured.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:notes`, `read:dataview` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:search` |
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
| `dql` | `string` | yes | — | length ≥ 1 |
| `format` | `enum` |  | `"table"` | One of: `"table"`, `"list"`, `"task"`, `"calendar"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `headers` | `string[]` |  | — |
| `rows` | `any[][]` | yes | — |
| `note_paths` | `string[]` | yes | — |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
