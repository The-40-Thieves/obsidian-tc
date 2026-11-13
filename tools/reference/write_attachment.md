---
title: "write_attachment"
description: "Write a binary attachment (image, PDF, audio, video) into the vault from base64 content."
editUrl: false
---

Write a binary attachment (image, PDF, audio, video) into the vault from base64 content. A bare filename goes to the vault's attachment folder; a path with a folder is used as given. Refuses existing files unless overwrite is set, which requires confirmation and soft-deletes the prior bytes to .trash. Capped by writes.maxAttachmentBytes (default 25 MB decoded).

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `write:attachments` |
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
| `path` | `string` | yes | — | length 1–1024 |
| `content` | `string` | yes | — | length ≤ 66666668 |
| `mime_type` | `string` |  | — | length 1–127 |
| `overwrite` | `boolean` |  | `false` | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created` | `boolean` | yes | — |
| `overwritten` | `boolean` | yes | — |
| `size` | `integer` | yes | range ≥ -9007199254740991 |
| `mime` | `string` | yes | — |
| `sha256` | `string` | yes | — |
| `trashed_prev_to` | `string \| null` | yes | — |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`get_attachment`](/tools/reference/get_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/).

Back to the [tool catalog](/tools/tool-catalog/).
