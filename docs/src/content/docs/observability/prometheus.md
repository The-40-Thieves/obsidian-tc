---
title: Prometheus Metrics
description: The metrics catalog and the optional, auth-gated /metrics scrape endpoint.
---

<!-- BEGIN GENERATED: metrics-catalog -->

<!-- END GENERATED: metrics-catalog -->

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
