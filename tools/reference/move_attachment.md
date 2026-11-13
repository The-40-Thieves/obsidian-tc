---
title: "move_attachment"
description: "Move/rename an attachment and repoint note links to it (link style preserved)."
editUrl: false
---

Move/rename an attachment and repoint note links to it (link style preserved). Crossing a folder boundary or overwriting requires confirmation.

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `read:attachments`, `write:attachments`, `delete:attachments` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:attachments` |
| **Profile** | full only |

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
| `update_references` | `boolean` |  | `true` | — |
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
| `references_updated` | `object` | yes | — |
| `references_updated.notes` | `integer` | yes | range ≥ -9007199254740991 |
| `references_updated.refs` | `integer` | yes | range ≥ -9007199254740991 |
| `immutable_not_updated` | `string[]` |  | — |
| `immutable_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `immutable_warning` | `string` |  | — |
| `schema_not_updated` | `string[]` |  | — |
| `schema_not_updated_hidden` | `integer` |  | range ≥ -9007199254740991 |
| `schema_warning` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`get_attachment`](/tools/reference/get_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
