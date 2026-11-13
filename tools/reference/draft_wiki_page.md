---
title: "draft_wiki_page"
description: "Plan a new wiki page WITHOUT writing anything: the step between find_existing_page and commit_wiki_page."
editUrl: false
---

Plan a new wiki page WITHOUT writing anything: the step between find_existing_page and commit_wiki_page. Give a topic (and optionally a page `type` from the wiki folder's SCHEMA.md and `sources`, the notes or URLs the page draws on). Returns (1) the dedupe verdict from find_existing_page: if a page already exists you get it back with a suggestion to link to it or extend it instead of creating a duplicate, and no changeset; (2) the wiki folder's SCHEMA.md (page types, the frontmatter each requires, the allowed property vocabulary; a malformed file is a warning, never an error); (3) a link map: existing notes the new page should link TO (your sources, related pages) and notes that should link FROM it (notes that mention the topic without linking it, related wiki pages), and notes that already link it; (4) a CHANGESET SKELETON: the new page's path and frontmatter with the required fields empty, and a `link` patch (with the note's current prev_hash) for each note that should link to the new page. With `source` (a note in the vault's raw folder) the draft ingests it: that note is cited in the skeleton's `sources` and reported (size, the wiki pages that already cite it), raw notes are never offered as duplicates or patch targets, and a source under 1500 characters with no page in the wiki that covers, relates to or cites it comes back with no changeset (`ingest.refused`), because a page for it would only restate it; a source you may not read answers like a missing one. You write the page body (and any `text` for a patch); the server never writes prose. Pass the filled changeset to commit_wiki_page. Read-only: it never writes, respects the read ACL and Obsidian's Excluded files (an excluded note is never offered for patching), and with `judge` (default from the wikiJudge config) the dedupe check may send the topic and the opening text of up to 3 readable notes to the gateway judge model, exactly as find_existing_page does.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:knowledge`, `knowledge`, `search`, `external-network` |
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
| `topic` | `string` | yes | — | The page topic or title you are about to write (a `[[wikilink]]` or a QID also works). length 1–500 |
| `type` | `string` |  | — | Page type, one of the types in the wiki folder's SCHEMA.md. Sets the required frontmatter, the subfolder and the `type` property of the skeleton. length 1–100 |
| `sources` | `string[]` |  | — | What the page draws on: note paths or `[[wikilinks]]` (they become link_to entries) or URLs. Copied into the skeleton's `sources` property. items ≤ 50 |
| `source` | `string` |  | — | Ingest: the path of ONE markdown note in this vault's raw folder (vaults[].wiki.rawFolder, default `raw` beside the wiki folder) that the page is distilled from. It is cited in the skeleton's `sources`, reported with its size and the pages that already cite it, and a source under 1500 characters is refused a page of its own when nothing in the wiki covers, relates to or cites it. Raw notes are inputs: never dedupe candidates or patch targets. Read it with read_note and write the prose yourself. length 1–1024 |
| `limit` | `integer` |  | `8` | Most entries in each link-map list, and most candidates shown. range 1–25 |
| `min_similarity` | `number` |  | — | Lowest best-chunk cosine reported as a related note (default 0.708, calibrated for BAAI/bge-m3). range 0–1 |
| `judge` | `boolean` |  | — | Let the wikiJudge LLM resolve an ambiguous dedupe verdict, as in find_existing_page. Default: the wikiJudge.enabled config. |
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
| `topic` | `string` | yes | — |
| `wiki` | `object` | yes | — |
| `wiki.folder` | `string \| null` | yes | — |
| `wiki.schema` | `object` | yes | — |
| `dedupe` | `object` | yes | — |
| `dedupe.verdict` | `enum` | yes | One of: `"exists"`, `"ambiguous"`, `"new"` |
| `dedupe.total` | `integer` | yes | range ≥ -9007199254740991 |
| `dedupe.candidates` | `object[]` | yes | — |
| `dedupe.next` | `object` | yes | — |
| `dedupe.semantic` | `object` | yes | — |
| `dedupe.judge` | `object` |  | — |
| `dedupe.judged_by` | `object` |  | — |
| `ingest` | `object` |  | — |
| `ingest.raw_folder` | `string` | with parent | — |
| `ingest.source` | `object` | with parent | — |
| `ingest.cited_by` | `string[]` | with parent | — |
| `ingest.refused` | `object \| null` | with parent | — |
| `suggestion` | `string` | yes | — |
| `existing` | `object \| null` | yes | — |
| `existing.path` | `string` | yes | — |
| `existing.content_hash` | `string` | yes | — |
| `requirements` | `object` | yes | — |
| `requirements.type` | `string \| null` | yes | — |

_12 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
