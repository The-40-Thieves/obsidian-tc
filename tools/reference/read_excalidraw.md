---
title: "read_excalidraw"
description: "Read an Excalidraw drawing's raw elements and/or extracted text."
editUrl: false
---

Read an Excalidraw drawing's raw elements and/or extracted text. source=plugin (default) proxies the live companion plugin; source=filesystem parses the .excalidraw / .excalidraw.md file on disk (works headlessly, no plugin); source=auto tries the plugin and falls back to the filesystem when it is unavailable.

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `read:excalidraw` |
| **Access** | read |
| **Tags** | `read-only`, `plugin-bridge`, `domain:structured` |
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
| `format` | `enum` |  | `"both"` | One of: `"elements"`, `"text"`, `"both"` |
| `source` | `enum` |  | `"plugin"` | One of: `"auto"`, `"plugin"`, `"filesystem"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `source` | `enum` | yes | One of: `"filesystem"`, `"plugin"` |
| `compressed` | `boolean` |  | — |
| `content_hash` | `string` |  | — |
| `elements` | `any[]` |  | — |
| `element_count` | `integer` |  | range ≥ -9007199254740991 |
| `embedded_files` | `object[]` |  | — |
| `embedded_files[].id` | `string` | with parent | — |
| `embedded_files[].mime_type` | `string \| null` | with parent | — |
| `app_state` | `object \| null` |  | — |
| `text` | `string` |  | — |
| `text_content` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
