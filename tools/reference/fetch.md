---
title: "fetch"
description: "Fetch one note by the id a search result returned and return {id, title, text, url, metadata}: the full note text (frontmatter included), an absolute citation url, and metadata {vault, path, conten..."
editUrl: false
---

Fetch one note by the id a search result returned and return \{id, title, text, url, metadata\}: the full note text (frontmatter included), an absolute citation url, and metadata \{vault, path, content_hash, modified\}. Refuses a note the caller may not read exactly as read_note does.

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
| `id` | `string` | yes | — | length 1–1100 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `id` | `string` | yes | — |
| `title` | `string` | yes | — |
| `text` | `string` | yes | — |
| `url` | `string` | yes | — |
| `metadata` | `object` | yes | — |
| `metadata.vault` | `string` | yes | — |
| `metadata.path` | `string` | yes | — |
| `metadata.content_hash` | `string` | yes | — |
| `metadata.modified` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`get_provenance`](/tools/reference/get_provenance/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
