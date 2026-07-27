---
title: OpenTelemetry Tracing
description: Conditional distributed tracing that is a no-op until an OTLP endpoint is configured.
---

obsidian-tc can emit OpenTelemetry traces, but tracing is **conditional**: it is a
complete no-op unless `observability.otel.endpoint` is set. With no endpoint
configured, no exporter is created and dispatch is untouched — there is zero
overhead and no dependency on a live collector.

## What gets traced

When an OTLP/HTTP endpoint is configured, each tool dispatch is wrapped in a
single root span named `obsidian_tc.<tool>` (kind `SERVER`). There is no
child-span breakdown of the call's phases (auth/ACL/policy/impl/serialize) —
that was scoped for a later release and never shipped; the root span's
attributes carry the tool name, vault id, scope class, and call status —
**never** tool arguments, secrets, or tokens.

Every call is traced when tracing is enabled — there is no sampling knob.

## Configuration

```json
{
  "observability": {
    "otel": {
      "endpoint": "http://localhost:4318",
      "headers": { "authorization": "Bearer <token>" }
    }
  }
}
```

Leaving `otel.endpoint` unset disables tracing (no exporters, no throw).

Tracing is exercised in tests with an in-memory exporter — unconfigured asserts
zero exporters and no throw; configured asserts the span shape — so no live
collector is ever required.
