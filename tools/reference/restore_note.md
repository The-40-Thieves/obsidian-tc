---
title: "restore_note"
description: "Restore a note to a prior snapshot's content."
editUrl: false
---

Restore a note to a prior snapshot's content. Destructive — overwrites the current note (whose current state is itself snapshotted first when snapshots are enabled, so the restore is reversible) and requires confirmation.

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
| Accepts an idempotency key | no |

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
| `snapshot_id` | `integer` | yes | — | range ≥ 1 |
| `prev_hash` | `string` |  | — | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `restored` | `boolean` | yes | — |
| `restored_from` | `number` | yes | — |
| `content_hash` | `string` | yes | — |
| `prev_hash` | `string \| null` | yes | — |
| `redactions` | `number` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
