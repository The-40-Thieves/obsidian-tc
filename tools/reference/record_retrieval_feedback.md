---
title: "record_retrieval_feedback"
description: "Report which retrieved chunks actually helped."
editUrl: false
---

Report which retrieved chunks actually helped. CALL THIS after you act on a search result: feedback (-1|0|+1) = was this the right chunk to return for that query. Stamp the chunks you genuinely used, not every hit, and stamp -1 when a confidently-returned chunk was wrong — a negative is worth more than silence. This is the only signal separating a chunk that gets RETRIEVED from one that gets USED: it feeds the ACT-R activation recompute, so stamping is what makes later retrieval better, and not stamping leaves ranking blind. Judge the RETRIEVAL, not your task: whether the task went well is a different question this tool deliberately no longer accepts. Several chunks at once: send verdicts: [\{chunk_id, feedback\}, ...] (1-50 items), applied in one transaction. Otherwise send chunk_id + feedback for one chunk. Send one form or the other, never both. Each target is your most recent retrieval event(s) for that chunk (last_n, default 1, applies to every item). Returns `updated`; when that is 0 it also returns `reason` — `session_scope` (you own retrievals for this chunk, none in the current scope) or `no_owned_retrievals` (nothing of yours matches), so a no-op is never silent. A batch returns `results`, one \{chunk_id, updated, reason?\} per verdict. You may only stamp retrievals your own caller produced; an unidentified caller cannot stamp, and admin:workspace crosses both that and the session scope.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `write:workspace` |
| **Access** | write |
| **Tags** | `writes`, `domain:knowledge`, `experiential` |
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
| `chunk_id` | `string` |  | — | Single form: the chunk to stamp. Send chunk_id + feedback together, or verdicts, never both. length ≥ 1 |
| `feedback` | `integer` |  | — | Single form: -1, 0 or +1 for chunk_id. Send it with chunk_id. range -1–1 |
| `verdicts` | `object[]` |  | — | Batch form (1-50 items): one \{chunk_id, feedback\} per chunk, all applied in one transaction. Send verdicts OR chunk_id + feedback, never both. items 1–50 |
| `verdicts[].chunk_id` | `string` | with parent | — | length ≥ 1 |
| `verdicts[].feedback` | `integer` | with parent | — | range -1–1 |
| `session_id` | `string` |  | — | Session scope for the stamp. Applies to every verdict in a batch. |
| `last_n` | `integer` |  | `1` | How many of each chunk's most recent retrievals to stamp (default 1). Applies to every verdict in a batch. range 1–50 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `chunk_id` | `string` |  | — |
| `updated` | `integer` |  | range ≥ -9007199254740991 |
| `reason` | `enum` |  | One of: `"session_scope"`, `"no_owned_retrievals"` |
| `results` | `object[]` |  | — |
| `results[].chunk_id` | `string` | with parent | — |
| `results[].updated` | `integer` | with parent | range ≥ -9007199254740991 |
| `results[].reason` | `enum` |  | One of: `"session_scope"`, `"no_owned_retrievals"` |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
