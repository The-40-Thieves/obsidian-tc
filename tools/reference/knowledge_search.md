---
title: "knowledge_search"
description: "Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion."
editUrl: false
---

Semantic + keyword search over a vendor / external-docs corpus (a reserved read-only docs vault), with wikilink graph expansion and RRF fusion. The docs-scoped analogue of vault_graph_search: bind `vault` to the docs corpus id. Returns source-attributed chunks tagged seed|expansion. Gated on read:docs so it stays isolated from the private vault. response_format=concise returns \{chunk_id, path, content, rerank_score\} per result without source, hop, via_edge and root_seed, and drops route and coverage.

| | |
|---|---|
| **Domain** | docs |
| **Scopes** | `read:docs` |
| **Access** | read |
| **Tags** | `read-only`, `domain:docs`, `docs`, `search`, `knowledge`, `external-network` |
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
| `final_top_k` | `integer` |  | `10` | range 1–100 |
| `as_of` | `integer` |  | — | range ≥ 0 |
| `since` | `integer` |  | — | range ≥ 0 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode_used` | `enum` | yes | One of: `"lexical-route"`, `"graph"` |
| `route` | `string[]` |  | — |
| `coverage` | `object` |  | — |
| `coverage.arms` | `enum[]` | with parent | — |
| `coverage.armsContributed` | `number` | with parent | — |
| `coverage.armsPossible` | `number` | with parent | — |
| `coverage.expansionSkipped` | `boolean` | with parent | — |
| `coverage.expansionTruncated` | `boolean` | with parent | — |
| `coverage.requested` | `number` | with parent | — |
| `coverage.returned` | `number` | with parent | — |
| `coverage.underfilled` | `boolean` | with parent | — |
| `coverage.staleReturned` | `number` | with parent | — |
| `coverage.staleUnknown` | `number` | with parent | — |
| `coverage.staleThresholdDays` | `number` | with parent | — |
| `coverage.confidence` | `object` | with parent | — |
| `results` | `object[]` | yes | — |
| `results[].chunk_id` | `string` | yes | — |
| `results[].path` | `string` | yes | — |
| `results[].content` | `string` |  | — |
| `results[].source` | `enum` |  | One of: `"seed"`, `"expansion"`, `"lexical"`, `"sparse"`, `"temporal"`, `"summary"`, `"cluster_summary"` |
| `results[].hop` | `number` |  | — |
| `results[].via_edge` | `object \| null` |  | — |
| `results[].root_seed` | `string \| null` |  | — |
| `results[].rerank_score` | `number` | yes | — |
| `results[].vault` | `string` |  | — |
| `results[].changed_since_d` | `boolean` |  | — |

## Related tools {#related-tools}

Other tools in the `docs` domain: [`knowledge_get_critical`](/tools/reference/knowledge_get_critical/).

Back to the [tool catalog](/tools/tool-catalog/).
