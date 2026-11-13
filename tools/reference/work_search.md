---
title: "work_search"
description: "Search the experiential work-memory (agent_episodes) — what the agent actually did."
editUrl: false
---

Search the experiential work-memory (agent_episodes) — what the agent actually did. MEMORY semantics with the work-memory reader contract enforced: only evaluator-approved (eligible) episodes by default, tombstoned/expired rows never surface, results are partitioned to the calling principal, and a trust floor (default 0.3) excludes high-risk content. include_pending opts into not-yet-evaluated episodes (still trust-floored); any_caller crosses the agent partition and requires the admin:workspace scope (P1.7: the partition is an authorization boundary, not a free filter). `semantic` (opt-in) fuses a cosine-similarity channel over `summary` alongside the lexical match via Reciprocal Rank Fusion, so a paraphrased query can find an episode the lexical LIKE match misses — lexical stays the exact-match failsafe for names/dates/ids, and the SAME reader-contract filters above apply to both channels identically (the fused pool is never wider than what lexical alone could already see). Degrades silently to lexical-only when no `query`, no embedding provider is configured, or the provider errors. response_format=concise returns each episode without vault, caller, channel, episode_type, duration_ms, result_size and null or empty fields; trust, eligibility and a true blocked flag are kept.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:workspace` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `experiential`, `search`, `external-network` |
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
| `query` | `string` |  | — | length ≥ 1 |
| `tool` | `string` |  | — | — |
| `session_id` | `string` |  | — | — |
| `since` | `integer` |  | — | range ≥ 1 |
| `until` | `integer` |  | — | range ≥ 1 |
| `k` | `integer` |  | `20` | range 1–200 |
| `min_trust` | `number` |  | `0.3` | range 0–1 |
| `include_pending` | `boolean` |  | `false` | — |
| `any_caller` | `boolean` |  | `false` | — |
| `semantic` | `boolean` |  | `false` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `floor` | `object` |  | — |
| `floor.min_trust` | `number` | with parent | — |
| `floor.include_pending` | `boolean` | with parent | — |
| `floor.semantic_used` | `boolean` | with parent | — |
| `results` | `object[]` |  | — |
| `results[].id` | `string` | with parent | — |
| `results[].ts` | `number` | with parent | — |
| `results[].vault` | `string \| null` |  | — |
| `results[].session_id` | `string \| null` |  | — |
| `results[].caller` | `string \| null` |  | — |
| `results[].channel` | `string` |  | — |
| `results[].episode_type` | `string` |  | — |
| `results[].task_result` | `number \| null` |  | — |
| `results[].verdict_at` | `number \| null` |  | — |
| `results[].tool` | `string \| null` |  | — |
| `results[].status` | `string` | with parent | — |
| `results[].error_code` | `string \| null` |  | — |
| `results[].duration_ms` | `number \| null` |  | — |
| `results[].result_size` | `number \| null` |  | — |
| `results[].summary` | `string \| null` |  | — |
| `results[].tags` | `string[]` |  | — |
| `results[].trust` | `number \| null` |  | — |
| `results[].eligibility` | `string` | with parent | — |
| `results[].blocked` | `boolean` |  | — |
| `results[].prev_id` | `string \| null` |  | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/).

Back to the [tool catalog](/tools/tool-catalog/).
