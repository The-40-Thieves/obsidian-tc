---
title: "add_observation"
description: "Append a fact to a memory entity (re-materializing its note when materialized)."
editUrl: false
---

Append a fact to a memory entity (re-materializing its note when materialized). `observation` must be a single non-blank fact with no embedded newline — a caller with more than one fact calls this more than once. An optional `key` opts the observation INTO supersession tracking — when the same entity already has an OPEN observation with that key, it is closed (not deleted: its text stays under the note's Superseded section, its interval's valid_to is set and superseded_by records what replaced it) and the new text opens a fresh interval. An observation added with no key never supersedes anything and is never superseded automatically; it just appends. Matching is always by this explicit key, never inferred from text similarity. To CORRECT or REMOVE an existing fact (including one with no key), do not add a contradicting observation: call update_observation with its `observation_id` (returned by create_entity, add_observation and get_entity). `valid_from`/`valid_to` (ISO 8601) let a caller backdate a fact or bound it explicitly. To retire a keyed fact WITHOUT replacing it, omit `observation` and pass `key` + `valid_to` — closes the open interval for that key with no new text appended. Domain: knowledge.

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
| Accepts an idempotency key | yes |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `entity_id` | `string` | yes | — | length ≥ 1 |
| `observation` | `string` |  | — | length ≥ 1 |
| `key` | `string` |  | — | length 1–64; pattern `^[a-z0-9][a-z0-9_.-]*$` |
| `valid_from` | `string` |  | — | pattern `^(?:(?:\\d\\d[2468][048]\|\\d\\d[13579][26]\|\\d\\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\\d\|30)\|(?:02)-(?:0[1-9]\|1\\d\|2[0-8])))T(?:(?:[01]\\d\|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z\|([+-](?:[01]\\d\|2[0-3]):[0-5]\\d)))$`; format date-time |
| `valid_to` | `string` |  | — | pattern `^(?:(?:\\d\\d[2468][048]\|\\d\\d[13579][26]\|\\d\\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\\d\|30)\|(?:02)-(?:0[1-9]\|1\\d\|2[0-8])))T(?:(?:[01]\\d\|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z\|([+-](?:[01]\\d\|2[0-3]):[0-5]\\d)))$`; format date-time |
| `idempotency_key` | `string` |  | — | length 1–128 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `entity_id` | `string` | yes | — |
| `observation_id` | `string` |  | — |
| `observation_count` | `number` | yes | — |
| `updated_at` | `number` | yes | — |
| `vault_path` | `string \| null` | yes | — |
| `redactions` | `integer` |  | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
