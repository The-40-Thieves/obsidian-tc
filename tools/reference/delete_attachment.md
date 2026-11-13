---
title: "delete_attachment"
description: "Delete an attachment (to the vault's .trash mirror, or permanently)."
editUrl: false
---

Delete an attachment (to the vault's .trash mirror, or permanently). Destructive — requires confirmation. Reports notes that still reference it.

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `delete:attachments` |
| **Access** | destructive |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:attachments` |
| **Profile** | full only |

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

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |
| `permanent` | `boolean` |  | `false` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `deleted` | `boolean` | yes | — |
| `permanent` | `boolean` | yes | — |
| `trashed_to` | `string \| null` | yes | — |
| `size` | `number \| null` | yes | — |
| `references` | `string[]` | yes | — |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`get_attachment`](/tools/reference/get_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
