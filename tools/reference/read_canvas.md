---
title: "read_canvas"
description: "Parse a .canvas file into its nodes and edges (JSONCanvas spec)."
editUrl: false
---

Parse a .canvas file into its nodes and edges (JSONCanvas spec). response_format=concise drops the layout (node geometry and background, edge sides and ends) and the counts.

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
| `path` | `string` | yes | — | length 1–1024 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `nodes` | `object[]` | yes | — |
| `nodes[].id` | `string` | yes | — |
| `nodes[].type` | `enum` | yes | One of: `"text"`, `"file"`, `"link"`, `"group"` |
| `nodes[].x` | `number` |  | — |
| `nodes[].y` | `number` |  | — |
| `nodes[].width` | `number` |  | — |
| `nodes[].height` | `number` |  | — |
| `nodes[].color` | `string` |  | — |
| `nodes[].text` | `string` |  | — |
| `nodes[].file` | `string` |  | — |
| `nodes[].subpath` | `string` |  | — |
| `nodes[].url` | `string` |  | — |
| `nodes[].label` | `string` |  | — |
| `nodes[].background` | `string` |  | — |
| `nodes[].backgroundStyle` | `string` |  | — |
| `edges` | `object[]` | yes | — |
| `edges[].id` | `string` | yes | — |
| `edges[].fromNode` | `string` | yes | — |
| `edges[].fromSide` | `enum` |  | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `edges[].toNode` | `string` | yes | — |
| `edges[].toSide` | `enum` |  | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `edges[].fromEnd` | `enum` |  | One of: `"none"`, `"arrow"` |
| `edges[].toEnd` | `enum` |  | One of: `"none"`, `"arrow"` |
| `edges[].color` | `string` |  | — |
| `edges[].label` | `string` |  | — |
| `node_count` | `integer` |  | range ≥ -9007199254740991 |
| `edge_count` | `integer` |  | range ≥ -9007199254740991 |
| `content_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
