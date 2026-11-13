---
title: "create_canvas"
description: "Create a new .canvas with optional initial nodes/edges."
editUrl: false
---

Create a new .canvas with optional initial nodes/edges. Overwriting an existing canvas requires confirmation. Domain: structured.

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
| Accepts an idempotency key | yes |

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
| `nodes` | `object[]` |  | `[]` | — |
| `nodes[].id` | `string` | with parent | — | length ≥ 1 |
| `nodes[].type` | `enum` | with parent | — | One of: `"text"`, `"file"`, `"link"`, `"group"` |
| `nodes[].x` | `number` | with parent | — | — |
| `nodes[].y` | `number` | with parent | — | — |
| `nodes[].width` | `number` | with parent | — | — |
| `nodes[].height` | `number` | with parent | — | — |
| `nodes[].color` | `string` |  | — | — |
| `nodes[].text` | `string` |  | — | — |
| `nodes[].file` | `string` |  | — | — |
| `nodes[].subpath` | `string` |  | — | — |
| `nodes[].url` | `string` |  | — | — |
| `nodes[].label` | `string` |  | — | — |
| `edges` | `object[]` |  | `[]` | — |
| `edges[].id` | `string` | with parent | — | length ≥ 1 |
| `edges[].fromNode` | `string` | with parent | — | length ≥ 1 |
| `edges[].fromSide` | `enum` |  | — | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `edges[].fromEnd` | `enum` |  | — | One of: `"none"`, `"arrow"` |
| `edges[].toNode` | `string` | with parent | — | length ≥ 1 |
| `edges[].toSide` | `enum` |  | — | One of: `"top"`, `"right"`, `"bottom"`, `"left"` |
| `edges[].toEnd` | `enum` |  | — | One of: `"none"`, `"arrow"` |
| `edges[].color` | `string` |  | — | — |
| `edges[].label` | `string` |  | — | — |
| `overwrite` | `boolean` |  | `false` | — |
| `options` | `object` |  | `{}` | — |
| `options.idempotency_key` | `string` |  | — | length 1–128 |
| `options.create_dirs` | `boolean` |  | `true` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `created` | `boolean` | yes | — |
| `node_count` | `integer` | yes | range ≥ -9007199254740991 |
| `edge_count` | `integer` | yes | range ≥ -9007199254740991 |
| `content_hash` | `string` | yes | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_base`](/tools/reference/query_base/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
