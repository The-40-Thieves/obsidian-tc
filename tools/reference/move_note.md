---
title: "move_note"
description: "Move/rename a note and update backlinks."
editUrl: false
---

Move/rename a note and update backlinks. Crossing a folder boundary OR overwriting an existing destination requires confirmation; an overwritten destination is soft-deleted to .trash (recoverable).

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `read:notes`, `write:notes`, `delete:notes` |
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
| `from` | `string` | yes | — | length 1–1024 |
| `to` | `string` | yes | — | length 1–1024 |
| `overwrite` | `boolean` |  | `false` | — |
| `update_backlinks` | `boolean` |  | `true` | — |
| `prev_hash` | `string` |  | — | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `from` | `string` | yes | — |
| `to` | `string` | yes | — |
| `moved` | `boolean` | yes | — |
| `overwritten` | `boolean` | yes | — |
| `trashed_dest_to` | `string \| null` | yes | — |
| `content_hash` | `string \| null` | yes | — |
| `backlinks_updated` | `object` | yes | — |
| `backlinks_updated.notes` | `number` | yes | — |
| `backlinks_updated.links` | `number` | yes | — |
| `warnings` | `object[]` |  | — |
| `warnings[].path` | `string` | with parent | — |
| `warnings[].property` | `string` |  | — |
| `warnings[].message` | `string` | with parent | — |
| `warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `immutable_not_updated` | `string[]` |  | — |
| `immutable_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `immutable_warning` | `string` |  | — |
| `schema_not_updated` | `string[]` |  | — |
| `schema_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `schema_warning` | `string` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
