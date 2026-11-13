---
title: "knowledge_get_critical"
description: "List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work."
editUrl: false
---

List the critical-severity docs in a vendor / external-docs corpus: the breaking changes, security issues, and production gotchas to read before starting work. A tight metadata pre-filter over frontmatter severity == 'critical', not a search. Optionally narrow by `source` (the vendor or tool the doc is about). Gated on read:docs so it stays isolated from the private vault. response_format=concise drops the count and the constant severity of each item.

| | |
|---|---|
| **Domain** | docs |
| **Scopes** | `read:docs` |
| **Access** | read |
| **Tags** | `read-only`, `domain:docs`, `docs`, `knowledge` |
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
| `source` | `string` |  | — | length ≥ 1 |
| `limit` | `integer` |  | `50` | range 1–200 |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `count` | `number` |  | — |
| `items` | `object[]` | yes | — |
| `items[].path` | `string` | yes | — |
| `items[].title` | `string` | yes | — |
| `items[].category` | `string \| null` | yes | — |
| `items[].source` | `string \| null` | yes | — |
| `items[].severity` | `enum` |  | One of: `"critical"` |

## Related tools {#related-tools}

Other tools in the `docs` domain: [`knowledge_search`](/tools/reference/knowledge_search/).

Back to the [tool catalog](/tools/tool-catalog/).
