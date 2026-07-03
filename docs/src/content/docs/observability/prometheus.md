---
title: Prometheus Metrics
description: The metrics catalog and the optional, auth-gated /metrics scrape endpoint.
---

obsidian-tc maintains a Prometheus catalog of **8 counters, 2 histograms, and 4
gauges**. The recorder is always live so the `get_metrics` tool and the optional
`/metrics` scrape endpoint share the same in-memory state.

## Catalog (shape)

- **Counters** include `obsidian_tc_tool_calls_total`, `acl_denied_total`,
  `governor_truncations_total`, `rate_limit_hits_total`, and
  `morgiana_emit_dropped_total` (plus idempotency counters registered at zero
  pending their v1 source).
- **Histograms**: `tool_duration_seconds` and `response_bytes` (the latter with
  byte-scale buckets).
- **Gauges**: active sessions, capture-queue depth, pending elicitation tokens, and
  idempotency cache bytes.

Labels are deliberately **low-cardinality** — `vault` and `scope_class`, never raw
tool arguments or per-caller hashes — so the series count stays bounded.

## The /metrics endpoint

Disabled by default. When `observability.prometheus.enabled` is set, a small HTTP
listener serves `/metrics` on `prometheus.bind:port`. Its auth floor mirrors the
MCP HTTP transport:

- **loopback bind** → open;
- **non-loopback bind** → requires JWT;
- **non-loopback + `auth.mode: none`** → refused at startup.

```json
{
  "observability": {
    "prometheus": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 9464
    }
  }
}
```
