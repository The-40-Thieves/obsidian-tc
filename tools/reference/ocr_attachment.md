---
title: "ocr_attachment"
description: "Run OCR on a single image or PDF attachment via the Text Extractor bridge."
editUrl: false
---

Run OCR on a single image or PDF attachment via the Text Extractor bridge. Returns extracted text (cached by the plugin per file+model). Domain: attachments.

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `read:ocr` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:attachments` |
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
| `force` | `boolean` |  | `false` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `text` | `string` | yes | — |
| `cached` | `boolean` | yes | — |
| `duration_ms` | `number` | yes | range ≥ 0 |
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`get_attachment`](/tools/reference/get_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_bulk`](/tools/reference/ocr_bulk/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
