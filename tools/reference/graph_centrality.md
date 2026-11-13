---
title: "graph_centrality"
description: "Structural importance of notes in the persisted link graph."
editUrl: false
---

Structural importance of notes in the persisted link graph. metric 'pagerank' answers 'what do many notes point at' (power iteration, damping 0.85); metric 'betweenness' answers the different question 'what sits between otherwise disconnected areas' — a bridge note can score high on betweenness with only two links. ANALYTICS ONLY: these scores are never used for retrieval ranking. Notes outside your read scope are excluded from the graph entirely, not just from the output.

| | |
|---|---|
| **Domain** | links |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:links`, `links`, `graph` |
| **Profile** | full only |

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
| `metric` | `enum` |  | `"pagerank"` | One of: `"pagerank"`, `"betweenness"` |
| `min_incoming_links` | `integer` |  | `0` | range 0–100 |
| `limit` | `integer` |  | `25` | range 1–200 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `metric` | `enum` | yes | One of: `"pagerank"`, `"betweenness"` |
| `nodes` | `number` | yes | — |
| `available` | `boolean` |  | — |
| `message` | `string` |  | — |
| `edges` | `number` |  | — |
| `results` | `object[]` |  | — |
| `results[].path` | `string` | with parent | — |
| `results[].score` | `number` | with parent | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
