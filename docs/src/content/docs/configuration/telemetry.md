---
title: Telemetry
description: Opt-in, anonymous usage telemetry — off by default, no default endpoint, and never any vault content.
---

obsidian-tc ships **no telemetry by default**. Nothing leaves the process unless you
explicitly turn it on **and** name a collector — there is no built-in endpoint, and
turning `telemetry.enabled` on without `telemetry.endpoint` set is a **config error at
boot**, not a silent no-op.

## What is sent

When enabled, one small JSON document is POSTed to your configured `endpoint` once
every `intervalMinutes` (never at boot, never before the first interval elapses):

```json
{
  "schema": "obsidian-tc.telemetry/1",
  "installId": "3b9e1a2c-4b1e-4a2f-9c3d-1e2f3a4b5c6d",
  "serverVersion": "1.31.3",
  "os": "linux",
  "arch": "x64",
  "facadeMode": "triad",
  "clientNames": ["claude-code"],
  "toolCalls": { "search_text": 42, "read_note": 17 },
  "errorCodes": { "acl_denied": 1 },
  "windowStart": 1737932400000,
  "windowEnd": 1737936000000
}
```

- **`installId`** — a random UUID generated on first send, stored in `cache.db`. Not
  derived from your machine, your vault, or anything else identifying. Rotate it any
  time with `obsidian-tc telemetry reset-id`.
- **`toolCalls`** / **`errorCodes`** — counts, keyed by tool name / error code. Both
  come from the server's own bounded, internal vocabularies (the registered tool list
  and the fixed error-code taxonomy), never from caller-supplied text.
- **`clientNames`** — up to 32 **distinct** MCP client names seen this window (e.g.
  `"claude-code"`, `"cursor"`) — which software connected, never who, never a token.
- **`facadeMode`** — which tool surface (`triad` / `domain` / `flat`) this server is
  advertising.

Inspect the exact document your server would send, right now, without sending it:

```
obsidian-tc telemetry preview
```

`telemetry preview --show-path` additionally shows your endpoint's path — off by
default, since a collector convention can also use the path as a credential (see
below).

## What is never sent

Vault paths, note content, search queries, vault ids, principals/callers, tokens,
hostnames, or environment variables. This is enforced structurally: the document is
validated against a `.strict()` schema whose key set is closed — a field outside that
set fails validation and is never sent, not merely "not currently populated." A
property-based test feeds adversarial tool/client names through the real counter
pipeline and asserts the same.

## Enabling it

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://your-collector.example/ingest",
    "intervalMinutes": 1440
  }
}
```

`endpoint` must be `https://` unless the host is loopback (`localhost` /
`127.0.0.1` / `[::1]`) — that carve-out exists for tests and for running a reference
collector locally, not for a production deployment. `endpoint` may **not** contain userinfo
(`https://user:pw@host/...`) — a URL is exactly what `telemetry preview`/`status`,
`doctor`, and `server_health` print, and what a failed send logs, so a credential
placed there would leak. If your collector needs authentication, set
`telemetry.authTokenEnv` to the **name** of an environment variable holding a bearer
token; it is sent as an `Authorization: Bearer <value>` header and never printed,
logged, or persisted anywhere.

`intervalMinutes` has a floor of 60 — this is aggregate, low-frequency telemetry, not
a heartbeat.

A send never blocks a tool call, never retries in a loop (one attempt per interval),
and never follows a redirect (which could otherwise resend your bearer token and the
document to an unaudited host). A failed send is logged once, at `warn`, with the
endpoint reduced to `scheme://host` — never the full URL — and the window's counters
are kept (not reset) so the next attempt is cumulative rather than lossy.

## Checking status

```
obsidian-tc telemetry status
```

Prints `enabled` / `endpoint` (redacted) / `installId` / `intervalMinutes` /
`lastSendAt` / `lastError` / `nextSendAt`. The same fields (minus `intervalMinutes`
and `nextSendAt`) appear in `doctor`'s report and in `server_health`'s `telemetry`
block, so a caller doesn't have to shell out to check them.

## Turning it off

Set `telemetry.enabled` back to `false` (or remove the block — `false` is the
default). No further sends happen; `installId` and the last-send outcome stay on
disk (harmless local state) unless you also clear `cache.db`.

## Obsidian plugin

The companion Obsidian desktop plugin does **not** participate in this feature at
all — it has no telemetry of its own, opt-in or otherwise, and does not read or
forward this server's telemetry config.

## Full disclosure

See [SECURITY.md](https://github.com/The-40-Thieves/obsidian-tc/blob/main/SECURITY.md#telemetry)
for the complete, security-reviewed statement of what is and is not sent, and how to
verify it yourself.
