---
title: OpenTelemetry Tracing
description: Conditional distributed tracing that is a no-op until an OTLP endpoint is configured.
---

obsidian-tc can emit OpenTelemetry traces, but tracing is **conditional**: it is a
complete no-op unless `observability.otel.endpoint` is set. With no endpoint
configured, no exporter is created and dispatch is untouched — there is zero
overhead and no dependency on a live collector.

## What gets traced

When an OTLP/HTTP endpoint is configured, each tool dispatch is wrapped in a root
span named `obsidian_tc.<tool>` (kind `SERVER`), with structured child spans for
the phases of the call. Span attributes carry the tool name, vault id, scope
class, and call status — **never** tool arguments, secrets, or tokens.

Error spans are always recorded so failures are visible even under sampling.

## Configuration

```yaml
observability:
  traceDetail: verbose          # span granularity
  tracesSampleRate: 1.0
  otel:
    endpoint: http://localhost:4318   # unset = tracing disabled
    headers:
      authorization: Bearer ...
```

Tracing is exercised in tests with an in-memory exporter — unconfigured asserts
zero exporters and no throw; configured asserts the span shape — so no live
collector is ever required.
