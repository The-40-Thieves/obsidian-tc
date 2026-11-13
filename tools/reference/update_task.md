---
title: "update_task"
description: "Modify a task in place by line number (status, dates, priority, tags)."
editUrl: false
---

Modify a task in place by line number (status, dates, priority, tags). Reopening a task completed more than 7 days ago requires confirmation.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | `write:tasks` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:automation` |
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
| `path` | `string` | yes | — | length 1–1024 |
| `line` | `integer` | yes | — | range ≥ 1 |
| `set` | `object` |  | — | — |
| `set.status` | `enum` |  | — | One of: `"todo"`, `"done"`, `"cancelled"`, `"in_progress"`, `"scheduled"` |
| `set.description` | `string` |  | — | — |
| `set.due` | `string` |  | — | — |
| `set.scheduled` | `string` |  | — | — |
| `set.start` | `string` |  | — | — |
| `set.done` | `string` |  | — | — |
| `set.priority` | `enum` |  | — | One of: `"highest"`, `"high"`, `"medium"`, `"low"`, `"lowest"` |
| `set.recur` | `string` |  | — | — |
| `set.add_tags` | `string[]` |  | — | — |
| `set.remove_tags` | `string[]` |  | — | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `path` | `string` | yes | — |
| `line` | `integer` | yes | range ≥ -9007199254740991 |
| `updated_at` | `string` | yes | — |
| `prev_state` | `object` | yes | — |
| `prev_state.path` | `string` | yes | — |
| `prev_state.line` | `integer` | yes | range ≥ -9007199254740991 |
| `prev_state.status` | `enum` | yes | One of: `"todo"`, `"done"`, `"cancelled"`, `"in_progress"`, `"scheduled"` |
| `prev_state.description` | `string` | yes | — |
| `prev_state.tags` | `string[]` | yes | — |
| `prev_state.due` | `string` |  | — |
| `prev_state.scheduled` | `string` |  | — |
| `prev_state.start` | `string` |  | — |
| `prev_state.done` | `string` |  | — |
| `prev_state.priority` | `enum` |  | One of: `"highest"`, `"high"`, `"medium"`, `"low"`, `"lowest"` |
| `prev_state.recur` | `string` |  | — |
| `new_state` | `object` | yes | — |
| `new_state.path` | `string` | yes | — |
| `new_state.line` | `integer` | yes | range ≥ -9007199254740991 |
| `new_state.status` | `enum` | yes | One of: `"todo"`, `"done"`, `"cancelled"`, `"in_progress"`, `"scheduled"` |
| `new_state.description` | `string` | yes | — |
| `new_state.tags` | `string[]` | yes | — |
| `new_state.due` | `string` |  | — |
| `new_state.scheduled` | `string` |  | — |
| `new_state.start` | `string` |  | — |
| `new_state.done` | `string` |  | — |
| `new_state.priority` | `enum` |  | One of: `"highest"`, `"high"`, `"medium"`, `"low"`, `"lowest"` |
| `new_state.recur` | `string` |  | — |
| `content_hash` | `string` | yes | — |
| `redactions` | `number` |  | — |
| `conventions` | `object` |  | — |

_4 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
