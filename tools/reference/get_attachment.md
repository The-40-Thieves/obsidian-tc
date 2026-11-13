---
title: "get_attachment"
description: "Read an attachment's bytes (base64) plus MIME type and size."
editUrl: false
---

Read an attachment's bytes (base64) plus MIME type and size. Fails with invalid_input when the file exceeds max_bytes. Domain: attachments.

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `read:attachments` |
| **Access** | read |
| **Tags** | `read-only`, `domain:attachments` |
| **Profile** | full only |

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
| `path` | `string` | yes | — | length 1–1024 |
| `encoding` | `enum` |  | `"base64"` | One of: `"base64"` |
| `max_bytes` | `integer` |  | `10000000` | range 1–50000000 |
| `include_content` | `boolean` |  | `true` | — |
| `include_references` | `boolean` |  | `false` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `mime` | `string` | yes | — |
| `size` | `number` | yes | — |
| `encoding` | `enum` | yes | One of: `"base64"` |
| `description` | `string` | yes | — |
| `content` | `string` |  | — |
| `references` | `string[]` |  | — |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
