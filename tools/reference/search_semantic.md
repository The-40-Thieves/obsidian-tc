---
title: "search_semantic"
description: "Dense-vector retrieval over the chunk store (run index_vault first)."
editUrl: false
---

Dense-vector retrieval over the chunk store (run index_vault first). Returns the top-k chunks by cosine similarity. response_format=concise (legacy alias verbosity=terse) drops chunk content/metadata, returning path/score/chunk_id only.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:search`, `external-network` |
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
| `k` | `integer` |  | `10` | range 1–100 |
| `root` | `string` |  | — | length 1–1024 |
| `min_score` | `number` |  | — | — |
| `return_content` | `boolean` |  | `true` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode_used` | `enum` | yes | One of: `"semantic"` |
| `items` | `object[]` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].score` | `number` | yes | — |
| `items[].content` | `string` |  | — |
| `items[].chunk_id` | `string` |  | — |
| `items[].embedding_model` | `string` |  | — |
| `items[].age_days` | `number` |  | — |
| `items[].stale` | `boolean` |  | — |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
