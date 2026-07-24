# Observability

obsidian-tc is **observable from day one**. The Observability layer is the last stage of the dispatch pipeline and **always fires** — on success and on every error path. Emission is non-blocking: a slow sink drops the span/event with an `[obsidian-tc:obs-drop]` log line rather than stalling the call. Full design: [`docs/G2.4-observability.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.4-observability.md).

## Five emitters per tool call

| Emitter | What it produces |
|---|---|
| **OpenTelemetry** | A span `obsidian_tc.tool_call` tagged `{tool, vault, caller, status, args_hash}` with end-to-end duration, exported over OTLP |
| **Prometheus** | Increments `obsidian_tc_tool_calls_total{tool, vault, status}` and records `obsidian_tc_tool_duration_seconds{tool, vault}` |
| **CloudEvents / MORGIANA** | A structured event per call, async fire-and-forget |
| **JSONL trace** | Appends to the current session's trace file |
| **event_log row** | A SQLite insert for local debug replay |

## Configuration

```json
"observability": {
  "otel": { "enabled": true, "endpoint": "http://localhost:4318" },
  "prometheus": { "enabled": true },
  "morgiana": { "endpoint": "", "token": "" },
  "retention": { "tracesDays": 90, "eventLogDays": 30 }
}
```

## Prometheus endpoint

When HTTP transport is enabled, metrics are scrapeable at `GET /metrics`. The `get_metrics` admin tool returns the same counters as structured JSON for clients without a Prometheus scraper.

## JSONL traces

Per-vault, per-session: `<cacheDir>/traces/<YYYY-MM-DD>/<session_id>.jsonl`, rolled daily and retained 90 days. Sessions are opened with `start_session` and closed with `end_session`; `get_session_traces` replays events from a session or date window. Because each row carries `args_hash` (not raw args), traces are replayable without leaking note contents.

## event_log

A table in the shared `cache.db`, row-scoped by vault (not a per-vault file); no cross-vault analytics in v1. `get_metrics` can scope to one vault or aggregate across all.

## Health

`server_health` round-trips the full transport → auth → ACL → audit path and returns liveness + build info — use it as a readiness probe.
