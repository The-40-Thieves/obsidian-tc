---
title: "append_to_periodic_note"
description: "Append content to a period's note (creating it if needed), optionally under a heading."
editUrl: false
---

Append content to a period's note (creating it if needed), optionally under a heading. idempotency_key is accepted (enforcement lands with the policy layer).

| | |
|---|---|
| **Domain** | workspace |
| **Scopes** | `write:periodic` |
| **Access** | write |
| **Tags** | `writes`, `domain:workspace` |
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
| `period` | `enum` | yes | — | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `date` | `string` |  | — | — |
| `content` | `string` | yes | — | — |
| `ensure_newline` | `boolean` |  | `true` | — |
| `heading` | `string` |  | — | length ≥ 1 |
| `idempotency_key` | `string` |  | — | length 1–128 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `period` | `enum` | yes | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `date` | `string` | yes | — |
| `path` | `string` | yes | — |
| `updated_at` | `string` | yes | — |
| `appended_bytes` | `integer` | yes | range ≥ -9007199254740991 |
| `created` | `boolean` | yes | — |
| `redactions` | `number` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
