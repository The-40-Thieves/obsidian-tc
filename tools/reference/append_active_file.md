---
title: "append_active_file"
description: "Append content to the note currently open in the live Obsidian session (append_note, aimed at the active note), preserving existing bytes."
editUrl: false
---

Append content to the note currently open in the live Obsidian session (append_note, aimed at the active note), preserving existing bytes. Same prev_hash compare-and-swap, snapshot, memoryDefense and provenance rules as append_note. Refuses a non-markdown active file.

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
| Accepts an idempotency key | yes |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `content` | `string` | yes | — | — |
| `ensure_newline` | `boolean` |  | `true` | — |
| `prev_hash` | `string` |  | — | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `provenance` | `enum` |  | `"authored"` | One of: `"authored"`, `"agent_synthesis"` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created` | `boolean` |  | — |
| `content_hash` | `string \| null` | yes | — |
| `prev_hash` | `string \| null` |  | — |
| `bytes_written` | `number` |  | — |
| `quality_warning` | `object \| null` |  | — |
| `quality_warning.flags` | `string[]` | with parent | — |
| `quality_warning.computed_at` | `number` | with parent | — |
| `poison_assessment` | `object \| null` |  | — |
| `poison_assessment.risk` | `enum` | with parent | One of: `"none"`, `"suspect"`, `"high"` |
| `poison_assessment.signals` | `string[]` | with parent | — |
| `redactions` | `integer` |  | range ≥ 0 |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
