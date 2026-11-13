---
title: "prune_hub_links"
description: "Prune unresolved and/or duplicate links from a hub note."
editUrl: false
---

Prune unresolved and/or duplicate links from a hub note. Defaults to dry_run; a real run requires confirmation. response_format=concise drops removed[] and prev_hash on a real run; removed_count and content_hash stay, and a dry run keeps both.

| | |
|---|---|
| **Domain** | links |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:links` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

The handler asks for confirmation only when a call crosses a boundary (for example an overwrite, a folder-boundary crossing or a bulk-cost floor); other calls need none.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |
| `remove_unresolved` | `boolean` |  | `true` | — |
| `remove_duplicates` | `boolean` |  | `true` | — |
| `dry_run` | `boolean` |  | `true` | — |
| `prev_hash` | `string` |  | — | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `dry_run` | `boolean` | yes | — |
| `removed_count` | `integer` | yes | range ≥ -9007199254740991 |
| `removed` | `object[]` |  | — |
| `removed[].target` | `string` | with parent | — |
| `removed[].line` | `integer` | with parent | range ≥ -9007199254740991 |
| `removed[].reason` | `enum` | with parent | One of: `"unresolved"`, `"duplicate"` |
| `prev_hash` | `string` |  | — |
| `content_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
