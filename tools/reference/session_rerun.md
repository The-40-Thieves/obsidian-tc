---
title: "session_rerun"
description: "Re-issue a recorded session's captured tool calls against a DISPOSABLE SANDBOX COPY of its vault (never the live one) and report divergence per call."
editUrl: false
---

Re-issue a recorded session's captured tool calls against a DISPOSABLE SANDBOX COPY of its vault (never the live one) and report divergence per call. Sandbox-only: there is no parameter that selects the live-vault observe mode reliquary-tc's `rerun` CLI command offers — that path stays operator-only. Replayed calls run with the caller's own granted scopes intersected against the fixed replay ceiling (read/write/delete/bulk/execute, never admin), so a caller who cannot themselves mutate cannot get a mutating call replayed as successful. Requires admin:rerun plus a human confirmation (destructive). Domain: admin.

| | |
|---|---|
| **Domain** | admin |
| **Scopes** | `admin:rerun` |
| **Access** | destructive |
| **Tags** | `writes`, `destructive`, `hitl`, `admin`, `domain:admin` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | no |
| Destructive | yes |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

A single-use `elicit_token` (or a transport-verified confirmation) is required on every call.

- The confirmation binds to a fingerprint of the state being approved, so a confirmation given for since-changed state is refused with `replay_drift`.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. May be omitted when only one vault is available. length 1–64; pattern `^[a-z0-9_-]+$` |
| `session_id` | `string` | yes | — | length ≥ 1 |
| `timeout_ms` | `integer` |  | — | range 1–300000 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `session_id` | `string` | yes | — |
| `vault` | `string` | yes | — |
| `records` | `object[]` | yes | — |
| `records[].seq` | `number` | yes | — |
| `records[].ts` | `number` | yes | — |
| `records[].tool` | `string` | yes | — |
| `records[].caller` | `string \| null` | yes | — |
| `records[].verdict` | `enum` | yes | One of: `"runnable"`, `"no_capture"`, `"redacted"`, `"truncated"`, `"skipped_mutating"`, `"unparseable"`, `"refused_by_policy"`, `"served_from_cache"` |
| `records[].reason` | `string` | yes | — |
| `records[].recorded` | `object` | yes | — |
| `records[].replayed` | `object \| null` | yes | — |
| `records[].divergence` | `enum` | yes | One of: `"none"`, `"status"`, `"error_code"` |
| `summary` | `object` | yes | — |
| `summary.total` | `number` | yes | — |
| `summary.runnable` | `number` | yes | — |
| `summary.diverged` | `number` | yes | — |
| `summary.byVerdict` | `Record<string, number>` | yes | — |

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_acl`](/tools/reference/inspect_acl/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`server_health`](/tools/reference/server_health/).

Back to the [tool catalog](/tools/tool-catalog/).
