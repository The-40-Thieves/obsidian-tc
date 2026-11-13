---
title: "patch_note"
description: "Edit part of an existing note in place."
editUrl: false
---

Edit part of an existing note in place. Name an anchor: a heading section (anchor:\{type:"heading",heading:"Notes"\}), a block reference (anchor:\{type:"block",block_id\}), or the preamble above the first heading (anchor:\{type:"frontmatter"\}); then an operation: append/prepend/replace content, or replace_text (old_string/new_string). Required fields per operation (anchor or target_heading on append, prepend and replace only): append, prepend, replace: content; replace_text: old_string + new_string. Refused: old_string/new_string on append, prepend, replace; content on replace_text. Frontmatter is preserved. Examples: add a line to the end of a section = operation append + heading anchor + content. insert_before is append-only: it inserts content above a unique matching line within the resolved section, useful for keeping signatures, Parent links and footnote blocks at the end. Move, reorder or duplicate sections = ONE replace_text anchored on an enclosing heading (the note's top-level H1 spans every section below it): old_string is those sections as they are now, new_string the same text rearranged; the anchor heading line itself is never touched. To add at the very end of a note use append_note, which needs no anchor. A heading that appears more than once needs anchor.occurrence (1-based, document order) or a path (heading:"Parent > Child"); without either the call is refused with every matching line number, never silently bound to the first match (same for a block id on more than one line). On a heading anchor, replace preserves the anchor heading line itself; if content's first non-blank line repeats it (same level and text), that line is dropped so the two calling conventions do not double the heading. replace_text takes old_string/new_string instead of content and substitutes an exact match scoped to the resolved anchor's section; with neither anchor nor target_heading it is note-wide (the whole note body, frontmatter excluded, heading lines included), so a heading typo can be fixed in one call. 0 or 2+ matches is refused (with the count for 2+); confirm_replace is ignored for it. A replace on a heading anchor that would discard more than 20 lines AND over half of the note's body (e.g. the note's only H1, which no lower-or-equal heading bounds) is refused unless confirm_replace is set. Snapshots (restore_note's undo) are captured only when the server's snapshots.enabled config is on; the default "trusted-local" posture leaves it on, so such a write is rollback-able via restore_note unless snapshots have been explicitly disabled. response_format=concise acknowledges with \{vault, path, content_hash\} only (plus quality_warning, redactions, and lines_removed/bytes_removed when non-zero).

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `domain:notes` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | yes |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |
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
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
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

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
