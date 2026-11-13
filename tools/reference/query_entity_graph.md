---
title: "query_entity_graph"
description: "Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered)."
editUrl: false
---

Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered). Retired entities are excluded from the seed and the result set unless include_retired is set — traversal still walks THROUGH a retired node to reach its neighbors, only the returned/visible set is filtered. An entity whose own note is not readable under the caller's folder read ACL (readPaths) is NOT retired-like: it is never returned and never walked through, so nothing reachable only via it appears, and an unreadable seed reads as 'seed entity not found'. Each returned node's observations are filtered by as_of (default now — see get_entity's own description for the exact rule), so a graph walk answers 'what did we believe as_of D' the same way a direct get_entity does. response_format=concise drops each node's hop-by-hop path (distance stays), shapes observations as get_entity does, and omits as_of and total_returned. Domain: knowledge.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:memory` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge` |
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
| `seed_entity_id` | `string` | yes | — | length ≥ 1 |
| `depth` | `integer` |  | — | range 1–5 |
| `relation_types` | `string[]` |  | — | — |
| `entity_types` | `string[]` |  | — | — |
| `direction` | `enum` |  | `"both"` | One of: `"out"`, `"in"`, `"both"` |
| `include_retired` | `boolean` |  | `false` | — |
| `as_of` | `integer` |  | — | range ≥ 0 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `as_of` | `number` |  | — |
| `seed_entity_id` | `string` | yes | — |
| `items` | `object[]` | yes | — |
| `items[].entity_id` | `string` | yes | — |
| `items[].type` | `string` | yes | — |
| `items[].name` | `string` | yes | — |
| `items[].status` | `enum` | yes | One of: `"active"`, `"retired"` |
| `items[].distance` | `number` | yes | — |
| `items[].path` | `object[]` |  | — |
| `items[].observations` | `object[]` | yes | — |
| `next_cursor` | `string \| null` | yes | — |
| `total_returned` | `number` |  | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
