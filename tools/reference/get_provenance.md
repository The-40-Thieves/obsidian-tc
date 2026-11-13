---
title: "get_provenance"
description: "Signed write history of one note: which mutating tool calls changed it, newest first, each with outcome, timestamp, sha256 before/after, and who made the call."
editUrl: false
---

Signed write history of one note: which mutating tool calls changed it, newest first, each with outcome, timestamp, sha256 before/after, and who made the call. `verified` holds what the server established (host, and the principal/persona/session only when a bearer token was verified); `unauthenticated` a caller label nobody proved; `self_reported` what the client claimed about itself (model, project, agent, client) and can be false. Moves (move_note, bulk_move_notes, move_attachment) are followed backwards to the note's earlier paths, but only through move records that verify: a move that fails stops the walk and is reported as lineage_incomplete. One bounded pass over the chain: scan_truncated means the row budget ran out and older history was not examined. Only paths you can read are listed, an unreadable path answers exactly like one with no history, and a record naming other paths never shows the ones you cannot read (its hash is then a hash of the visible view). cursor is the signed next_cursor of a previous page of the same request. include_verification re-checks each returned record's hash, signature and chain link (not whole-chain completeness: run `reliquary-tc provenance verify`). since/until are epoch milliseconds, inclusive. Needs read:provenance as well as read:notes. response_format=concise drops the host, the full path list, the record hash and machine.

| | |
|---|---|
| **Domain** | notes |
| **Scopes** | `read:notes`, `read:provenance` |
| **Access** | read |
| **Tags** | `read-only`, `domain:notes` |
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
| `limit` | `integer` |  | `50` | range 1–200 |
| `cursor` | `string` |  | — | The next_cursor of a previous page of this same request. length 1–4096 |
| `since` | `integer` |  | — | range ≥ 0 |
| `until` | `integer` |  | — | range ≥ 0 |
| `include_verification` | `boolean` |  | `false` | — |
| `response_format` | `enum` |  | — | concise returns only the high-signal fields; detailed (the shipped default) returns the full payload. Errors and safety warnings are never trimmed. When omitted, the server's tools.defaults.responseFormat applies. One of: `"concise"`, `"detailed"` |
| `verbosity` | `enum` |  | — | Legacy alias for response_format: terse = concise, full = detailed. One of: `"full"`, `"terse"` |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `vault` | `string` | yes | — |
| `path` | `string` | yes | — |
| `previous_paths` | `string[]` | yes | — |
| `records` | `object[]` | yes | — |
| `records[].seq` | `number` | yes | — |
| `records[].ts` | `number` | yes | — |
| `records[].tool` | `string` | yes | — |
| `records[].outcome` | `enum` | yes | One of: `"ok"`, `"error"`, `"pending"` |
| `records[].path` | `string` | yes | — |
| `records[].before` | `string` |  | — |
| `records[].after` | `string` |  | — |
| `records[].paths` | `object[]` |  | — |
| `records[].paths_truncated` | `boolean` |  | — |
| `records[].hash` | `string` |  | — |
| `records[].head_untrusted` | `boolean` |  | — |
| `records[].verified` | `object` | yes | — |
| `records[].unauthenticated` | `object` | yes | — |
| `records[].self_reported` | `object` | yes | — |
| `records[].verification` | `object` |  | — |
| `next_cursor` | `string \| null` | yes | — |
| `scan_truncated` | `boolean` |  | — |
| `lineage_incomplete` | `object` |  | — |
| `lineage_incomplete.reason` | `string` | with parent | — |
| `lineage_incomplete.seq` | `number` | with parent | — |

## Related tools {#related-tools}

Other tools in the `notes` domain: [`append_note`](/tools/reference/append_note/), [`bulk_create_notes`](/tools/reference/bulk_create_notes/), [`bulk_move_notes`](/tools/reference/bulk_move_notes/), [`copy_note`](/tools/reference/copy_note/), [`delete_note`](/tools/reference/delete_note/), [`fetch`](/tools/reference/fetch/), [`list_notes`](/tools/reference/list_notes/), [`list_snapshots`](/tools/reference/list_snapshots/), [`move_note`](/tools/reference/move_note/), [`note_exists`](/tools/reference/note_exists/), [`patch_note`](/tools/reference/patch_note/), [`read_note`](/tools/reference/read_note/), [`read_notes`](/tools/reference/read_notes/), [`read_resources`](/tools/reference/read_resources/), [`read_snapshot`](/tools/reference/read_snapshot/), [`restore_note`](/tools/reference/restore_note/), [`snapshot_note`](/tools/reference/snapshot_note/), [`write_note`](/tools/reference/write_note/).

Back to the [tool catalog](/tools/tool-catalog/).
