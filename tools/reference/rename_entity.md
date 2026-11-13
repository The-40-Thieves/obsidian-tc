---
title: "rename_entity"
description: "Rename a memory entity and/or change its lifecycle status (active/retired)."
editUrl: false
---

Rename a memory entity and/or change its lifecycle status (active/retired). At least one of new_name/status is required. This is the reachable path for retiring an entity — get_entity and query_entity_graph filter status:retired out by default. Renaming moves the materialized note (preserving any frontmatter Obsidian or a person added directly to the file) and re-materializes every OTHER materialized entity that has a relation TO this one, so their `[[links]]` keep resolving under the new name. Does not rewrite free-text mentions of the old name elsewhere in the vault — only entities with a direct graph edge to this one are touched.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:memory`, `write:memory` |
| **Access** | write |
| **Tags** | `writes`, `domain:knowledge` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
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
| `entity_id` | `string` | yes | — | length ≥ 1 |
| `new_name` | `string` |  | — | length ≥ 1 |
| `status` | `enum` |  | — | One of: `"active"`, `"retired"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `entity_id` | `string` | yes | — |
| `type` | `string` | yes | — |
| `name` | `string` | yes | — |
| `status` | `enum` | yes | One of: `"active"`, `"retired"` |
| `vault_path` | `string \| null` | yes | — |
| `updated_at` | `number` | yes | — |
| `neighbors_rematerialized` | `number` | yes | — |
| `redactions` | `integer` |  | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
