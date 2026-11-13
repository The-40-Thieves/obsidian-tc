---
title: "add_kanban_card"
description: "Add a card to a Kanban column (by name)."
editUrl: false
---

Add a card to a Kanban column (by name). Appends `- [ ] text` (or `- [x]` when checked) under the column heading, preserving the rest of the board.

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `domain:structured` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
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
| `column` | `string` | yes | — | length ≥ 1 |
| `text` | `string` | yes | — | length ≥ 1 |
| `checked` | `boolean` |  | `false` | — |
| `prev_hash` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `column` | `string` | yes | — |
| `added` | `string` | yes | — |
| `content_hash` | `string` | yes | — |
| `prev_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
