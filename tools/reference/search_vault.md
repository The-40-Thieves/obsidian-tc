---
title: "search_vault"
description: "Unified search dispatch."
editUrl: false
---

Unified search dispatch. mode=auto routes a string query text->semantic (fallback on zero hits) and an object query to jsonlogic; or force text/regex/semantic/jsonlogic/dql. Set response_format=concise (legacy alias verbosity=terse) to compact each hit to path/score/snippet, keeping chunk_id on hits that carry one.

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
| `query` | `string \| object` | yes | — | — |
| `mode` | `enum` |  | `"auto"` | One of: `"auto"`, `"text"`, `"regex"`, `"dql"`, `"jsonlogic"`, `"semantic"` |
| `root` | `string` |  | — | length 1–1024 |
| `explain` | `boolean` |  | `false` | — |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `warnings` | `object[]` |  | — |
| `warnings[].path` | `string` | with parent | — |
| `warnings[].reason` | `enum` | with parent | One of: `"frontmatter_yaml"` |
| `warnings[].message` | `string` | with parent | — |
| `warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `mode_used` | `string` | yes | — |
| `headers` | `string[]` |  | — |
| `rows` | `any[][]` |  | — |
| `note_paths` | `string[]` |  | — |
| `items` | `any[]` |  | — |
| `total` | `number` |  | — |
| `next_cursor` | `string` |  | — |
| `_explain` | `object` |  | — |
| `_explain.modes_tried` | `string[]` | with parent | — |
| `_explain.chosen` | `string` | with parent | — |
| `_explain.reason` | `string` | with parent | — |
| `mode_source` | `enum` |  | One of: `"explicit"`, `"preference"`, `"default"` |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/).

Back to the [tool catalog](/tools/tool-catalog/).
