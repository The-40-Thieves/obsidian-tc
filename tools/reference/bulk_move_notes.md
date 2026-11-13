---
title: "bulk_move_notes"
description: "Batch-move notes and rewrite backlinks across the whole link graph (rewrite phase is all-or-nothing)."
editUrl: false
---

Batch-move notes and rewrite backlinks across the whole link graph (rewrite phase is all-or-nothing). dry_run (default true) previews predicted backlink updates without touching disk. Set overwrite to clobber existing destinations (each is soft-deleted to .trash, recoverable). HITL-floored (bulk) and throttled.

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `read:notes`, `write:notes`, `delete:notes`, `bulk:notes` |
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
| `moves` | `object[]` | yes | — | items 1–100 |
| `moves[].from` | `string` | yes | — | length 1–1024 |
| `moves[].to` | `string` | yes | — | length 1–1024 |
| `update_backlinks` | `boolean` |  | `true` | — |
| `overwrite` | `boolean` |  | `false` | — |
| `dry_run` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `idempotency_key` | `string` |  | — | length 1–128 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `processed` | `number` | yes | — |
| `dry_run` | `boolean` | yes | — |
| `total_backlinks_updated` | `number` | yes | — |
| `hidden_backlinks` | `boolean` |  | — |
| `immutable_not_updated` | `string[]` |  | — |
| `immutable_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `immutable_warning` | `string` |  | — |
| `schema_not_updated` | `string[]` |  | — |
| `schema_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `schema_warning` | `string` |  | — |
| `unreadable_skipped` | `number` |  | — |
| `unreadable_warning` | `string` |  | — |
| `results` | `object[]` | yes | — |
| `results[].from` | `string` | yes | — |
| `results[].to` | `string` | yes | — |
| `results[].ok` | `boolean` | yes | — |
| `results[].backlinks_updated` | `number` |  | — |
| `results[].error` | `object` |  | — |
| `results[].would_block` | `object` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
