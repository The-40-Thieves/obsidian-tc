---
title: "find_orphans"
description: "Find notes that nothing else links to (optionally also requiring no outgoing links); a link in a property counts."
editUrl: false
---

Find notes that nothing else links to (optionally also requiring no outgoing links); a link in a property counts. A note whose frontmatter is not valid YAML does not fail the scan: its body is still read and it is named in `warnings`. group_by=folder adds `groups`: the orphan count and oldest/newest mtime per top-level folder, over the whole result.

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
| `folder` | `string` |  | — | length 1–1024 |
| `limit` | `integer` |  | `100` | range 1–5000 |
| `cursor` | `string` |  | — | — |
| `require_no_outgoing` | `boolean` |  | `false` | — |
| `group_by` | `enum` |  | — | One of: `"folder"` |

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
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `truncated` | `boolean` | yes | — |
| `next_cursor` | `string \| null` | yes | — |
| `orphans` | `string[]` | yes | — |
| `groups` | `object[]` |  | — |
| `groups[].folder` | `string` | with parent | — |
| `groups[].count` | `integer` | with parent | range ≥ -9007199254740991 |
| `groups[].oldest` | `string \| null` | with parent | — |
| `groups[].newest` | `string \| null` | with parent | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
