---
title: "get_entity"
description: "Read a memory entity by id, by type+name, or by unique name, with its observations and relations."
editUrl: false
---

Read a memory entity by id, by type+name, or by unique name, with its observations and relations. Retired entities are hidden unless include_retired is set. An entity is readable only when its own note (&lt;memory folder>/&lt;type>/&lt;name>.md) is readable under the caller's folder read ACL (readPaths); one that is not reads as 'entity not found', and relations to such entities are omitted. Observations returned are filtered by as_of — a fact is included when valid_from &lt;= as_of and (valid_to is unset or as_of &lt; valid_to). Default as_of is now, so an as_of in the PAST excludes any observation added after that instant, even one that is still open today. Each observation carries an `observation_id`: to correct or retire a fact (keyed or not), pass it to update_observation. response_format=concise returns each observation as \{observation_id, text, key?\} (plus valid_to and superseded_by when set) and omits vault_path when null, created_at, updated_at and as_of.

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
| `entity_id` | `string` |  | — | — |
| `type` | `string` |  | — | — |
| `name` | `string` |  | — | — |
| `include_retired` | `boolean` |  | `false` | — |
| `as_of` | `integer` |  | — | range ≥ 0 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `entity_id` | `string` | yes | — |
| `type` | `string` | yes | — |
| `name` | `string` | yes | — |
| `status` | `enum` | yes | One of: `"active"`, `"retired"` |
| `observations` | `object[]` | yes | — |
| `observations[].observation_id` | `string` | yes | — |
| `observations[].text` | `string` | yes | — |
| `observations[].key` | `string \| null` |  | — |
| `observations[].valid_from` | `number` |  | — |
| `observations[].valid_to` | `number \| null` |  | — |
| `observations[].superseded_by` | `string \| null` |  | — |
| `relations` | `object[]` | yes | — |
| `relations[].target_id` | `string` | yes | — |
| `relations[].target_name` | `string` | yes | — |
| `relations[].target_type` | `string` | yes | — |
| `relations[].relation_type` | `string` | yes | — |
| `relations[].direction` | `enum` | yes | One of: `"out"`, `"in"` |
| `vault_path` | `string \| null` |  | — |
| `created_at` | `number` |  | — |
| `updated_at` | `number` |  | — |
| `as_of` | `number` |  | — |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
