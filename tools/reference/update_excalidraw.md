---
title: "update_excalidraw"
description: "Add, remove, or update elements in an existing Excalidraw note via the companion plugin."
editUrl: false
---

Add, remove, or update elements in an existing Excalidraw note via the companion plugin.

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `write:excalidraw` |
| **Access** | write |
| **Tags** | `writes`, `plugin-bridge`, `domain:structured` |
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
| `add_elements` | `Record<string, any>[]` |  | — | — |
| `remove_element_ids` | `string[]` |  | — | — |
| `update_elements` | `Record<string, Record<string, any>>` |  | — | — |
| `update_app_state` | `Record<string, any>` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `path` | `string` | yes | — |
| `plugin_used` | `boolean` | yes | — |
| `unchanged` | `boolean` |  | — |
| `vault` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/).

Back to the [tool catalog](/tools/tool-catalog/).
