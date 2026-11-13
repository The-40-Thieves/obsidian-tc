---
title: "save_workspace"
description: "Save a workspace layout under a name (optionally making it active)."
editUrl: false
---

Save a workspace layout under a name (optionally making it active). Overwriting an existing workspace requires confirmation.

| | |
|---|---|
| **Domain** | workspace |
| **Scopes** | `write:workspaces` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:workspace` |
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
| `name` | `string` | yes | — | length ≥ 1 |
| `layout` | `Record<string, any>` | yes | — | — |
| `set_active` | `boolean` |  | `false` | — |
| `overwrite` | `boolean` |  | `false` | — |
| `prev_hash` | `string` |  | — | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `name` | `string` | yes | — |
| `created` | `boolean` | yes | — |
| `active` | `string \| null` | yes | — |
| `count` | `integer` | yes | range ≥ -9007199254740991 |
| `content_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `workspace` domain: [`add_bookmark`](/tools/reference/add_bookmark/), [`append_active_file`](/tools/reference/append_active_file/), [`append_to_periodic_note`](/tools/reference/append_to_periodic_note/), [`create_periodic_note`](/tools/reference/create_periodic_note/), [`delete_active_file`](/tools/reference/delete_active_file/), [`find_or_create_periodic_note`](/tools/reference/find_or_create_periodic_note/), [`get_active_file`](/tools/reference/get_active_file/), [`get_periodic_note`](/tools/reference/get_periodic_note/), [`list_bookmarks`](/tools/reference/list_bookmarks/), [`list_periodic_notes`](/tools/reference/list_periodic_notes/), [`list_workspaces`](/tools/reference/list_workspaces/), [`open_workspace`](/tools/reference/open_workspace/), [`patch_active_file`](/tools/reference/patch_active_file/), [`remove_bookmark`](/tools/reference/remove_bookmark/), [`resolve_daily_note`](/tools/reference/resolve_daily_note/), [`update_active_file`](/tools/reference/update_active_file/).

Back to the [tool catalog](/tools/tool-catalog/).
