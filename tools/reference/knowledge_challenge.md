---
title: "knowledge_challenge"
description: "Red-team a proposal against your documented decision history."
editUrl: false
---

Red-team a proposal against your documented decision history. Retrieves decision-bearing chunks (02-projects, 04-writing/Published, 09-reference/system-reviews, 09-reference/syntheses, or notes tagged decision, audit, self-audit, outcome, postmortem, reversal, lesson, review, analysis) and asks the inference gateway to flag DIRECT_CONTRADICTION / PATTERN_REPEAT / REVERSAL / HIDDEN_DEPENDENCY. That decision rule is fixed, not per-vault: a vault whose folders and tags match neither list gets no evidence, and coverage reports recalled and filtered_out counts so the cause is visible. Open contradictions are supplied only when the plane is enabled (plane.enabled). Cited paths are checked against the evidence shown; unseen ones are listed in coverage.unresolved_evidence_paths. Requires the gateway; reports unavailable when it is not configured.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `knowledge`, `external-network` |
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
| `proposal` | `string` | yes | — | length 10–4000 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `evidence_count` | `number` |  | — |
| `contradiction_count` | `number` |  | — |
| `output` | `object \| null` |  | — |
| `output.verdict` | `enum` | with parent | One of: `"proceed"`, `"reconsider"`, `"do_not_proceed"` |
| `output.summary` | `string` | with parent | length ≥ 1 |
| `output.categories` | `object[]` | with parent | — |
| `model` | `string` |  | — |
| `excluded_count` | `integer` |  | range ≥ 0 |
| `coverage` | `object` |  | — |
| `coverage.recalled` | `integer` | with parent | range ≥ 0 |
| `coverage.decision_matched` | `integer` | with parent | range ≥ 0 |
| `coverage.filtered_out` | `integer` | with parent | range ≥ 0 |
| `coverage.kept` | `integer` | with parent | range ≥ 0 |
| `coverage.dropped` | `object` | with parent | — |
| `coverage.truncated` | `integer` | with parent | range ≥ 0 |
| `coverage.low_coverage` | `boolean` | with parent | — |
| `coverage.unresolved_evidence_paths` | `string[]` |  | — |
| `coverage.ungrounded_items_dropped` | `integer` |  | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
