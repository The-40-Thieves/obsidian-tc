---
title: "bulk_create_notes"
description: "Batch-create notes with per-item results."
editUrl: false
---

Batch-create notes with per-item results. Each item creates/overwrites/upserts a note (content + optional frontmatter). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in). response_format=concise omits processed, duration_ms and each item's mode_used.

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `write:notes`, `bulk:notes` |
| **Access** | write |
| **Tags** | `writes`, `hitl`, `bulk`, `domain:notes` |
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

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `items` | `object[]` | yes | — | items 1–200 |
| `items[].path` | `string` | yes | — | length 1–1024 |
| `items[].content` | `string` | yes | — | — |
| `items[].frontmatter` | `Record<string, any>` |  | — | — |
| `items[].mode` | `enum` |  | `"create"` | One of: `"create"`, `"overwrite"`, `"upsert"` |
| `items[].idempotency_key` | `string` |  | — | length 1–128 |
| `bulk_idempotency_key` | `string` |  | — | length 1–128 |
| `max_concurrent` | `integer` |  | `4` | range 1–16 |
| `stop_on_first_error` | `boolean` |  | `false` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `processed` | `number` |  | — |
| `succeeded` | `number` | yes | — |
| `failed` | `number` | yes | — |
| `results` | `object[]` | yes | — |
| `results[].path` | `string` | yes | — |
| `results[].ok` | `boolean` | yes | — |
| `results[].mode_used` | `enum` |  | One of: `"create"`, `"overwrite"` |
| `results[].content_hash` | `string` |  | — |
| `results[].redactions` | `number` |  | — |
| `results[].error` | `object` |  | — |
| `duration_ms` | `number` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
