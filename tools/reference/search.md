---
title: "search"
description: "Search the vault for notes matching a natural-language query and return citable results: {results: [{id, title, url, text}]}, best first, one per note."
editUrl: false
---

Search the vault for notes matching a natural-language query and return citable results: \{results: [\{id, title, url, text\}]\}, best first, one per note. Use this to find notes before answering from them; pass a result's id to fetch for the full note. url is an absolute link to the note (a published https url when the vault configures one, else an obsidian:// link). Hybrid text + semantic search; only notes the caller may read appear.

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
| `query` | `string` | yes | — | length 1–2000 |
| `limit` | `integer` |  | `10` | range 1–50 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `results` | `object[]` | yes | — |
| `results[].id` | `string` | yes | — |
| `results[].title` | `string` | yes | — |
| `results[].url` | `string` | yes | — |
| `results[].text` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
