---
title: "read_note"
description: "Read a note's raw content, parsed frontmatter, body, content hash, and stat."
editUrl: false
---

Read a note's raw content, parsed frontmatter, body, content hash, and stat. With anchor (same shape as patch_note's: a heading section, a block reference, or the frontmatter preamble), also returns section: the resolved span's text (including its heading/block-id marker line), 1-based start_line/end_line relative to the raw file, and heading_level for a heading anchor. content_hash stays the whole-note hash so it round-trips into patch_note's prev_hash unchanged. A note whose frontmatter is not valid YAML is still returned (frontmatter null) with raw_frontmatter, frontmatter_error \{message, line, column\} and a warning naming the repair (update_frontmatter replace with frontmatter_yaml). response_format=concise returns \{vault, path, body, content_hash\}: the note body without its frontmatter block (and, with an anchor, the section instead of the whole body).

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:notes` |
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
| `path` | `string` | yes | — | length 1–1024 |
| `anchor` | `object` |  | — | — |
| `anchor.type` | `enum` | with parent | — | One of: `"heading"`, `"block"`, `"frontmatter"` |
| `anchor.heading` | `string` |  | — | Heading text without the # marks, e.g. "Notes"; case-insensitive. To pick one of several same-named headings by its parents write "Parent > Child" (outermost first). length ≥ 1 |
| `anchor.occurrence` | `integer` |  | — | 1-based index among the headings that match, in document order. Needed when the heading appears more than once and no Parent > Child path singles it out; otherwise the call is refused with every match's line number. range ≥ 1 |
| `anchor.block_id` | `string` |  | — | length ≥ 1 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `raw_frontmatter` | `string` |  | — |
| `frontmatter_error` | `object` |  | — |
| `frontmatter_error.message` | `string` | with parent | — |
| `frontmatter_error.line` | `integer` |  | range ≥ -9007199254740991 |
| `frontmatter_error.column` | `integer` |  | range ≥ -9007199254740991 |
| `warning` | `string` |  | — |
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `content` | `string` |  | — |
| `frontmatter` | `object \| null` |  | — |
| `body` | `string` |  | — |
| `has_frontmatter` | `boolean` |  | — |
| `content_hash` | `string` | yes | — |
| `stat` | `object \| null` |  | — |
| `stat.size` | `number` | with parent | — |
| `stat.mtime` | `string` | with parent | — |
| `stat.ctime` | `string` | with parent | — |
| `section` | `object` |  | — |
| `section.text` | `string` | with parent | — |
| `section.start_line` | `number` | with parent | — |
| `section.end_line` | `number` | with parent | — |
| `section.heading_level` | `number` |  | — |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
