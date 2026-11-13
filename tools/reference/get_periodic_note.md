---
title: "get_periodic_note"
description: "Get the periodic note for a period + date (no creation)."
editUrl: false
---

Get the periodic note for a period + date (no creation). Resolves the path from the vault's daily/periodic config or Obsidian defaults. response_format=concise omits the `period` echo and the parsed `frontmatter` (the content carries it). Domain: workspace.

| | |
|---|---|
| **Domain** | workspace |
| **Scopes** | `read:periodic` |
| **Access** | read |
| **Tags** | `read-only`, `domain:workspace` |
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
| `period` | `enum` | yes | — | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `date` | `string` |  | — | — |
| `include_content` | `boolean` |  | `true` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `period` | `enum` |  | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `date` | `string` | yes | — |
| `path` | `string` | yes | — |
| `exists` | `boolean` | yes | — |
| `content` | `string` |  | — |
| `frontmatter` | `object \| null` |  | — |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
