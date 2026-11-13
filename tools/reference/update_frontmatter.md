---
title: "update_frontmatter"
description: "Mutate a note's frontmatter (set/remove/merge/replace)."
editUrl: false
---

Mutate a note's frontmatter (set/remove/merge/replace). `replace` discards all existing metadata and requires confirmation, except on a note whose frontmatter is not valid YAML (nothing parsed to discard): that is the repair route, and it needs no approval. `replace` takes `properties` (an object) or `frontmatter_yaml` (raw YAML for the whole block, no --- lines; validated before anything is written and refused with the parse error if invalid). set/remove/merge on a note whose frontmatter is not valid YAML are refused. Optional prev_hash gives compare-and-swap. Set nested=true to address a dotted key path for set/remove (intermediate objects are created as needed). response_format=concise acknowledges with \{vault, path, content_hash\} only (no frontmatter echo).

| | |
|---|---|
| **Domain** | metadata |
| **Scopes** | `write:notes` |
| **Access** | write |
| **Tags** | `writes`, `destructive`, `hitl`, `domain:metadata` |
| **Profile** | core, full |

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
| `operation` | `enum` | yes | — | One of: `"set"`, `"remove"`, `"merge"`, `"replace"` |
| `key` | `string` |  | — | length ≥ 1 |
| `value` | `any` |  | — | — |
| `properties` | `Record<string, any>` |  | — | — |
| `frontmatter_yaml` | `string` |  | — | length ≤ 200000 |
| `prev_hash` | `string` |  | — | — |
| `create_if_missing` | `boolean` |  | `false` | — |
| `nested` | `boolean` |  | `false` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `operation` | `enum` |  | One of: `"set"`, `"remove"`, `"merge"`, `"replace"` |
| `created` | `boolean` |  | — |
| `frontmatter` | `object \| null` |  | — |
| `content_hash` | `string` | yes | — |
| `prev_hash` | `string \| null` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`bulk_set_property`](/tools/reference/bulk_set_property/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`find_notes_by_tag`](/tools/reference/find_notes_by_tag/), [`get_conventions`](/tools/reference/get_conventions/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`list_tags`](/tools/reference/list_tags/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`suggest_tags`](/tools/reference/suggest_tags/).

Back to the [tool catalog](/tools/tool-catalog/).
