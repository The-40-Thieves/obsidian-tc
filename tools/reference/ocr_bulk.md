---
title: "ocr_bulk"
description: "OCR a batch of attachments via the Text Extractor bridge."
editUrl: false
---

OCR a batch of attachments via the Text Extractor bridge. Resolves and ACL-filters the candidate set server-side; requires confirmation past 20 files.

| | |
|---|---|
| **Domain** | attachments |
| **Scopes** | `read:ocr` |
| **Access** | read |
| **Tags** | `read-only`, `hitl`, `plugin-bridge`, `domain:attachments` |
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

The handler asks for confirmation only when a call crosses a boundary (for example an overwrite, a folder-boundary crossing or a bulk-cost floor); other calls need none.

- The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `paths` | `string[]` |  | — | — |
| `root` | `string` |  | — | length 1–1024 |
| `extensions` | `string[]` |  | — | — |
| `force` | `boolean` |  | — | — |
| `max_concurrent` | `integer` |  | — | range 1–4 |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `requested` | `integer` | yes | range ≥ 0 |
| `processed` | `integer` | yes | range ≥ 0 |
| `results` | `object[]` | yes | — |
| `results[].path` | `string` | yes | — |
| `results[].ok` | `boolean` | yes | — |
| `results[].text` | `string` |  | — |
| `results[].error` | `string` |  | — |
| `total_duration_ms` | `number` | yes | range ≥ 0 |

## Related tools {#related-tools}

Other tools in the `attachments` domain: [`delete_attachment`](/tools/reference/delete_attachment/), [`get_attachment`](/tools/reference/get_attachment/), [`list_attachments`](/tools/reference/list_attachments/), [`move_attachment`](/tools/reference/move_attachment/), [`ocr_attachment`](/tools/reference/ocr_attachment/), [`write_attachment`](/tools/reference/write_attachment/).

Back to the [tool catalog](/tools/tool-catalog/).
