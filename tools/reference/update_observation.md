---
title: "update_observation"
description: "Correct or retire ONE existing memory observation, addressed by its `observation_id` (returned by create_entity, add_observation and get_entity; no key needed)."
editUrl: false
---

Correct or retire ONE existing memory observation, addressed by its `observation_id` (returned by create_entity, add_observation and get_entity; no key needed). Pass `observation` (the corrected single-line fact) to replace it, or `retire: true` to remove it without a replacement — exactly one of the two. Nothing is hard-deleted: the old text is closed (valid_to set; for a correction, superseded_by names the replacement), hidden from default reads, still visible with get_entity's `as_of` set before the edit and under the note's Superseded section. A correction keeps the old observation's key, so a later add_observation with that key still supersedes it. Use this instead of add_observation whenever a fact is WRONG or no longer true; only an open observation can be edited. Requires write access to the entity's note path. Domain: knowledge.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `write:memory` |
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
| `observation_id` | `string` | yes | — | pattern `^obs_[1-9][0-9]*$` |
| `observation` | `string` |  | — | length ≥ 1 |
| `retire` | `boolean` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `entity_id` | `string` | yes | — |
| `action` | `enum` | yes | One of: `"corrected"`, `"retired"` |
| `closed_observation_id` | `string` | yes | — |
| `observation_id` | `string` |  | — |
| `observation_count` | `number` | yes | — |
| `updated_at` | `number` | yes | — |
| `vault_path` | `string \| null` | yes | — |
| `redactions` | `integer` |  | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
