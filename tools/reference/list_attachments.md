---
title: "list_attachments"
description: "List attachment files in the vault (filtered by extension, read-ACL aware), with cursor pagination."
editUrl: false
---

List attachment files in the vault (filtered by extension, read-ACL aware), with cursor pagination. Optionally count referencing notes per file. response_format=concise returns \{path, reference_count?\} per attachment, without size, mtime, mime, folder, attachment_folder and total_returned.

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
| `folder` | `string` |  | — | length 1–1024 |
| `extensions` | `string[]` |  | — | — |
| `include_reference_count` | `boolean` |  | `false` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `folder` | `string` |  | — |
| `attachment_folder` | `string` |  | — |
| `attachments` | `object[]` | yes | — |
| `attachments[].path` | `string` | yes | — |
| `attachments[].size` | `number` |  | — |
| `attachments[].mtime` | `number` |  | — |
| `attachments[].mime` | `string` |  | — |
| `attachments[].reference_count` | `integer` |  | range ≥ -9007199254740991 |
| `next_cursor` | `string \| null` | yes | — |
| `total_returned` | `integer` |  | range ≥ -9007199254740991 |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`get_attachment`](/tools/reference/get_attachment/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
