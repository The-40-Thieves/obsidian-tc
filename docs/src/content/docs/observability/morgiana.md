---
title: MORGIANA Event Spool
description: A fail-soft CloudEvents 1.0 JSONL spool of nine lifecycle and tool events.
---

**MORGIANA** is obsidian-tc's structured event spool. Each event is a
[CloudEvents 1.0](https://cloudevents.io/) envelope written as one JSON line to a
daily-rotated file under the cache directory
(`<cacheDir>/<vault>/morgiana-events-<date>.jsonl`).

## The nine event types

| Event | When |
| --- | --- |
| `tc.tool.call.completed` | every tool call (always) |
| `tc.acl.denied` | a scope/ACL denial |
| `tc.elicit.requested` | a HITL confirmation is requested |
| `tc.elicit.consumed` | a HITL approval is consumed at handler entry |
| `tc.rate_limit.hit` | a call is throttled |
| `tc.governor.overflow` | a response is truncated by the governor |
| `tc.vault.cache_reset` | a vault cache is reset |
| `tc.server.start` | server startup |
| `tc.server.shutdown` | graceful shutdown (incl. SIGTERM/SIGINT) |

## Fail-soft by design

The spool **never blocks or crashes a tool call**. A write failure is swallowed,
counted (`morgiana_emit_dropped_total`), and recorded in the local event log; the
tool call proceeds unaffected. The vault-id and date path components are sanitized,
so a crafted vault id cannot escape the cache directory.

## Configuration

```json
{
  "observability": {
    "morgiana": {
      "spool": true,
      "httpEndpoint": "https://example.com/events",
      "httpHeaders": { "authorization": "Bearer <token>" }
    }
  }
}
```

`spool` writes the JSONL file spool (default `true`); `httpEndpoint` and
`httpHeaders` are optional and enable an additional HTTP sink.

## Spool retention

The spool is one file per vault per UTC day,
`<cacheDir>/<vault>/morgiana-events-<YYYY-MM-DD>.jsonl`. The maintenance sweep
deletes whole finished day files and never truncates one:

- `observability.retention.spoolRetentionDays` (default `30`; `0` keeps the
  spool forever) deletes files older than the window.
- `observability.retention.spoolMaxBytes` (optional) caps each vault's spool by
  deleting its oldest day files first.

The file for the current UTC day, any file modified in the last hour,
symlinks and anything not named like a spool file are never touched. Set the
window longer than the longest time MORGIANA can be down, because a deleted day
cannot be replayed. Each sweep logs one `[maintenance] morgiana spool sweep`
line and adds to `obsidian_tc_morgiana_spool_files_pruned_total{reason}`.
