---
title: "find_notes_by_tag"
description: "Find notes carrying a tag, hierarchically (a query for `project` matches `project` and `project/sub`)."
editUrl: false
---

Find notes carrying a tag, hierarchically (a query for `project` matches `project` and `project/sub`). response_format=concise returns \{path\} per match, without the matched tags and `total`.

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
| `tag` | `string` | yes | — | length ≥ 1 |
| `folder` | `string` |  | — | length 1–1024 |
| `limit` | `integer` |  | `100` | range 1–1000 |
| `cursor` | `string` |  | — | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

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
| `tag` | `string` | yes | — |
| `total` | `integer` |  | range ≥ -9007199254740991 |
| `truncated` | `boolean` | yes | — |
| `next_cursor` | `string \| null` | yes | — |
| `matches` | `object[]` | yes | — |
| `matches[].path` | `string` | yes | — |
| `matches[].tags` | `string[]` |  | — |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`bulk_set_property`](/tools/reference/bulk_set_property/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`get_conventions`](/tools/reference/get_conventions/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`list_tags`](/tools/reference/list_tags/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`suggest_tags`](/tools/reference/suggest_tags/), [`update_frontmatter`](/tools/reference/update_frontmatter/).

Back to the [tool catalog](/tools/tool-catalog/).
