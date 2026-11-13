---
title: "query_canvas"
description: "Find nodes matching criteria across one or more .canvas files (defaults to all canvases under the vault root)."
editUrl: false
---

Find nodes matching criteria across one or more .canvas files (defaults to all canvases under the vault root).

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `read:canvas` |
| **Access** | read |
| **Tags** | `read-only`, `domain:structured` |
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
| `paths` | `string[]` |  | — | — |
| `root` | `string` |  | — | length 1–1024 |
| `filter` | `object` |  | `{}` | — |
| `filter.type` | `enum` |  | — | One of: `"text"`, `"file"`, `"link"`, `"group"` |
| `filter.color` | `string` |  | — | — |
| `filter.file_path_contains` | `string` |  | — | — |
| `filter.text_contains` | `string` |  | — | — |
| `filter.has_edge_to` | `string` |  | — | — |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `items` | `object[]` | yes | — |
| `items[].canvas_path` | `string` | yes | — |
| `items[].node_id` | `string` | yes | — |
| `items[].type` | `string` | yes | — |
| `items[].snippet` | `string` |  | — |
| `canvases_scanned` | `integer` | yes | range ≥ -9007199254740991 |
| `errors` | `object[]` | yes | — |
| `errors[].path` | `string` | yes | — |
| `errors[].code` | `string` | yes | — |
| `next_cursor` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
