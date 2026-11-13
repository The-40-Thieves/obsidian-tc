---
title: "bundle_files"
description: "Aggregate an explicit list of notes into a single markdown/XML bundle."
editUrl: false
---

Aggregate an explicit list of notes into a single markdown/XML bundle. ACL-filtered; byte budgeted; reports missing_paths for files that do not exist. response_format=concise drops the per-file list and total_bytes.

| | |
|---|---|
| **Domain** | automation |
| **Scopes** | `read:context` |
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
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `paths` | `string[]` | yes | — | items 1–200 |
| `max_bytes` | `integer` |  | `500000` | range ≥ 1 |
| `include_frontmatter` | `boolean` |  | `true` | — |
| `format` | `enum` |  | `"markdown"` | One of: `"markdown"`, `"xml"` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `bundle` | `string` | yes | — |
| `file_count` | `integer` | yes | range ≥ -9007199254740991 |
| `total_bytes` | `integer` |  | range ≥ -9007199254740991 |
| `truncated` | `boolean` | yes | — |
| `files` | `object[]` |  | — |
| `files[].path` | `string` | with parent | — |
| `files[].bytes` | `integer` | with parent | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `missing_paths` | `string[]` |  | — |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_folder`](/tools/reference/bundle_folder/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
