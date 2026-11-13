---
title: "gap_report"
description: "Read-only view of the latest gap-detector pass: which of the pass's queries scored below the calibrated coverage floor, with their nearest-hit context."
editUrl: false
---

Read-only view of the latest gap-detector pass: which of the pass's queries scored below the calibrated coverage floor, with their nearest-hit context. Populated by the offline `reliquary-tc gaps` pass; computed_at tells you how fresh it is, and null means no pass has ever been persisted for this vault. Never recomputes — a fresh reading requires re-running the CLI pass. Nearest-hit paths are filtered to the caller's read ACL before being returned. response_format=concise returns \{id, query, top_score, gap\} per item, without results and nearest, and omits threshold, min_results and returned; computed_at, total, gaps and gap_rate are kept.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `experiential`, `knowledge`, `external-network` |
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
| `gaps_only` | `boolean` |  | `false` | — |
| `limit` | `integer` |  | `50` | range 1–500 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `vault` | `string` |  | — |
| `computed_at` | `number \| null` |  | — |
| `threshold` | `number` |  | — |
| `min_results` | `integer` |  | range ≥ -9007199254740991 |
| `total` | `integer` |  | range ≥ -9007199254740991 |
| `gaps` | `integer` |  | range ≥ -9007199254740991 |
| `gap_rate` | `number` |  | — |
| `returned` | `integer` |  | range ≥ -9007199254740991 |
| `items` | `object[]` |  | — |
| `items[].id` | `string` | with parent | — |
| `items[].query` | `string` | with parent | — |
| `items[].top_score` | `number \| null` | with parent | — |
| `items[].results` | `integer` |  | range ≥ -9007199254740991 |
| `items[].gap` | `boolean` | with parent | — |
| `items[].nearest` | `object[]` |  | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
