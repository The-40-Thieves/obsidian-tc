---
title: "update_canvas"
description: "Patch a .canvas: add/remove/update nodes and edges by id."
editUrl: false
---

Patch a .canvas: add/remove/update nodes and edges by id. Unknown fields are preserved. Removing more than 10 nodes requires confirmation.

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `write:canvas` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:structured` |
| **Profile** | full only |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

The handler asks for confirmation only when a call crosses a boundary (for example an overwrite, a folder-boundary crossing or a bulk-cost floor); other calls need none.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |
| `add_nodes` | `object[]` |  | — | — |
| `add_nodes[].id` | `string` | with parent | — | length ≥ 1 |
| `add_nodes[].type` | `enum` | with parent | — | One of: `"text"`, `"file"`, `"link"`, `"group"` |
| `add_nodes[].x` | `number` | with parent | — | — |
| `add_nodes[].y` | `number` | with parent | — | — |
| `add_nodes[].width` | `number` | with parent | — | — |
| `add_nodes[].height` | `number` | with parent | — | — |
| `add_nodes[].color` | `string` |  | — | — |
| `add_nodes[].text` | `string` |  | — | — |
| `add_nodes[].file` | `string` |  | — | — |
| `add_nodes[].subpath` | `string` |  | — | — |
| `add_nodes[].url` | `string` |  | — | — |
| `add_nodes[].label` | `string` |  | — | — |
| `add_edges` | `object[]` |  | — | — |
| `add_edges[].id` | `string` | with parent | — | length ≥ 1 |
| `add_edges[].fromNode` | `string` | with parent | — | length ≥ 1 |
| `add_edges[].fromSide` | `enum` |  | — | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `add_edges[].fromEnd` | `enum` |  | — | One of: `"none"`, `"arrow"` |
| `add_edges[].toNode` | `string` | with parent | — | length ≥ 1 |
| `add_edges[].toSide` | `enum` |  | — | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `add_edges[].toEnd` | `enum` |  | — | One of: `"none"`, `"arrow"` |
| `add_edges[].color` | `string` |  | — | — |
| `add_edges[].label` | `string` |  | — | — |
| `remove_node_ids` | `string[]` |  | — | — |
| `remove_edge_ids` | `string[]` |  | — | — |
| `update_nodes` | `Record<string, Record<string, any>>` |  | — | — |
| `update_edges` | `Record<string, Record<string, any>>` |  | — | — |
| `prev_hash` | `string` |  | — | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `applied` | `object` | yes | — |
| `applied.nodes_added` | `integer` | yes | range ≥ -9007199254740991 |
| `applied.nodes_removed` | `integer` | yes | range ≥ -9007199254740991 |
| `applied.nodes_updated` | `integer` | yes | range ≥ -9007199254740991 |
| `applied.edges_added` | `integer` | yes | range ≥ -9007199254740991 |
| `applied.edges_removed` | `integer` | yes | range ≥ -9007199254740991 |
| `applied.edges_updated` | `integer` | yes | range ≥ -9007199254740991 |
| `content_hash` | `string` | yes | — |
| `prev_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
