---
title: "search_and_read"
description: "Search a vault and return the top-k full notes in one call, instead of a search followed by read_notes."
editUrl: false
---

Search a vault and return the top-k full notes in one call, instead of a search followed by read_notes. Ranking is vault_graph_search's, limited to notes you can read. mode=note (default) returns each note's frontmatter and body; mode=section returns the heading section each hit matched. Every item carries chunk_id, the chunk it was ranked by (pass it to record_retrieval_feedback). k is at most 20. The result is held under the server's byte budget, shared equally across the notes: a note over its share is cut and marked truncated: true with size_bytes (its full size); fetch it whole with read_note. Anything that still does not fit comes back with next_cursor: repeat the same call plus cursor until it is null. An item that cannot be returned is a per-item error with its rank (a missing note and an unreadable one look the same). A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns \{path, rank, score, body, content_hash, chunk_id\} per note, without frontmatter in note mode; size_bytes and truncated appear only on a truncated item, and section_resolved only when false.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:search`, `knowledge`, `search`, `external-network` |
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
| `k` | `integer` |  | `5` | range 1–20 |
| `mode` | `enum` |  | `"note"` | One of: `"note"`, `"section"` |
| `max_bytes_per_item` | `integer` |  | — | Cap on one returned item's serialized bytes. Default: an equal share of the response budget. range ≥ 512 |
| `cursor` | `string` |  | — | The next_cursor of a previous page of this same request. length 1–4096 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode` | `enum` | yes | One of: `"note"`, `"section"` |
| `notes` | `object[]` | yes | — |
| `notes[].path` | `string` | yes | — |
| `notes[].rank` | `integer` | yes | range ≥ 1 |
| `notes[].score` | `number` | yes | — |
| `notes[].chunk_id` | `string` |  | — |
| `notes[].heading` | `string \| null` |  | — |
| `notes[].section_resolved` | `boolean` |  | — |
| `notes[].frontmatter` | `object \| null` |  | — |
| `notes[].body` | `string` | yes | — |
| `notes[].content_hash` | `string` | yes | — |
| `notes[].size_bytes` | `integer` |  | range ≥ 0 |
| `notes[].truncated` | `boolean` |  | — |
| `errors` | `object[]` | yes | — |
| `errors[].rank` | `integer` | yes | range ≥ 1 |
| `errors[].path` | `string` |  | — |
| `errors[].code` | `string` | yes | — |
| `errors[].message` | `string` | yes | — |
| `errors[].size` | `number` |  | — |
| `errors[].budget` | `number` |  | — |
| `next_cursor` | `string \| null` | yes | — |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
