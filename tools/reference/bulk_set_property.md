---
title: "bulk_set_property"
description: "Set one frontmatter property across many notes, with per-item results (prev_value)."
editUrl: false
---

Set one frontmatter property across many notes, with per-item results (prev_value). HITL-floored (bulk) and throttled; best-effort by default (stop_on_first_error opt-in). response_format=concise omits processed and duration_ms.

| | |
|---|---|
| **Domain** | metadata |
| **Scopes** | `write:notes`, `bulk:notes` |
| **Access** | write |
| **Tags** | `writes`, `hitl`, `bulk`, `domain:metadata` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to the vault paths the call names, which are also checked against the folder ACL.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `paths` | `string[]` | yes | — | items 1–500 |
| `key` | `string` | yes | — | length ≥ 1 |
| `value` | `any` | yes | — | — |
| `max_concurrent` | `integer` |  | `4` | range 1–16 |
| `stop_on_first_error` | `boolean` |  | `false` | — |
| `elicit_token` | `string` |  | — | pattern `^[a-f0-9]{32}$` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `processed` | `number` |  | — |
| `succeeded` | `number` | yes | — |
| `failed` | `number` | yes | — |
| `results` | `object[]` | yes | — |
| `results[].path` | `string` | yes | — |
| `results[].ok` | `boolean` | yes | — |
| `results[].prev_value` | `any` |  | — |
| `results[].redactions` | `number` |  | — |
| `results[].error` | `object` |  | — |
| `duration_ms` | `number` |  | — |
| `conventions` | `object` |  | — |
| `conventions.warnings` | `object[]` |  | — |
| `conventions.warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |
| `conventions.file_warnings` | `object[]` |  | — |
| `conventions.file_warnings_omitted` | `integer` |  | range ≥ -9007199254740991 |

## Related tools {#related-tools}

Other tools in the `metadata` domain: [`add_tag`](/tools/reference/add_tag/), [`find_notes_by_property`](/tools/reference/find_notes_by_property/), [`find_notes_by_tag`](/tools/reference/find_notes_by_tag/), [`get_conventions`](/tools/reference/get_conventions/), [`get_note_tags`](/tools/reference/get_note_tags/), [`list_properties`](/tools/reference/list_properties/), [`list_tags`](/tools/reference/list_tags/), [`read_frontmatter`](/tools/reference/read_frontmatter/), [`read_metadata_fields`](/tools/reference/read_metadata_fields/), [`read_property`](/tools/reference/read_property/), [`remove_tag`](/tools/reference/remove_tag/), [`suggest_tags`](/tools/reference/suggest_tags/), [`update_frontmatter`](/tools/reference/update_frontmatter/).

Back to the [tool catalog](/tools/tool-catalog/).
