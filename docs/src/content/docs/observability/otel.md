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
root span named `obsidian_tc.<tool>` (kind `SERVER`). Its attributes carry the
tool name, vault id, scope class, and call status — **never** tool arguments,
secrets, or tokens.

`observability.otel.detail` controls what is emitted under the root span:

- `root` (default): the root span only. No child span is created and nothing
  extra is allocated, so the default costs what it always did.
- `children`: adds one child span per pipeline stage, in order: `input_parse`,
  `auth_check`, `policy_eval`, `idempotency` (keyed calls), `rate_limit` (when a
  limiter is configured), `hitl_check` (HITL-gated calls), `acl_eval`,
  `tool_impl`, `output_serialize`.
- `verbose`: also adds a `batch_item` span per item of `read_notes`,
  `read_resources` and `search_and_read`, and `db_transaction` /
  `db_savepoint` / `db_write_transaction` spans for SQLite transactions. At most
  64 child spans are created per request; the root carries
  `obsidian_tc.spans_dropped` when the cap cut some.

A failing call marks the span of the stage that failed with ERROR status and the
structured error code only. Child spans never carry error messages, stack
traces, note content, paths or tokens.

Every call is traced when tracing is enabled — there is no sampling knob.

## Configuration

```json
{
  "observability": {
    "otel": {
      "endpoint": "http://localhost:4318",
      "headers": { "authorization": "Bearer <token>" },
      "detail": "children"
    }
  }
}
```

Leaving `otel.endpoint` unset disables tracing (no exporters, no throw).

Tracing is exercised in tests with an in-memory exporter — unconfigured asserts
zero exporters and no throw; configured asserts the span shape — so no live
collector is ever required.
