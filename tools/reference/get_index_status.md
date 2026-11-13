---
title: "get_index_status"
description: "Search-index health at a glance: boot reconcile state, write-failure count, notes/FTS/vec readiness, chunks_upserted from the last index_vault call, and in-flight progress while one is currently ru..."
editUrl: false
---

Search-index health at a glance: boot reconcile state, write-failure count, notes/FTS/vec readiness, chunks_upserted from the last index_vault call, and in-flight progress while one is currently running. Read-only — self-diagnose before spending on an expensive search. chunks_upserted and in_flight count the shared index, notes a read rule hides included, so they are null / absent for a caller without unrestricted read. Domain: admin.

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
| `reconcile` | `enum` | yes | One of: `"pending"`, `"ok"`, `"degraded"` |
| `reconcile_at` | `number \| null` | yes | — |
| `write_failures` | `number` | yes | — |
| `frontmatter_failures` | `number` |  | — |
| `notes_ready` | `boolean` | yes | — |
| `reconcile_source` | `enum` | yes | One of: `"leader"`, `"self"` |
| `vec_enabled` | `boolean` | yes | — |
| `fts_enabled` | `boolean` | yes | — |
| `fts` | `object` |  | Full-text (notes_fts) state. available; recovering (a transient database lock at startup, retried in the background with attempts, max_attempts and next_retry_at, and searches use slower exhaustive disk scans meanwhile); or unavailable with a reason (lock_contention once retries are spent, disabled by RELIQUARY_TC_DISABLE_FTS, no_notes_table, provision_failed, integrity_failed). last_error is withheld from callers that may not read every vault. |
| `fts.state` | `enum` | with parent | One of: `"available"`, `"recovering"`, `"unavailable"` |
| `fts.reason` | `enum` |  | One of: `"lock_contention"`, `"disabled"`, `"no_notes_table"`, `"provision_failed"`, `"integrity_failed"`, `"not_probed"` |
| `fts.attempts` | `number` |  | — |
| `fts.max_attempts` | `number` |  | — |
| `fts.next_retry_at` | `number` |  | — |
| `fts.last_error` | `string` |  | — |
| `chunks_upserted` | `number \| null` | yes | — |
| `in_flight` | `object` |  | — |
| `in_flight.vault` | `string` | with parent | — |
| `in_flight.notesSeen` | `number` | with parent | — |
| `in_flight.notesProcessed` | `number` | with parent | — |
| `in_flight.chunksUpserted` | `number` | with parent | — |
| `in_flight.startedAt` | `number` | with parent | — |

## Related tools {#related-tools}

Other tools in the `admin` domain: [`cancel_task`](/tools/reference/cancel_task/), [`get_metrics`](/tools/reference/get_metrics/), [`get_server_config`](/tools/reference/get_server_config/), [`get_task_status`](/tools/reference/get_task_status/), [`inspect_acl`](/tools/reference/inspect_acl/), [`inspect_visibility`](/tools/reference/inspect_visibility/), [`server_health`](/tools/reference/server_health/), [`session_rerun`](/tools/reference/session_rerun/).

Back to the [tool catalog](/tools/tool-catalog/).
