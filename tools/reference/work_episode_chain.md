---
title: "work_episode_chain"
description: "Walk an episode's amendment chain in one call."
editUrl: false
---

Walk an episode's amendment chain in one call. `prev_id` links each episode to the caller's previous one, and following it hop by hop cost one round trip per link. Returns the chain newest-first starting at `id`. The work-memory reader contract applies at every hop, not just the first: tombstoned rows never surface, expired rows are excluded, and the walk stays inside the calling principal unless any_caller (admin:workspace, P1.7). The walk STOPS at the first hop that fails those filters rather than skipping over it — a gap in a returned chain would itself disclose that a hidden episode exists. response_format=concise returns each episode as work_episodes does; truncated is always kept.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:workspace` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `experiential` |
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
| `id` | `string` | yes | — | length ≥ 1 |
| `k` | `integer` |  | `50` | range 1–200 |
| `any_caller` | `boolean` |  | `false` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `chain` | `object[]` |  | — |
| `chain[].id` | `string` | with parent | — |
| `chain[].ts` | `number` | with parent | — |
| `chain[].vault` | `string \| null` |  | — |
| `chain[].session_id` | `string \| null` |  | — |
| `chain[].caller` | `string \| null` |  | — |
| `chain[].channel` | `string` |  | — |
| `chain[].episode_type` | `string` |  | — |
| `chain[].task_result` | `number \| null` |  | — |
| `chain[].verdict_at` | `number \| null` |  | — |
| `chain[].tool` | `string \| null` |  | — |
| `chain[].status` | `string` | with parent | — |
| `chain[].error_code` | `string \| null` |  | — |
| `chain[].duration_ms` | `number \| null` |  | — |
| `chain[].result_size` | `number \| null` |  | — |
| `chain[].summary` | `string \| null` |  | — |
| `chain[].tags` | `string[]` |  | — |
| `chain[].trust` | `number \| null` |  | — |
| `chain[].eligibility` | `string` | with parent | — |
| `chain[].blocked` | `boolean` |  | — |
| `chain[].prev_id` | `string \| null` |  | — |
| `truncated` | `boolean` |  | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
