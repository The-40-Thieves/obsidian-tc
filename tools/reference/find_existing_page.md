---
title: "find_existing_page"
description: "Check whether a page on a topic ALREADY EXISTS before creating one (dedupe / page-exists check): run this before write_note when you are about to add a new wiki page, concept note or entity page, s..."
editUrl: false
---

Check whether a page on a topic ALREADY EXISTS before creating one (dedupe / page-exists check): run this before write_note when you are about to add a new wiki page, concept note or entity page, so you link to the existing page instead of writing a duplicate. Give a topic string (and optionally a folder to look in); get a verdict exists | ambiguous | new plus the candidate notes with the evidence for each: exact path or file name, an `aliases` frontmatter entry, a `wikidata:` property holding the same QID (pass 'Q42' or a wikidata URL), a title or H1, the text other notes (including property links) already link it under, and semantically near notes. Read-only and advisory: it never writes and never blocks. Respects the read ACL, and Obsidian's Excluded files: an excluded note still counts when its name or alias matches (it is a link target) but is never a similarity match. Ambiguous candidates that rest on similarity or link text alone can be resolved by an LLM judge (`judge`, default from config): exactly one same-topic ruling makes the verdict exists, all candidates ruled different makes it new, anything else (or any failure) stays ambiguous; a name, alias or wikidata match is never overridden or sent to it. response_format=concise returns \{path, strength, evidence kinds\} per candidate, without evidence details or scores.

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
| `topic` | `string` | yes | — | The page topic or title you are about to write, a `[[wikilink]]`, or a wikidata QID (Q42). length 1–500 |
| `folder` | `string` |  | — | Only report candidates inside this folder. Omit to check the whole vault, which is what avoids a duplicate elsewhere. length 1–1024 |
| `limit` | `integer` |  | `8` | range 1–25 |
| `min_similarity` | `number` |  | — | Lowest best-chunk cosine reported as a similar note (default 0.708, calibrated for BAAI/bge-m3; recall at that floor is low, lower it to see weaker candidates). range 0–1 |
| `judge` | `boolean` |  | — | Let an LLM judge resolve AMBIGUOUS candidates that rest on soft evidence (similarity, link text): same topic -> exists, all different -> new, anything else stays ambiguous. Never overrides a name, alias or wikidata match and never blocks. Sends the topic and the opening text of at most 3 top candidates to the judge model (the gateway's, or TypeSafe Jev), only for notes you may read outside egress.excludePaths and Obsidian's Excluded files. Default: the wikiJudge.enabled config (off); true needs a configured judge. |
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
| `verdict` | `enum` | yes | One of: `"exists"`, `"ambiguous"`, `"new"` |
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `candidates` | `object[]` | yes | — |
| `candidates[].path` | `string` | yes | — |
| `candidates[].strength` | `enum` | yes | One of: `"strong"`, `"soft"` |
| `candidates[].evidence` | `object \| string[]` | yes | — |
| `candidates[].excluded` | `boolean` |  | — |
| `next` | `object` | yes | — |
| `next.action` | `enum` | yes | One of: `"link_to_existing"`, `"review_candidates"`, `"create_new"` |
| `next.tool` | `string` | yes | — |
| `next.paths` | `string[]` | yes | — |
| `next.note` | `string` | yes | — |
| `semantic` | `object` | yes | — |
| `semantic.checked` | `boolean` | yes | — |
| `semantic.min` | `number` | yes | — |
| `semantic.reason` | `string` |  | — |
| `judge` | `object` |  | — |
| `judge.ran` | `boolean` | with parent | — |
| `judge.reason` | `string` |  | — |
| `judge.model` | `string` |  | — |
| `judge.calls` | `integer` | with parent | range ≥ -9007199254740991 |
| `judge.cached` | `integer` | with parent | range ≥ -9007199254740991 |

_7 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`commit_wiki_page`](/tools/reference/commit_wiki_page/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
