---
title: "patch_active_file"
description: "Patch a section of the note currently open in the live Obsidian session (patch_note, aimed at the active note): append, prepend, replace or replace_text under a heading, block reference or the fron..."
editUrl: false
---

Patch a section of the note currently open in the live Obsidian session (patch_note, aimed at the active note): append, prepend, replace or replace_text under a heading, block reference or the frontmatter preamble. Required fields per operation (anchor or target_heading on append, prepend and replace only): append, prepend, replace: content; replace_text: old_string + new_string. Refused: old_string/new_string on append, prepend, replace; content on replace_text. insert_before is append-only: it inserts content above a unique matching line within the resolved section, useful for keeping signatures, Parent links and footnote blocks at the end. With neither anchor nor target_heading, replace_text is note-wide (the whole note body, frontmatter excluded). Same anchors, prev_hash compare-and-swap, confirm_replace guard, snapshot and memoryDefense rules as patch_note; response_format=concise is patch_note's acknowledgement. Refuses a non-markdown active file.

| | |
|---|---|
| **Domain** | workspace |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `domain:workspace`, `plugin-bridge` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
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
| `operation` | `enum` | yes | — | Which edit to make. append, prepend and replace take content and need an anchor or target_heading; replace_text takes old_string and new_string and needs neither. Each field's description says which operations require or refuse it. One of: `"append"`, `"prepend"`, `"replace"`, `"replace_text"` |
| `target_heading` | `string` |  | — | Legacy shorthand for anchor:\{type:"heading",heading\}. append, prepend and replace need anchor or target_heading; replace_text needs neither (with neither it is note-wide). length ≥ 1 |
| `anchor` | `object` |  | — | Where to act: \{type:"heading",heading:"Notes"[,occurrence:2]\}, \{type:"block",block_id:"abc"\} or \{type:"frontmatter"\} (the preamble above the first heading). append, prepend and replace need anchor or target_heading; replace_text needs neither: with neither it matches over the whole note body (frontmatter excluded, heading lines included). |
| `anchor.type` | `enum` | with parent | — | One of: `"heading"`, `"block"`, `"frontmatter"` |
| `anchor.heading` | `string` |  | — | Heading text without the # marks, e.g. "Notes"; case-insensitive. To pick one of several same-named headings by its parents write "Parent > Child" (outermost first). length ≥ 1 |
| `anchor.occurrence` | `integer` |  | — | 1-based index among the headings that match, in document order. Needed when the heading appears more than once and no Parent > Child path singles it out; otherwise the call is refused with every match's line number. range ≥ 1 |
| `anchor.block_id` | `string` |  | — | length ≥ 1 |
| `content` | `string` |  | — | Required for append, prepend and replace; refused for replace_text. |
| `insert_before` | `string` |  | — | Optional for append only: insert content immediately above the unique line matching this value within the resolved section, ignoring trailing spaces and tabs. Fenced code and a heading anchor's own heading line are excluded. |
| `old_string` | `string` |  | — | Required for replace_text, refused for append, prepend and replace: the exact text to find inside the anchor's section, or inside the whole note body when there is no anchor; it must occur exactly once. To move or reorder sections, anchor on an enclosing heading and put the whole span here. length ≥ 1 |
| `new_string` | `string` |  | — | Required for replace_text, refused for append, prepend and replace: the text that takes old_string's place (may be empty to delete). |
| `prev_hash` | `string` |  | — | — |
| `confirm_replace` | `boolean` |  | `false` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `operation` | `enum` |  | One of: `"append"`, `"prepend"`, `"replace"`, `"replace_text"` |
| `anchor` | `object` |  | — |
| `anchor.type` | `enum` | with parent | One of: `"heading"`, `"block"`, `"frontmatter"` |
| `anchor.heading` | `string` |  | — |
| `anchor.occurrence` | `number` |  | — |
| `anchor.block_id` | `string` |  | — |
| `target_heading` | `string` |  | — |
| `content_hash` | `string \| null` | yes | — |
| `prev_hash` | `string` |  | — |
| `lines_removed` | `number` |  | — |
| `bytes_removed` | `number` |  | — |
| `quality_warning` | `object \| null` |  | — |
| `quality_warning.flags` | `string[]` | with parent | — |
| `quality_warning.computed_at` | `number` | with parent | — |
| `redactions` | `integer` |  | range ≥ 0 |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
