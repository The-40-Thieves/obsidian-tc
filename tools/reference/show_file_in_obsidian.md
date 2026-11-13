---
title: "show_file_in_obsidian"
description: "Open a vault note in the running Obsidian app."
editUrl: false
---

Open a vault note in the running Obsidian app. Tries the companion plugin first (a live Obsidian session for the vault); falls back to the OS obsidian:// URI handler only when `uri.allowOsLaunch` is enabled and the call arrives over stdio. When neither is available it returns available:false with a reason and a hint instead of a silent success. Always requires human confirmation (execute:uri is a HITL floor): it causes a host-side effect. The path must pass the read ACL and name an existing note. generate_uri remains the pure URI builder.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | `execute:uri` |
| **Access** | write |
| **Tags** | `writes`, `hitl`, `domain:automation`, `plugin-bridge` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `available` | `boolean` | yes | — |
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `method` | `enum` |  | One of: `"bridge"`, `"os"` |
| `reason` | `enum` |  | One of: `"os_launch_disabled"`, `"os_launch_requires_stdio"`, `"os_launch_failed"` |
| `detail` | `string` |  | — |
| `message` | `string` |  | — |
| `hint` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
