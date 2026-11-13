---
title: "write_note"
description: "Create, overwrite, or upsert a note."
editUrl: false
---

Create, overwrite, or upsert a note. Optional prev_hash gives compare-and-swap; overwriting a non-empty note requires confirmation. Set provenance: "agent_synthesis" when the content is a derived/inferred conclusion an agent produced (not directly stated in any single source) rather than authored/copied text — this routes the content through a poison scan before the write lands (rejected outright on high risk) and surfaces the assessment in the result; also add source: agent-synthesis to the note's own frontmatter by convention. response_format=concise acknowledges with \{vault, path, content_hash\} only (plus quality_warning, poison_assessment or redactions when they carry something).

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:notes` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | yes |

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
| `content` | `string` | yes | — | — |
| `mode` | `enum` |  | `"create"` | "create" (default) fails if the note exists; "overwrite" replaces an existing note; "upsert" creates or replaces. There is no overwrite flag; to add to an existing note use append_note. One of: `"create"`, `"overwrite"`, `"upsert"` |
| `prev_hash` | `string` |  | — | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `provenance` | `enum` |  | `"authored"` | One of: `"authored"`, `"agent_synthesis"` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created` | `boolean` |  | — |
| `mode_used` | `enum` |  | One of: `"create"`, `"overwrite"` |
| `content_hash` | `string` | yes | — |
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

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/).

Back to the [tool catalog](/tools/tool-catalog/).
