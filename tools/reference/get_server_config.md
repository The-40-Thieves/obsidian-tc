---
title: "get_server_config"
description: "Read the non-secret server config: auth mode, server-global read_only + embeddings provider, throttle limits, observability targets, and a per-vault summary (id) plus a detected-plugins map."
editUrl: false
---

Read the non-secret server config: auth mode, server-global read_only + embeddings provider, throttle limits, observability targets, and a per-vault summary (id) plus a detected-plugins map. Never returns secrets. response_format=concise drops the per-class throttle tiers, the observability toggles and the retrieval-defaults report.

| | |
|---|---|
| **Domain** | admin |
| **Scopes** | `admin:config` |
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
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `version` | `string` | yes | — |
| `auth_mode` | `enum` | yes | One of: `"none"`, `"jwt"`, `"oidc"` |
| `read_only` | `boolean` | yes | — |
| `embeddings_provider` | `string` | yes | — |
| `vaults_summary` | `object[]` | yes | — |
| `vaults_summary[].id` | `string` | yes | — |
| `limits` | `object` | yes | — |
| `limits.max_concurrent_writes_per_vault` | `number` | yes | — |
| `limits.max_operations_per_second` | `number` | yes | — |
| `limits.max_operations_per_minute` | `number` | yes | — |
| `throttle_tiers` | `object` |  | — |
| `throttle_tiers.read` | `object` | with parent | — |
| `throttle_tiers.write` | `object` | with parent | — |
| `throttle_tiers.delete` | `object` | with parent | — |
| `throttle_tiers.bulk` | `object` | with parent | — |
| `throttle_tiers.execute` | `object` | with parent | — |
| `throttle_tiers.admin` | `object` | with parent | — |
| `throttle` | `object` | yes | — |
| `throttle.backend` | `enum` | yes | One of: `"memory"`, `"sqlite"`, `"redis"` |
| `throttle.failure_policy` | `enum` | yes | One of: `"fail-open"`, `"fail-closed"` |
| `governor` | `object` | yes | — |
| `governor.max_response_bytes` | `number` | yes | — |
| `observability` | `object` |  | — |
| `observability.otlp_enabled` | `boolean` | with parent | — |
| `observability.prometheus_enabled` | `boolean` | with parent | — |
| `observability.morgiana_enabled` | `boolean` | with parent | — |
| `plugins_detected` | `Record<string, string[]>` | yes | — |
| `retrieval_defaults` | `object` |  | — |
| `retrieval_defaults.derived_defaults_enabled` | `boolean` | with parent | — |
| `retrieval_defaults.knn_min_sim` | `object` | with parent | — |

_1 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_acl`](/tools/reference/inspect_acl/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`server_health`](/tools/reference/server_health/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
