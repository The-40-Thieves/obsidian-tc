---
title: "bundle_folder"
description: "Aggregate all notes under a folder into a single markdown/XML bundle (Smart Context)."
editUrl: false
---

Aggregate all notes under a folder into a single markdown/XML bundle (Smart Context). ACL-filtered; file-count and byte budgeted with an explicit truncated flag. When truncated, resume with the returned cursor; max_files and max_bytes apply per page, so loop until cursor is absent. response_format=concise drops the per-file list, total_bytes and the root echo.

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
| `root` | `string` | yes | — | length 1–1024 |
| `max_files` | `integer` |  | `100` | Per-page file cap; applies to a resumed page (via cursor) exactly as to the first. range 1–500 |
| `max_bytes` | `integer` |  | `500000` | Per-page byte budget; applies to a resumed page (via cursor) exactly as to the first. The 500,000 default truncates a medium folder — page with cursor, or set this to your largest folder's size; the server's maxResponseBytes cap still applies. If truncated is true with no cursor and empty files, no single file fits under max_bytes; raise max_bytes to at least that file's size. range ≥ 1 |
| `extensions` | `string[]` |  | `[".md"]` | — |
| `include_frontmatter` | `boolean` |  | `true` | — |
| `format` | `enum` |  | `"markdown"` | One of: `"markdown"`, `"xml"` |
| `cursor` | `string` |  | — | Resume after this vault-relative path (from a prior truncated response); emits only files that sort strictly after it in the tool's deterministic path order. |
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
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `root` | `string` |  | — |
| `cursor` | `string` |  | Vault-relative path of the last emitted file, present only when truncated is true. Pass back as input cursor to resume. |

## Related tools {#related-tools}

Other tools in the `automation` domain: [`bundle_files`](/tools/reference/bundle_files/), [`eval_dataview_field`](/tools/reference/eval_dataview_field/), [`execute_command`](/tools/reference/execute_command/), [`execute_template`](/tools/reference/execute_template/), [`generate_uri`](/tools/reference/generate_uri/), [`list_commands`](/tools/reference/list_commands/), [`list_quickadd_actions`](/tools/reference/list_quickadd_actions/), [`list_tasks`](/tools/reference/list_tasks/), [`list_templates`](/tools/reference/list_templates/), [`makemd_list_spaces`](/tools/reference/makemd_list_spaces/), [`makemd_query`](/tools/reference/makemd_query/), [`remotely_save_status`](/tools/reference/remotely_save_status/), [`remotely_save_trigger`](/tools/reference/remotely_save_trigger/), [`show_file_in_obsidian`](/tools/reference/show_file_in_obsidian/), [`tasks_filter`](/tools/reference/tasks_filter/), [`trigger_quickadd`](/tools/reference/trigger_quickadd/), [`update_task`](/tools/reference/update_task/), [`validate_dql`](/tools/reference/validate_dql/).

Back to the [tool catalog](/tools/tool-catalog/).
