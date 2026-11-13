---
title: "vault_context"
description: "Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open..."
editUrl: false
---

Composite budgeted context in ONE call (the Honcho-style context() primitive): graph-reranked chunks packed to a token budget and grouped by note, recent synthesis patterns touching the query, open contradictions on the packed notes, and applicable past lessons (decision/lesson/postmortem chunks relevant to the query) — with source metadata and packing stats. include_work adds eligible work-memory episodes (the work-memory reader contract; explicit opt-in, never default). Omit query for session bootstrap: the queued thread is read from the memory folder's _next-session.md signal note, so every session opens with its applicable lessons (push, not pull). response_format=concise drops the route, budget and stats blocks, each chunk's source and hop and each lesson's via.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `knowledge`, `search`, `external-network` |
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
| `query` | `string` |  | — | length ≥ 1 |
| `token_budget` | `integer` |  | `4000` | range 1–64000 |
| `k` | `integer` |  | `30` | range 1–60 |
| `include_work` | `boolean` |  | `false` | — |
| `include_lessons` | `boolean` |  | `true` | — |
| `since` | `string` |  | — | ISO-8601. A LOWER-BOUND HINT for differential mode: the server floors it against this caller's own stored watermark (if any), so a client clock running ahead can never cause a row to be silently skipped — it can only ever see a row again, not lose one. Filters notes/syntheses/contradictions (and episodes, with include_work) to rows newer than the effective cutoff. Omit for the full snapshot (unchanged default behavior). pattern `^(?:(?:\\d\\d[2468][048]\|\\d\\d[13579][26]\|\\d\\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\\d\|30)\|(?:02)-(?:0[1-9]\|1\\d\|2[0-8])))T(?:(?:[01]\\d\|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$`; format date-time |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `route` | `string[]` |  | — |
| `query_source` | `enum` |  | One of: `"input"`, `"next_session"` |
| `signal` | `string` |  | — |
| `signal_hash` | `string` |  | — |
| `budget` | `object` |  | — |
| `budget.requested` | `number` | with parent | — |
| `budget.chunk_budget` | `number` | with parent | — |
| `budget.packed_tokens` | `number` | with parent | — |
| `stats` | `object` |  | — |
| `stats.chunks_considered` | `number` | with parent | — |
| `stats.chunks_packed` | `number` | with parent | — |
| `stats.notes` | `number` | with parent | — |
| `stats.contradictions` | `number` | with parent | — |
| `stats.syntheses` | `number` | with parent | — |
| `stats.lessons` | `number` | with parent | — |
| `notes` | `object[]` | yes | — |
| `notes[].path` | `string` | yes | — |
| `notes[].chunks` | `object[]` | yes | — |
| `syntheses` | `object[]` | yes | — |
| `syntheses[].iso_year` | `number` | yes | — |
| `syntheses[].iso_week` | `number` | yes | — |
| `syntheses[].generated_at` | `number` | yes | — |
| `syntheses[].patterns` | `any` | yes | — |
| `contradictions` | `object[]` | yes | — |
| `contradictions[].id` | `string` | yes | — |
| `contradictions[].source_path` | `string` | yes | — |
| `contradictions[].conflict_path` | `string` | yes | — |
| `contradictions[].judge_verdict` | `string` | yes | — |
| `contradictions[].judge_rationale` | `string` | yes | — |

_15 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
