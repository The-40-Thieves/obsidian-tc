---
title: "query_base"
description: "Execute a base view and return resolved rows."
editUrl: false
---

Execute a base view and return resolved rows. A view's groupOrder (Obsidian 1.14) keeps only the listed groups, in that order; null is the no-value group. Filters/formulas may use reliquary-tc's JSONLogic model OR the real Obsidian Bases expression DSL (a documented subset); constructs outside the subset — and trees mixing both models — are refused with unsupported_base_filter.

| | |
|---|---|
| **Domain** | structured |
| **Scopes** | `read:bases` |
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
| `view` | `string` |  | — | — |
| `override_filters` | `object \| string` |  | — | — |
| `limit` | `integer` |  | — | range 1–1000 |
| `cursor` | `string` |  | — | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `warnings` | `object[]` |  | — |
| `warnings[].path` | `string` | with parent | — |
| `warnings[].reason` | `enum` | with parent | One of: `"frontmatter_yaml"` |
| `warnings[].message` | `string` | with parent | — |
| `warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `view_used` | `string \| null` | yes | — |
| `total` | `integer` | yes | range ≥ -9007199254740991 |
| `items` | `object[]` | yes | — |
| `items[].note_path` | `string` | yes | — |
| `items[].columns` | `Record<string, any>` | yes | — |
| `items[].group` | `any` |  | — |
| `next_cursor` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `structured` domain: [`add_kanban_card`](/tools/reference/add_kanban_card/), [`create_base`](/tools/reference/create_base/), [`create_canvas`](/tools/reference/create_canvas/), [`create_excalidraw`](/tools/reference/create_excalidraw/), [`format_table`](/tools/reference/format_table/), [`insert_table_column`](/tools/reference/insert_table_column/), [`insert_table_row`](/tools/reference/insert_table_row/), [`list_kanban_boards`](/tools/reference/list_kanban_boards/), [`move_kanban_card`](/tools/reference/move_kanban_card/), [`query_canvas`](/tools/reference/query_canvas/), [`read_base`](/tools/reference/read_base/), [`read_canvas`](/tools/reference/read_canvas/), [`read_excalidraw`](/tools/reference/read_excalidraw/), [`read_kanban_board`](/tools/reference/read_kanban_board/), [`sort_table_by_column`](/tools/reference/sort_table_by_column/), [`update_base`](/tools/reference/update_base/), [`update_canvas`](/tools/reference/update_canvas/), [`update_excalidraw`](/tools/reference/update_excalidraw/).

Back to the [tool catalog](/tools/tool-catalog/).
