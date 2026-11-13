---
title: "get_outgoing_links"
description: "List a note's outgoing links (code-block links excluded), each resolved to a target path."
editUrl: false
---

List a note's outgoing links (code-block links excluded), each resolved to a target path. Quoted wikilinks in its properties count too, tagged source=property with the property name. response_format=concise returns \{target, line, resolved\} per link, plus heading, target_path and candidates when present, without raw, kind, display and col.

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
| `include_embeds` | `boolean` |  | `true` | — |
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
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `counts` | `object` | yes | — |
| `counts.total` | `integer` | yes | range ≥ -9007199254740991 |
| `counts.resolved` | `integer` | yes | range ≥ -9007199254740991 |
| `counts.unresolved` | `integer` | yes | range ≥ -9007199254740991 |
| `links` | `object[]` | yes | — |
| `links[].raw` | `string` |  | — |
| `links[].kind` | `enum` |  | One of: `"wikilink"`, `"markdown"`, `"embed"` |
| `links[].target` | `string` | yes | — |
| `links[].display` | `string \| null` |  | — |
| `links[].heading` | `string \| null` |  | — |
| `links[].line` | `integer` | yes | range ≥ -9007199254740991 |
| `links[].col` | `integer` |  | range ≥ -9007199254740991 |
| `links[].source` | `enum` |  | One of: `"property"` |
| `links[].property` | `string` |  | — |
| `links[].resolved` | `boolean` | yes | — |
| `links[].target_path` | `string \| null` |  | — |
| `links[].candidates` | `string[] \| null` |  | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
