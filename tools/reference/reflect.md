---
title: "reflect"
description: "The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance."
editUrl: false
---

The reflect verb (retain/recall/reflect): recall over the vault, then a gateway synthesis pass — one on-demand, query-scoped operation returning a grounded answer with source provenance. mode 'challenge' runs the adversarial red-team over the decision-bearing recall instead (the knowledge_challenge core) and returns a coverage object (recalled, decision_matched, filtered_out, kept, dropped, unresolved_evidence_paths). persist: true writes the answer as a derived note under the memory folder's reflections/ with source_model + chunk provenance (requires write:notes); it applies to mode 'synthesis' only and is rejected with mode 'challenge'. Degrades gracefully: without the inference gateway, recall still returns sources with available: false. The sleep-time half (episode-eligibility evaluator + preference profile) runs via the `reliquary-tc reflect` CLI command.

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
| `query` | `string` | yes | — | length 3–4000 |
| `mode` | `enum` |  | `"synthesis"` | One of: `"synthesis"`, `"challenge"` |
| `k` | `integer` |  | `20` | range 1–60 |
| `scope` | `string` |  | — | length ≥ 1 |
| `persist` | `boolean` |  | `false` | — |
| `citation_style` | `enum` |  | — | How citations read in the answer and any persisted note. "numeric" (default) keeps the [n] markers; "wikilink" renders each [n] as `[[path]]` from the evidence it numbers, deterministically. An [n] with no matching evidence is left as written and listed in `unresolved_citations`. Omitted: the vault's `reflect.citationStyle`, else numeric. One of: `"numeric"`, `"wikilink"` |
| `detail` | `enum` |  | — | How much the synthesis says. "concise" (default), "standard", or "thorough"; a prompt instruction only, the evidence set is unchanged. Omitted: the vault's `reflect.detail`, else concise. One of: `"concise"`, `"standard"`, `"thorough"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `mode` | `string` | yes | — |
| `route` | `string[]` | yes | — |
| `available` | `boolean` | yes | — |
| `message` | `string` |  | — |
| `answer` | `string \| null` |  | — |
| `model` | `string` |  | — |
| `challenge` | `object` |  | — |
| `challenge.verdict` | `enum` | with parent | One of: `"proceed"`, `"reconsider"`, `"do_not_proceed"` |
| `challenge.summary` | `string` | with parent | length ≥ 1 |
| `challenge.categories` | `object[]` | with parent | — |
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
| `sources` | `object[]` | yes | — |
| `sources[].chunk_id` | `string` | yes | — |
| `sources[].path` | `string` | yes | — |
| `sources[].score` | `number` | yes | — |
| `persisted` | `object` |  | — |
| `persisted.path` | `string` | with parent | — |
| `excluded_count` | `integer` |  | range ≥ 0 |
| `unresolved_citations` | `integer[]` |  | citation_style "wikilink": [n] markers that match no evidence item, left as written in the answer. Omitted when every marker resolved, and always in numeric mode. |

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
