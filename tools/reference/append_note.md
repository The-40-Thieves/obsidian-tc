---
title: "append_note"
description: "Append content to the END of a note (optionally creating it with create_if_missing: true), preserving existing bytes."
editUrl: false
---

Append content to the END of a note (optionally creating it with create_if_missing: true), preserving existing bytes. It takes no anchor: to add under a specific heading, or anywhere other than the end, use patch_note instead. Set provenance: "agent_synthesis" when the appended content is a derived/inferred conclusion an agent produced rather than authored/copied text — this routes the appended content through a poison scan before the write lands (rejected outright on high risk) and surfaces the assessment in the result; also add source: agent-synthesis to the note's own frontmatter by convention. response_format=concise acknowledges with \{vault, path, content_hash\} only (plus quality_warning, poison_assessment or redactions when they carry something).

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `domain:notes` |
| **Profile** | core, full |

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
| `path` | `string` | yes | — | length 1–1024 |
| `content` | `string` | yes | — | — |
| `create_if_missing` | `boolean` |  | `false` | — |
| `ensure_newline` | `boolean` |  | `true` | — |
| `prev_hash` | `string` |  | — | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `provenance` | `enum` |  | `"authored"` | One of: `"authored"`, `"agent_synthesis"` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created` | `boolean` |  | — |
| `content_hash` | `string \| null` | yes | — |
| `prev_hash` | `string \| null` |  | — |
| `bytes_written` | `number` |  | — |
| `quality_warning` | `object \| null` |  | — |
| `quality_warning.flags` | `string[]` | with parent | — |
| `quality_warning.computed_at` | `number` | with parent | — |
| `poison_assessment` | `object \| null` |  | — |
| `poison_assessment.risk` | `enum` | with parent | One of: `"none"`, `"suspect"`, `"high"` |
| `poison_assessment.signals` | `string[]` | with parent | — |
| `redactions` | `integer` |  | range ≥ 0 |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
