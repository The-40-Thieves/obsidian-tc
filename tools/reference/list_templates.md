---
title: "list_templates"
description: "List available Templater templates with parsed metadata (user functions, parameters), via the companion bridge."
editUrl: false
---

List available Templater templates with parsed metadata (user functions, parameters), via the companion bridge. Domain: automation.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | `read:templater` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:automation` |
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

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `items` | `object[]` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].name` | `string` | yes | — |
| `total` | `integer` | yes | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
