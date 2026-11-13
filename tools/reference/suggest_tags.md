---
title: "suggest_tags"
description: "Suggest tags for a note, preferring the vault's existing tag vocabulary."
editUrl: false
---

Suggest tags for a note, preferring the vault's existing tag vocabulary. Asks the calling client's own model over MCP sampling when the client supports it (`source: client-sampled`; the note text is sent to that client only); otherwise falls back to a deterministic match against existing tags (`source: heuristic`). Read-only: apply a suggestion with add_tag. response_format=concise returns only source and the suggestions. Domain: metadata.

| | |
|---|---|
| **Domain** | metadata |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:metadata`, `client-sampling` |
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
| `max_suggestions` | `integer` |  | `5` | range 1–10 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `notes_read_refused` | `integer` |  | range ≥ -9007199254740991 |
| `vault` | `string` | yes | — |
| `path` | `string` |  | — |
| `source` | `enum` | yes | One of: `"client-sampled"`, `"heuristic"` |
| `sampling` | `object` |  | — |
| `sampling.status` | `enum` | with parent | One of: `"sampled"`, `"unsupported"`, `"declined_or_failed"`, `"rejected_response"` |
| `sampling.model` | `string` |  | — |
| `note_tags` | `string[]` |  | — |
| `suggestions` | `object[]` | yes | — |
| `suggestions[].tag` | `string` | yes | — |
| `suggestions[].in_vocabulary` | `boolean` | yes | — |
| `hint` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`bulk_set_property`](/tools/reference/bulk_set_property/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`find_notes_by_tag`](/tools/reference/find_notes_by_tag/), [`get_conventions`](/tools/reference/get_conventions/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`list_tags`](/tools/reference/list_tags/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`update_frontmatter`](/tools/reference/update_frontmatter/).

Back to the [tool catalog](/tools/tool-catalog/).
