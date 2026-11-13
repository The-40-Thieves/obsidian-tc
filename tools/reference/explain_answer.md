---
title: "explain_answer"
description: "Explain what an answer actually used: walks retrieval -> chunk -> citation -> episode for one session or time window and reports each link with how well it is known."
editUrl: false
---

Explain what an answer actually used: walks retrieval -> chunk -> citation -> episode for one session or time window and reports each link with how well it is known. Distinguishes a retrieval the citation pass never judged from one it judged and rejected, and a chunk whose note no longer exists from one that was never used. Read-only; reports nothing about paths the caller cannot read. response_format=concise drops the summary counts and each link's retrieval echo (time, surface, query text, rank); the caveat and the citation-pass record stay.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `knowledge`, `provenance`, `diagnostics` |
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
| `session_id` | `string` |  | — | length ≥ 1 |
| `since` | `integer` |  | — | range ≥ 0 |
| `until` | `integer` |  | — | range ≥ 0 |
| `limit` | `integer` |  | `50` | range 1–200 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `vault` | `string` |  | — |
| `scope` | `enum` |  | One of: `"session"`, `"time_window"` |
| `links` | `object[]` |  | — |
| `links[].chunk_id` | `string` | with parent | — |
| `links[].path` | `string \| null` | with parent | — |
| `links[].chunk` | `enum` | with parent | One of: `"resolved"`, `"deleted"` |
| `links[].retrieved_at` | `number` |  | — |
| `links[].surface_type` | `string` |  | — |
| `links[].query_text` | `string \| null` |  | — |
| `links[].rank_in_results` | `number \| null` |  | — |
| `links[].citation` | `enum` | with parent | One of: `"confirmed"`, `"rejected"`, `"candidate"`, `"uncertain"`, `"not_stamped"` |
| `links[].citation_score` | `number \| null` | with parent | — |
| `links[].correlation` | `enum` | with parent | One of: `"session"`, `"time_window"`, `"none"` |
| `links[].episode_id` | `string \| null` |  | — |
| `summary` | `object` |  | — |
| `summary.retrievals` | `number` | with parent | — |
| `summary.deleted_chunks` | `number` | with parent | — |
| `summary.not_stamped` | `number` | with parent | — |
| `summary.not_cited` | `number` | with parent | — |
| `summary.cited` | `number` | with parent | — |
| `summary.exact_correlations` | `number` | with parent | — |
| `caveat` | `string \| null` |  | — |
| `citation_pass` | `object` |  | — |
| `citation_pass.recorded_runs` | `number` | with parent | — |
| `citation_pass.last_ran_at` | `number \| null` | with parent | — |
| `citation_pass.last_aborted` | `boolean` | with parent | — |
| `citation_pass.last_unfinished` | `boolean` | with parent | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
