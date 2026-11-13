---
title: "create_periodic_note"
description: "Create the periodic note for a period + date using the configured (or overridden) template."
editUrl: false
---

Create the periodic note for a period + date using the configured (or overridden) template. Fails if it already exists. Set expand_template=true to expand the template through Templater (requires write:templater; degrades to a verbatim copy when the companion/plugin is unavailable).

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
| `template_override` | `string` |  | — | length 1–1024 |
| `expand_template` | `boolean` |  | `false` | — |
| `idempotency_key` | `string` |  | — | length 1–128 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `period` | `enum` | yes | One of: `"daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"` |
| `date` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created_at` | `string` | yes | — |
| `template_used` | `string \| null` | yes | — |
| `template_expanded` | `boolean` | yes | — |
| `redactions` | `number` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`save_workspace`](/tools/reference/save_workspace/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
