---
title: "get_conventions"
description: "Return the vault conventions that apply to a note or folder: the SCHEMA.md layers that carry a conventions: block (root first, nearest last) and their merged rules (type key, required frontmatter, ..."
editUrl: false
---

Return the vault conventions that apply to a note or folder: the SCHEMA.md layers that carry a conventions: block (root first, nearest last) and their merged rules (type key, required frontmatter, allowed values per property and per type), each with the layer it came from. Call it before creating or editing notes in a folder, to learn the required frontmatter and allowed values. Layers you cannot read are omitted. Domain: metadata. response_format=concise drops layers and every source.

| | |
|---|---|
| **Domain** | metadata |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:metadata` |
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
| `path` | `string` |  | — | length 1–1024 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `layers` | `object[]` |  | — |
| `layers[].path` | `string` | with parent | — |
| `layers[].inherit` | `boolean` | with parent | — |
| `layers[].version` | `integer` | with parent | range ≥ -9007199254740991 |
| `effective` | `object` | yes | — |
| `effective.required` | `object` |  | — |
| `effective.values` | `Record<string, object>` | yes | — |
| `effective.severity` | `Record<string, object>` |  | — |
| `effective.type_key` | `object` |  | — |
| `effective.types` | `Record<string, object>` | yes | — |
| `hint` | `string` |  | — |
| `file_warnings` | `object[]` |  | — |
| `file_warnings[].path` | `string` | with parent | — |
| `file_warnings[].message` | `string` | with parent | — |
| `file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`bulk_set_property`](/tools/reference/bulk_set_property/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`find_notes_by_tag`](/tools/reference/find_notes_by_tag/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`list_tags`](/tools/reference/list_tags/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`suggest_tags`](/tools/reference/suggest_tags/), [`update_frontmatter`](/tools/reference/update_frontmatter/).

Back to the [tool catalog](/tools/tool-catalog/).
