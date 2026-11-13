---
title: "lint_wiki"
description: "Wiki health check in ONE call: lint a folder (or the whole vault) and get a list of PROPOSED fixes, each with a suggested action and the tool that applies it."
editUrl: false
---

Wiki health check in ONE call: lint a folder (or the whole vault) and get a list of PROPOSED fixes, each with a suggested action and the tool that applies it. Combines find_orphans, find_unresolved_links (property links included), list_contradictions (open rows only), note_quality_report (stale / duplicated notes), audit_provenance (notes missing `sources`), gap_report (topics with no good page) and a NEW near-duplicate pass over note-level embeddings that finds pages restating the same topic (so you merge or link instead of keeping two), optionally with an LLM judge (judge=true) that reads each near-duplicate pair and adds a verdict (same_topic / overlapping / different) to the proposal. Also reports the SCHEMA.md conventions a note breaks (`conventions`) and the layers with file warnings (`conventions_file`), and link loops of 3 to 10 notes (`cycles`, as find_link_cycles lists them). Use it for periodic wiki upkeep, after a batch of writes, or when asked to clean up, audit or dedupe a wiki. Read-only: it never writes and never blocks anything; apply the proposals with the named tool yourself. A check that cannot run (no rollup, no embeddings) is listed under `skipped` rather than failing the call. Respects the read ACL and Obsidian's Excluded files (an excluded note is never the subject of a proposal, but still counts as a link source and target). The wiki folder's generated index.md and log.md are never the subject of a proposal and their links count for nothing; a hand-edited or foreign one is reported as a `generated_page` proposal. Pick checks with `checks`; response_format=concise returns \{kind, subject, related, suggested_action, tool\} per proposal without detail, tool_args and evidence.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `knowledge`, `diagnostics`, `external-network` |
| **Profile** | full only |

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
| `folder` | `string` |  | — | Lint only this folder. Links and duplicates are still resolved against the whole vault. length 1–1024 |
| `checks` | `enum[]` |  | — | Which checks to run. Default: all. items ≥ 1 |
| `limit_per_check` | `integer` |  | `20` | range 1–500 |
| `min_similarity` | `number` |  | — | Lowest note-level cosine reported as a near-duplicate (default 0.909, calibrated for BAAI/bge-m3; candidates to review, not verdicts). range 0–1 |
| `max_notes` | `integer` |  | `1500` | Cap on notes compared pairwise by the near-duplicate pass (cost grows with its square). range 1–5000 |
| `judge` | `boolean` |  | — | Have an LLM judge read each near-duplicate pair and put its verdict (same_topic, overlapping, different) and rationale on the proposal. It never drops a proposal. Sends the opening text of both notes to the judge model (the gateway's, or TypeSafe Jev), only for notes you may read outside egress.excludePaths and Obsidian's Excluded files. Default: on when a judge is configured (wikiJudge.lintEnabled); false skips it, true reports why when no judge is available. |
| `max_judge_calls` | `integer` |  | `10` | Cap on judge calls in this run, highest-similarity pairs first (cached verdicts are free). Pairs beyond it keep their proposal unjudged. The wikiJudge.maxCallsPerDay cap applies on top. range 1–50 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `warnings` | `object[]` |  | — |
| `warnings[].path` | `string` | with parent | — |
| `warnings[].reason` | `enum` | with parent | One of: `"frontmatter_yaml"` |
| `warnings[].message` | `string` | with parent | — |
| `warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `folder` | `string` |  | — |
| `read_only` | `boolean` | yes | — |
| `checks_run` | `enum[]` | yes | — |
| `skipped` | `object[]` | yes | — |
| `skipped[].check` | `enum` | yes | One of: `"generated_pages"`, `"orphans"`, `"cycles"`, `"unresolved_links"`, `"contradictions"`, `"quality"`, `"missing_sources"`, `"coverage_gaps"`, `"near_duplicates"`, `"conventions"`, `"conventions_file"` |
| `skipped[].reason` | `string` | yes | — |
| `summary` | `object` | yes | — |
| `summary.total` | `integer` | yes | range ≥ -9007199254740991 |
| `summary.by_kind` | `Record<string, integer>` | yes | — |
| `proposals` | `object[]` | yes | — |
| `proposals[].kind` | `enum` | yes | One of: `"generated_page"`, `"orphan"`, `"link_cycle"`, `"unresolved_link"`, `"contradiction"`, `"stale"`, `"duplicate_chunks"`, `"missing_sources"`, `"coverage_gap"`, `"near_duplicate"`, `"conventions"`, `"conventions_file"` |
| `proposals[].subject` | `string` | yes | — |
| `proposals[].related` | `string[]` |  | — |
| `proposals[].detail` | `string` |  | — |
| `proposals[].suggested_action` | `string` | yes | — |
| `proposals[].tool` | `string` | yes | — |
| `proposals[].tool_args` | `Record<string, any>` |  | — |
| `proposals[].evidence` | `Record<string, any>` |  | — |
| `proposals[].judge_verdict` | `enum` |  | One of: `"same_topic"`, `"overlapping"`, `"different"` |
| `truncated` | `string[]` | yes | — |
| `notes` | `string[]` | yes | — |
| `judge` | `object` |  | — |
| `judge.ran` | `boolean` | with parent | — |

_6 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
