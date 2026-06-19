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

```yaml
observability:
  morgiana:
    spool: true                 # JSONL file spool (default)
    httpEndpoint: ...           # optional HTTP sink
    httpHeaders: { ... }
```
