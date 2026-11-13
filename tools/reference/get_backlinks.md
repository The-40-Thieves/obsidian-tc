---
title: "get_backlinks"
description: "Find every note that links to the given note, with source line/column."
editUrl: false
---

Find every note that links to the given note, with source line/column. A quoted wikilink in a property counts, tagged source=property with the property name. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`. response_format=concise returns \{source_path, line\} per backlink, without col, raw, kind and display.

| | |
|---|---|
| **Domain** | links |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:links` |
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
| `path` | `string` | yes | — | length 1–1024 |
| `limit` | `integer` |  | `100` | range 1–5000 |
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
| `path` | `string` | yes | — |
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `truncated` | `boolean` | yes | — |
| `next_cursor` | `string \| null` | yes | — |
| `backlinks` | `object[]` | yes | — |
| `backlinks[].source_path` | `string` | yes | — |
| `backlinks[].line` | `integer` | yes | range ≥ -9007199254740991 |
| `backlinks[].col` | `integer` |  | range ≥ -9007199254740991 |
| `backlinks[].raw` | `string` |  | — |
| `backlinks[].kind` | `enum` |  | One of: `"wikilink"`, `"markdown"`, `"embed"` |
| `backlinks[].display` | `string \| null` |  | — |
| `backlinks[].source` | `enum` |  | One of: `"property"` |
| `backlinks[].property` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
