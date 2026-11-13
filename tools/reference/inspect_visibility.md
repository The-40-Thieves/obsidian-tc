---
title: "inspect_visibility"
description: "Explain why a tool is or is not offered to a caller: returns listed | hidden | disabled | scope_denied | unregistered per tool, plus the RULE that decided it (which name/tag list matched, which req..."
editUrl: false
---

Explain why a tool is or is not offered to a caller: returns listed | hidden | disabled | scope_denied | unregistered per tool, plus the RULE that decided it (which name/tag list matched, which required scopes are missing). Pass `scopes`/`read_only` to evaluate a hypothetical caller the way inspect_acl does, `tool` to ask about one, or `visibility` to filter. response_format=concise returns \{name, visibility, reason\} per tool (plus matched_tag and missing_scopes when the verdict has them). Shares the registry's own classifier and config, so it cannot drift from what tools/list does. admin:acl-scoped BY DESIGN: distinguishing hidden from unregistered is exactly the existence oracle the unauthenticated surface refuses to be.

| | |
|---|---|
| **Domain** | admin |
| **Scopes** | `admin:acl` |
| **Access** | write |
| **Tags** | `read-only`, `admin`, `domain:admin` |
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
| `tool` | `string` |  | — | length ≥ 1 |
| `scopes` | `string[]` |  | — | — |
| `read_only` | `boolean` |  | — | — |
| `visibility` | `enum` |  | — | One of: `"listed"`, `"hidden"`, `"disabled"`, `"scope_denied"` |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `evaluated_for` | `object \| null` | yes | — |
| `evaluated_for.scopes` | `string[]` | yes | — |
| `evaluated_for.read_only` | `boolean` | yes | — |
| `summary` | `object` | yes | — |
| `summary.listed` | `number` | yes | — |
| `summary.hidden` | `number` | yes | — |
| `summary.disabled` | `number` | yes | — |
| `summary.scope_denied` | `number` | yes | — |
| `tools` | `object[]` | yes | — |
| `tools[].name` | `string` | yes | — |
| `tools[].domain` | `string \| null` |  | — |
| `tools[].visibility` | `enum` | yes | One of: `"listed"`, `"hidden"`, `"disabled"`, `"scope_denied"`, `"unregistered"` |
| `tools[].reason` | `string` | yes | — |
| `tools[].matched_tag` | `string \| null` |  | — |
| `tools[].missing_scopes` | `string[]` |  | — |
| `tools[].required_scopes` | `string[]` |  | — |
| `tools[].tags` | `string[]` |  | — |

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_acl`](/tools/reference/inspect_acl/), [`server_health`](/tools/reference/server_health/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
