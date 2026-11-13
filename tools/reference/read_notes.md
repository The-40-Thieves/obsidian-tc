---
title: "read_notes"
description: "Batch-read notes."
editUrl: false
---

Batch-read notes. Returns successful notes and a per-path error list (partial). The response is held under the server's byte budget: when the batch does not fit, the notes that fit are returned with next_cursor; call again with the same arguments plus cursor to continue exactly where the page stopped (request order, no duplicates, no gaps) until next_cursor is null. A single note too large to ever fit is reported as a too_large error (with its size and the budget) and skipped, so the walk always makes progress. A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns each note as \{path, body, content_hash\} (no raw content, no frontmatter); per-path errors are unchanged.

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
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `paths` | `string[]` | yes | — | items 1–100 |
| `cursor` | `string` |  | — | The next_cursor of a previous page of this same request. length 1–4096 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `notes` | `object[]` | yes | — |
| `notes[].raw_frontmatter` | `string` |  | — |
| `notes[].frontmatter_error` | `object` |  | — |
| `notes[].warning` | `string` |  | — |
| `notes[].path` | `string` | yes | — |
| `notes[].content` | `string` |  | — |
| `notes[].frontmatter` | `object \| null` |  | — |
| `notes[].body` | `string` | yes | — |
| `notes[].content_hash` | `string` | yes | — |
| `errors` | `object[]` | yes | — |
| `errors[].path` | `string` | yes | — |
| `errors[].code` | `string` | yes | — |
| `errors[].message` | `string` | yes | — |
| `errors[].size` | `number` |  | — |
| `errors[].budget` | `number` |  | — |
| `next_cursor` | `string \| null` | yes | — |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
