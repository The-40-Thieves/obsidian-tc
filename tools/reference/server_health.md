---
title: "server_health"
description: "Liveness + build info."
editUrl: false
---

Liveness + build info. Round-trips the full transport -> auth -> acl -> audit path. Domain: admin.

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

This tool takes no parameters.

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `status` | `enum` | yes | One of: `"ok"` |
| `name` | `enum` | yes | One of: `"reliquary-tc"` |
| `version` | `string` | yes | — |
| `native_loaded` | `boolean` | yes | — |
| `vec_enabled` | `boolean` | yes | — |
| `memory` | `object` |  | — |
| `memory.rss_mb` | `number` | with parent | — |
| `memory.external_mb` | `number` | with parent | — |
| `memory.budget_mb` | `number \| null` | with parent | — |
| `memory.over_budget` | `boolean \| null` | with parent | — |
| `memory.embedder_host` | `object` |  | — |
| `fts_enabled` | `boolean` | yes | — |
| `fts` | `object` |  | Full-text (notes_fts) state. available; recovering (a transient database lock at startup, retried in the background with attempts, max_attempts and next_retry_at, and searches use slower exhaustive disk scans meanwhile); or unavailable with a reason (lock_contention once retries are spent, disabled by RELIQUARY_TC_DISABLE_FTS, no_notes_table, provision_failed, integrity_failed). last_error is withheld from callers that may not read every vault. |
| `fts.state` | `enum` | with parent | One of: `"available"`, `"recovering"`, `"unavailable"` |
| `fts.reason` | `enum` |  | One of: `"lock_contention"`, `"disabled"`, `"no_notes_table"`, `"provision_failed"`, `"integrity_failed"`, `"not_probed"` |
| `fts.attempts` | `number` |  | — |
| `fts.max_attempts` | `number` |  | — |
| `fts.next_retry_at` | `number` |  | — |
| `fts.last_error` | `string` |  | — |
| `vault_count` | `number` | yes | — |
| `vaults` | `string[]` |  | — |
| `uptime_ms` | `number` | yes | — |
| `index` | `object` |  | — |
| `index.reconcile` | `enum` | with parent | One of: `"pending"`, `"ok"`, `"degraded"` |
| `index.reconcile_at` | `number \| null` | with parent | — |
| `index.write_failures` | `number` | with parent | — |
| `index.frontmatter_failures` | `number` |  | — |
| `index.notes_ready` | `boolean` |  | — |
| `index.reconcile_source` | `enum` |  | One of: `"leader"`, `"self"` |
| `index.detail` | `object` |  | — |

_35 more field(s) not shown; `describe_capability` returns the full output schema._

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_index_status`](/tools/reference/get_index_status/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_acl`](/tools/reference/inspect_acl/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
