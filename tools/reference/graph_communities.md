---
title: "graph_communities"
description: "Community detection over the persisted link graph (Louvain)."
editUrl: false
---

Community detection over the persisted link graph (Louvain). Partitions notes into clusters that link to each other more than to the rest of the vault. Deterministic: the same vault and seed always yield the same partition. ALWAYS read `meaningful` — a modularity below 0.3 means the partition is not distinguishable from chance, and presenting those clusters as 'your vault's topics' would be inventing structure. ANALYTICS ONLY, never used for retrieval ranking.

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
| `seed` | `integer` |  | `42` | range ≥ -9007199254740991 |
| `min_size` | `integer` |  | `1` | range 1–100 |
| `limit` | `integer` |  | `20` | range 1–100 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `nodes` | `number` | yes | — |
| `modularity` | `number` | yes | — |
| `meaningful` | `boolean` | yes | — |
| `note` | `string` |  | — |
| `community_count` | `number` | yes | — |
| `communities` | `object[]` | yes | — |
| `communities[].id` | `number` | yes | — |
| `communities[].paths` | `string[]` | yes | — |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`rewrite_link`](/tools/reference/rewrite_link/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
