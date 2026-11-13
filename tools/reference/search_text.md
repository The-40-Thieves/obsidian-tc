---
title: "search_text"
description: "Literal text search across vault notes (BM25-ranked)."
editUrl: false
---

Literal text search across vault notes (BM25-ranked). Supports case_sensitive and whole_word; scoped to an optional root folder. response_format=concise (legacy alias verbosity=terse) drops line/col, keeping path/score/snippet.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:search` |
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
| `query` | `string` | yes | — | length ≥ 1 |
| `case_sensitive` | `boolean` |  | `false` | — |
| `whole_word` | `boolean` |  | `false` | — |
| `root` | `string` |  | — | length 1–1024 |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode_used` | `enum` | yes | One of: `"text"` |
| `items` | `object[]` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].score` | `number` | yes | — |
| `items[].snippet` | `string` | yes | — |
| `items[].line` | `number` |  | — |
| `items[].col` | `number` |  | — |
| `total` | `number` | yes | — |
| `next_cursor` | `string` |  | — |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
