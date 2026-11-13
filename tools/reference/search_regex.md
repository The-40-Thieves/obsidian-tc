---
title: "search_regex"
description: "Regular-expression search across vault notes."
editUrl: false
---

Regular-expression search across vault notes. Each match returns line/col + the matched text; capped per file. Pattern length is bounded, patterns with nested quantifiers are rejected, and execution is time-budgeted (governor.regexTimeoutMs) to prevent catastrophic backtracking; flags may only be i, m, s, u.

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
| `pattern` | `string` | yes | — | length 1–1000 |
| `flags` | `string` |  | `"i"` | length ≤ 8; pattern `^[imsu]*$` |
| `root` | `string` |  | — | length 1–1024 |
| `max_matches_per_file` | `integer` |  | `10` | range 1–1000 |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode_used` | `enum` | yes | One of: `"regex"` |
| `items` | `object[]` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].snippet` | `string` | yes | — |
| `items[].line` | `number` |  | — |
| `items[].col` | `number` |  | — |
| `items[].match` | `string` |  | — |
| `total` | `number` | yes | — |
| `next_cursor` | `string` |  | — |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
