---
title: "generate_uri"
description: "Build an obsidian:// URI for a target (open/search/new/daily/command/hookmark/advanced)."
editUrl: false
---

Build an obsidian:// URI for a target (open/search/new/daily/command/hookmark/advanced). Pure string builder — touches no vault state, requires no scope. `vault_name` is the Obsidian DISPLAY NAME (not a vault id) and is used verbatim.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | none |
| **Access** | read |
| **Tags** | `read-only`, `domain:automation` |
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
| `vault_name` | `string` |  | — | length ≥ 1 |
| `action` | `enum` | yes | — | One of: `"open"`, `"search"`, `"new"`, `"daily"`, `"command"`, `"hookmark"`, `"advanced"` |
| `params` | `Record<string, any>` |  | `{}` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `uri` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
