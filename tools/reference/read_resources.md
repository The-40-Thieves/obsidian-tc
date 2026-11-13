---
title: "read_resources"
description: "Batch resources/read: read many reliquary-tc://<vault>/<path> note resource URIs in one call."
editUrl: false
---

Batch resources/read: read many reliquary-tc://&lt;vault>/&lt;path> note resource URIs in one call. Returns one result per URI in request order: \{ok: true, uri, mimeType, text\} (identical to a single resources/read) or \{ok: false, uri, error\} for a malformed or unsupported URI, a vault the caller may not read (a vault-bound caller may read only its own), a denied or missing note. The response is held under the server's byte budget: when the batch does not fit, the results that fit are returned with next_cursor; call again with the same arguments plus cursor to continue exactly where the page stopped (request order, no duplicates, no gaps) until next_cursor is null. A single resource too large to ever fit is reported as a too_large error (with its size and the budget) and skipped, so the walk always makes progress. A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns each item as \{ok: true, uri, text\} with the note body only (no frontmatter block, no mimeType); error items are unchanged.

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:notes` |
| **Profile** | core, full |

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
| `uris` | `string[]` | yes | — | items 1–100 |
| `cursor` | `string` |  | — | The next_cursor of a previous page of this same request. length 1–4096 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `results` | `object[]` | yes | — |
| `results[].ok` | `boolean` | yes | — |
| `results[].uri` | `string` | yes | — |
| `results[].mimeType` | `string` |  | — |
| `results[].text` | `string` |  | — |
| `results[].error` | `object` |  | — |
| `next_cursor` | `string \| null` | yes | — |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
