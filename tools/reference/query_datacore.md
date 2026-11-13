---
title: "query_datacore"
description: "Run a Datacore query using its own query language (e.g."
editUrl: false
---

Run a Datacore query using its own query language (e.g. `@page and #tag`, `@task and $completed = false`) and return matching pages/blocks with their path, name, tags, types, and frontmatter fields. Datacore is Dataview's successor; use search_dql for classic Dataview DQL.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:datacore` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:search` |
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
| `query` | `string` | yes | — | length ≥ 1 |
| `limit` | `integer` |  | `50` | range 1–500 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `items` | `any[]` | yes | — |
| `total` | `integer` | yes | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `search` domain: [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
