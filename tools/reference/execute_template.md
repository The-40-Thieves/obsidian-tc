---
title: "execute_template"
description: "Run a Templater template and write the expanded output to a target path."
editUrl: false
---

Run a Templater template and write the expanded output to a target path. Returns the vault-relative path Templater actually created. Always requires human confirmation (write:templater is a HITL floor) because templates can execute arbitrary user JavaScript. Domain: automation.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | `write:templater`, `read:notes` |
| **Access** | write |
| **Tags** | `writes`, `hitl`, `plugin-bridge`, `domain:automation` |
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
| `template` | `string` | yes | — | length 1–1024 |
| `target` | `string` | yes | — | length 1–1024 |
| `args` | `Record<string, any>` |  | — | — |
| `overwrite` | `boolean` |  | `false` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `template` | `string` | yes | — |
| `target` | `string` | yes | — |
| `created_at` | `string` | yes | — |
| `content_hash` | `string` |  | — |
| `provenance_stamp` | `object` |  | — |
| `provenance_stamp.applied` | `boolean` | with parent | — |
| `provenance_stamp.reason` | `enum` | with parent | One of: `"concurrent_modification"` |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
