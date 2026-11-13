---
title: "rewrite_link"
description: "Repoint every link to `from_target` at `to_target` across the vault."
editUrl: false
---

Repoint every link to `from_target` at `to_target` across the vault. Defaults to dry_run; a real run requires confirmation. response_format=concise drops the from_target/to_target echo (to_target stays when the memoryDefense scan redacted it) and, on a real run, the per-note changes list; notes_changed and links_rewritten stay.

| | |
|---|---|
| **Domain** | links |
| **Scopes** | `read:notes`, `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:links` |
| **Profile** | core, full |

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

- The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `from_target` | `string` | yes | — | length ≥ 1 |
| `to_target` | `string` | yes | — | length ≥ 1 |
| `folder` | `string` |  | — | length 1–1024 |
| `include_embeds` | `boolean` |  | `true` | — |
| `dry_run` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `dry_run` | `boolean` | yes | — |
| `from_target` | `string` |  | — |
| `to_target` | `string` |  | — |
| `notes_changed` | `integer` | yes | range ≥ -9007199254740991 |
| `links_rewritten` | `integer` | yes | range ≥ -9007199254740991 |
| `changes` | `object[]` |  | — |
| `changes[].path` | `string` | with parent | — |
| `changes[].count` | `integer` | with parent | range ≥ -9007199254740991 |
| `warnings` | `object[]` |  | — |
| `warnings[].path` | `string` | with parent | — |
| `warnings[].property` | `string` |  | — |
| `warnings[].message` | `string` | with parent | — |
| `warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `links` domain: [`find_link_cycles`](/tools/reference/find_link_cycles/), [`find_orphans`](/tools/reference/find_orphans/), [`find_unresolved_links`](/tools/reference/find_unresolved_links/), [`get_backlinks`](/tools/reference/get_backlinks/), [`get_link_strength`](/tools/reference/get_link_strength/), [`get_outgoing_links`](/tools/reference/get_outgoing_links/), [`graph_centrality`](/tools/reference/graph_centrality/), [`graph_communities`](/tools/reference/graph_communities/), [`graph_path_between`](/tools/reference/graph_path_between/), [`prune_hub_links`](/tools/reference/prune_hub_links/), [`suggest_links`](/tools/reference/suggest_links/), [`vault_health_score`](/tools/reference/vault_health_score/).

Back to the [tool catalog](/tools/tool-catalog/).
