---
title: "inspect_acl"
description: "Test whether a (vault, path, op, scopes) tuple would be permitted."
editUrl: false
---

Test whether a (vault, path, op, scopes) tuple would be permitted. Shares the live path evaluator (read-only kill switch + per-op whitelist) so it cannot drift from enforcement, then checks the op-family scope grant and the path-required rule-scopes (P1.4: a matching rule's scopes must all be held). Reports the matched path rule, the rule-based effective_scopes, and what denied it. Domain: admin.

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
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `path` | `string` | yes | — | length 1–1024 |
| `op` | `enum` | yes | — | One of: `"read"`, `"write"`, `"delete"`, `"execute"` |
| `scopes` | `string[]` |  | `[]` | — |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `allowed` | `boolean` | yes | — |
| `denied_by` | `enum` |  | One of: `"read_only"`, `"read_paths"`, `"write_paths"`, `"delete_paths"`, `"schema_file"`, `"scope"`, `"path_scope"` |
| `kill_switch` | `boolean` | yes | — |
| `matched_rule` | `string \| null` | yes | — |
| `effective_scopes` | `string[]` | yes | — |

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`server_health`](/tools/reference/server_health/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
