---
title: "commit_wiki_page"
description: "Apply a wiki changeset in one step: a new page (path, frontmatter, the body you wrote) plus patches to existing pages that link them to it, from draft_wiki_page."
editUrl: false
---

Apply a wiki changeset in one step: a new page (path, frontmatter, the body you wrote) plus patches to existing pages that link them to it, from draft_wiki_page. The page must be inside the vault's configured wiki folder (`vaults[].wiki.folder`; a vault without one refuses). All or nothing on errors: every touched note is checked first (write and read ACL on each path, `prev_hash` compare-and-swap on each existing note, the poison and memory-defense scans), temp files for every note are staged, then the notes are replaced back to back, each re-hashed just before it is replaced, with a rollback if any write fails, so a failing patch leaves the vault as it was. NOT crash-atomic: a process crash in the middle of the renames can leave a partial batch; a `pending` write-provenance record naming every path and the hash it was about to hold is written before the first rename, so the batch is visible and every replaced note has a snapshot (restore_note). Creating a page in the wiki folder needs NO confirmation (a new page has no prior state, so it has no snapshot: delete_note removes it); patching a related note needs none either, as patch_note, and restore_note undoes patches and overwrites; overwriting an existing non-empty page (`page.mode: overwrite`) asks for confirmation exactly like write_note. Re-checks at commit time that no other page already covers the topic (an identity match refuses the commit with the existing page named; `allow_duplicate: true` overrides). Problems that are for you to fix do NOT block the write and come back in `problems`: frontmatter that breaks the wiki folder's SCHEMA.md (missing required field, unknown type or property, value outside the vocabulary), links in the page that resolve to no note, related notes from the link map the page does not link, patches that add no link, a page nothing links to. Open contradictions already flagged on a touched note come back in `contradictions`. Patches only ADD (`link`: a bullet under a heading, once; `append`: text at the end or under a heading); rewrite prose with patch_note. Every write is recorded in the write provenance chain and indexed. Snapshot retention and reindexing after the write are best-effort: a fault there is logged and comes back as a `post_commit` problem, never as an error. After the write the server queues regeneration of the wiki folder's generated `index.md` (pages grouped by type) and `log.md` (a projection of the write provenance chain), so even a very large wiki never delays this call. Generation lists only paths readable without a rule-scope and never an Excluded note; failures and hand-edited generated pages are logged and never fail or delay the committed write. Needs read:notes as well as write:notes: the duplicate re-check reads every note you may read.

| | |
|---|---|
| **Domain** | knowledge |
| **Scopes** | `write:notes`, `read:notes` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:knowledge`, `knowledge`, `external-network` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

The handler asks for confirmation only when a call crosses a boundary (for example an overwrite, a folder-boundary crossing or a bulk-cost floor); other calls need none.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `topic` | `string` |  | — | What the page covers, for the duplicate check and link validation. Default: the page's file name. length 1–500 |
| `type` | `string` |  | — | Page type to check the frontmatter against. Default: the frontmatter's `type`. length 1–100 |
| `sources` | `string[]` |  | — | Notes or URLs the page draws on; notes among them are expected to be linked. items ≤ 50 |
| `page` | `object` | yes | — | — |
| `page.path` | `string` | yes | — | Where the page goes (vault-relative, ends in .md). length ≥ 1 |
| `page.frontmatter` | `Record<string, any>` |  | — | The page's properties, as an object (not YAML text). Checked against SCHEMA.md. |
| `page.body` | `string` | yes | — | The page's markdown, WITHOUT a frontmatter block. You write it. length 1–200000 |
| `page.mode` | `enum` |  | `"create"` | `create` (default) refuses a path that exists. `overwrite` replaces an existing page, needs `prev_hash`, and asks for confirmation like write_note does. One of: `"create"`, `"overwrite"` |
| `page.prev_hash` | `string` |  | — | `overwrite` only: the page's current content_hash. length ≥ 1 |
| `patches` | `object[]` |  | `[]` | items ≤ 25 |
| `patches[].path` | `string` | with parent | — | Existing note to patch (vault-relative). length ≥ 1 |
| `patches[].prev_hash` | `string` | with parent | — | content_hash of the note when you read it (the draft gives it): compare-and-swap. length ≥ 1 |
| `patches[].operation` | `enum` | with parent | — | `link` adds a bullet linking the new page under `heading` (default 'See also', created at the end when the note has none) and does nothing when the note already links it. `append` adds `content` at the end of the note, or at the end of the section under `heading`. One of: `"link"`, `"append"` |
| `patches[].heading` | `string` |  | — | length 1–200 |
| `patches[].content` | `string` |  | — | `append` only: the text to add. You write it. length ≤ 20000 |
| `patches[].text` | `string` |  | — | `link` only: a few words after the link saying why it is related. You write it. length ≤ 500 |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `allow_duplicate` | `boolean` |  | `false` | Create the page even though another page already covers the topic. |
| `judge` | `boolean` |  | — | Let the wikiJudge LLM resolve an ambiguous duplicate check. Default: the wikiJudge.enabled config. |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `committed` | `boolean` | yes | — |
| `page` | `object` | yes | — |
| `page.path` | `string` | yes | — |
| `page.created` | `boolean` | yes | — |
| `page.content_hash` | `string` | yes | — |
| `page.prev_hash` | `string \| null` | yes | — |
| `patches` | `object[]` | yes | — |
| `patches[].path` | `string` | yes | — |
| `patches[].operation` | `enum` | yes | One of: `"link"`, `"append"` |
| `patches[].applied` | `boolean` | yes | — |
| `patches[].reason` | `string` |  | — |
| `patches[].content_hash` | `string` | yes | — |
| `patches[].prev_hash` | `string` | yes | — |
| `problems` | `object[]` | yes | — |
| `problems[].kind` | `enum` | yes | One of: `"schema"`, `"schema_file"`, `"unresolved_link"`, `"missing_link"`, `"no_inbound_link"`, `"patch_without_link"`, `"patch_skipped"`, `"possible_duplicate"`, `"excluded_note"`, `"poison_suspect"`, `"redacted"`, `"generated_page"`, `"post_commit"` |
| `problems[].path` | `string` |  | — |
| `problems[].field` | `string` |  | — |
| `problems[].message` | `string` | yes | — |
| `contradictions` | `object[]` | yes | — |
| `contradictions[].id` | `string` | yes | — |
| `contradictions[].source_path` | `string` | yes | — |
| `contradictions[].conflict_path` | `string` | yes | — |
| `contradictions[].judge_verdict` | `string` | yes | — |
| `contradictions[].judge_rationale` | `string` | yes | — |
| `dedupe` | `object` | yes | — |
| `dedupe.verdict` | `enum` | yes | One of: `"exists"`, `"ambiguous"`, `"new"` |
| `dedupe.checked_topic` | `string` | yes | — |
| `redactions` | `integer` |  | range ≥ -9007199254740991 |

_6 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `knowledge` domain: [`add_observation`](/tools/reference/add_observation/), [`audit_provenance`](/tools/reference/audit_provenance/), [`close_goal`](/tools/reference/close_goal/), [`commit_capture`](/tools/reference/commit_capture/), [`create_entity`](/tools/reference/create_entity/), [`delete_entity`](/tools/reference/delete_entity/), [`diagnose_retrieval`](/tools/reference/diagnose_retrieval/), [`draft_wiki_page`](/tools/reference/draft_wiki_page/), [`end_session`](/tools/reference/end_session/), [`enqueue_capture`](/tools/reference/enqueue_capture/), [`episode_stats`](/tools/reference/episode_stats/), [`explain_answer`](/tools/reference/explain_answer/), [`find_existing_page`](/tools/reference/find_existing_page/), [`gap_report`](/tools/reference/gap_report/), [`get_entity`](/tools/reference/get_entity/), [`get_session_traces`](/tools/reference/get_session_traces/), [`knowledge_challenge`](/tools/reference/knowledge_challenge/), [`link_entities`](/tools/reference/link_entities/), [`lint_wiki`](/tools/reference/lint_wiki/), [`list_capture_queue`](/tools/reference/list_capture_queue/), [`list_contradictions`](/tools/reference/list_contradictions/), [`list_goals`](/tools/reference/list_goals/), [`note_quality_report`](/tools/reference/note_quality_report/), [`plur_get`](/tools/reference/plur_get/), [`plur_recall`](/tools/reference/plur_recall/), [`plur_recall_hybrid`](/tools/reference/plur_recall_hybrid/), [`plur_similarity_search`](/tools/reference/plur_similarity_search/), [`query_entity_graph`](/tools/reference/query_entity_graph/), [`record_retrieval_feedback`](/tools/reference/record_retrieval_feedback/), [`reflect`](/tools/reference/reflect/), [`rename_entity`](/tools/reference/rename_entity/), [`session_bootstrap`](/tools/reference/session_bootstrap/), [`set_goal`](/tools/reference/set_goal/), [`start_session`](/tools/reference/start_session/), [`unlink_entities`](/tools/reference/unlink_entities/), [`update_observation`](/tools/reference/update_observation/), [`vault_context`](/tools/reference/vault_context/), [`vault_graph_search`](/tools/reference/vault_graph_search/), [`work_episode_chain`](/tools/reference/work_episode_chain/), [`work_episodes`](/tools/reference/work_episodes/), [`work_forget`](/tools/reference/work_forget/), [`work_result`](/tools/reference/work_result/), [`work_search`](/tools/reference/work_search/).

Back to the [tool catalog](/tools/tool-catalog/).
