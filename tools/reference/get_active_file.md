---
title: "get_active_file"
description: "Read the note currently open in the live Obsidian session (same result as read_note, including the optional anchor section)."
editUrl: false
---

Read the note currently open in the live Obsidian session (same result as read_note, including the optional anchor section). Resolves the active file through the companion plugin, then reads it under the normal read scope and folder ACL. response_format=concise is read_note's (the body, or just the section, without frontmatter). When the active file is not markdown (a canvas, PDF or image) it returns its path, extension and stat only. Errors, never guesses: note_not_found with reason no_active_file when nothing is open; plugin_unreachable / requires_live_obsidian when there is no live session.

| | |
|---|---|
| **Domain** | workspace |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:workspace`, `plugin-bridge` |
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
| `content_hash` | `string` |  | — |
| `stat` | `object \| null` |  | — |
| `stat.size` | `number` | with parent | — |
| `stat.mtime` | `string` | with parent | — |
| `stat.ctime` | `string` | with parent | — |
| `section` | `object` |  | — |
| `section.text` | `string` | with parent | — |
| `section.start_line` | `number` | with parent | — |
| `section.end_line` | `number` | with parent | — |
| `section.heading_level` | `number` |  | — |
| `extension` | `string` | yes | — |
| `is_markdown` | `boolean` | yes | — |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
