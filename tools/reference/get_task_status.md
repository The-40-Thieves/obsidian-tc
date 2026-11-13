---
title: "get_task_status"
description: "Status of a long-running tool call that returned a task handle instead of a result (index_vault on a large vault does)."
editUrl: false
---

Status of a long-running tool call that returned a task handle instead of a result (index_vault on a large vault does). Pass the task_id from the handle; while status is working it reports progress, and once completed it carries the tool's result. Read-only; only the caller that started the task can read it. Domain: admin.

| | |
|---|---|
| **Domain** | admin |
| **Scopes** | none |
| **Access** | read |
| **Tags** | `read-only`, `domain:admin` |
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
| `task_id` | `string` | yes | — | length 1–200 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `task_id` | `string` | yes | — |
| `status` | `enum` | yes | One of: `"working"`, `"input_required"`, `"completed"`, `"failed"`, `"cancelled"` |
| `created_at` | `string` | yes | — |
| `last_updated_at` | `string` | yes | — |
| `progress` | `object` |  | — |
| `progress.done` | `number` | with parent | — |
| `progress.total` | `number` |  | — |
| `progress.message` | `string` |  | — |
| `retry_after_seconds` | `number` |  | — |
| `result` | `Record<string, any>` |  | — |
| `error` | `object` |  | — |
| `error.code` | `number` | with parent | — |
| `error.message` | `string` | with parent | — |
| `error.data` | `Record<string, any>` |  | — |
| `status_message` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`inspect_acl`](/tools/reference/inspect_acl/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`server_health`](/tools/reference/server_health/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
