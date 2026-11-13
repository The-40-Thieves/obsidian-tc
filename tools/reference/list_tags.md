---
title: "list_tags"
description: "Aggregate all tags (frontmatter + inline) across notes, with usage counts."
editUrl: false
---

Aggregate all tags (frontmatter + inline) across notes, with usage counts.

| | |
|---|---|
| **Domain** | metadata |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:metadata` |
| **Profile** | core, full |

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
| `folder` | `string` |  | — | length 1–1024 |
| `max_notes` | `integer` |  | `5000` | range 1–50000 |

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
| `notes_scanned` | `integer` | yes | range ≥ -9007199254740991 |
| `tags` | `object[]` | yes | — |
| `tags[].tag` | `string` | yes | — |
| `tags[].count` | `integer` | yes | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`bulk_set_property`](/tools/reference/bulk_set_property/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`find_notes_by_tag`](/tools/reference/find_notes_by_tag/), [`get_conventions`](/tools/reference/get_conventions/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`suggest_tags`](/tools/reference/suggest_tags/), [`update_frontmatter`](/tools/reference/update_frontmatter/).

Back to the [tool catalog](/tools/tool-catalog/).
