---
title: "list_periodic_notes"
description: "Enumerate existing periodic notes in a date range (probes the configured format/folder)."
editUrl: false
---

Enumerate existing periodic notes in a date range (probes the configured format/folder). Defaults to a recent window when from/to are omitted. response_format=concise returns \{date, path\} per item, without period and mtime; total, overflow and next_cursor are kept.

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
| `from` | `string` |  | — | — |
| `to` | `string` |  | — | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `period` | `enum` |  | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `items` | `object[]` | yes | — |
| `items[].period` | `enum` |  | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `items[].date` | `string` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].mtime` | `string` |  | — |
| `overflow` | `boolean` |  | — |
| `next_cursor` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
