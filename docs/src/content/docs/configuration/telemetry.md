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

- **`installId`** — a random UUID generated on the first send (not at boot), stored in
  `cache.db`. Not derived from your machine, your vault, or anything else identifying.
  Rotate it any time with `obsidian-tc telemetry reset-id`.
- **`toolCalls`** — counts keyed by tool name, but ONLY a **registered** tool name can
  become a key: a `tools/call` naming anything else (including a bug, or a hostile
  client probing with an arbitrary string) is counted under a single fixed key,
  `"unknown"`, never under the caller's own string.
- **`errorCodes`** — counts keyed by this server's fixed, closed error-code taxonomy
  (e.g. `acl_denied`, `throttled`); anything that is not one of those codes is counted
  under `"unknown"` too, the same way.
- **`clientNames`** — up to 32 **distinct**, **canonicalized** client labels (the same
  small built-in table `toolFacade.mode: "auto"` matches client names against — today
  `"claude-code"` / `"cursor"`); a client whose name doesn't match anything in that
  table is counted under `"other"`, never under its own raw, caller-supplied string.
- **`facadeMode`** — which tool surface (`triad` / `domain` / `flat`) this server is
  advertising.

Inspect the exact document SHAPE and your install id, without sending anything:

```
obsidian-tc telemetry preview
```

**`toolCalls`/`errorCodes`/`clientNames` are always empty in `telemetry preview`'s
output** — this CLI command runs in its own short-lived process, which has observed no
tool calls at all. To see a RUNNING server's real counts, read `server_health`'s
`telemetry` block or `doctor`'s report on that server instead.

`telemetry preview --show-path` additionally shows your endpoint's path — off by
default, since a collector convention can also use the path as a credential (see
below).

## What is never sent

Vault paths, note content, search queries, vault ids, principals/callers, tokens,
hostnames, or environment variables. This is enforced structurally: the document is
validated against a `.strict()` schema whose key set is closed — a field outside that
set fails validation and is never sent, not merely "not currently populated." Within
`toolCalls`/`errorCodes`/`clientNames`, the same structural enforcement applies at the
KEY level, not just the top level — see the allowlisting described above. A
property-based test dispatches adversarial tool names (paths, URLs) through this
server's real dispatch path — the exact route a hostile `tools/call` would take, not a
hand-built call into the counter directly — and asserts the resulting document never
contains a path separator, a `scheme://` marker, or the caller's raw string, at any
depth.

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
collector locally, not for a production deployment. It also may not name a literal
private, link-local, carrier-grade-NAT, unspecified, or cloud-metadata IP address
(e.g. `192.168.x.x`, `10.x.x.x`, `169.254.169.254`) — loopback is the one such range
that stays allowed. A hostname that happens to *resolve* to one of these at request
time is not checked (this is a config-time, literal-text check only, documented as
such — resolving DNS during config validation would need a network call and could
still differ from the address actually used at send time).

`endpoint` may **not** contain userinfo (`https://user:pw@host/...`) — a URL is
exactly what `telemetry preview`/`status`, `doctor`, and `server_health` print, and
what a failed send logs, so a credential placed there would leak. If your collector
needs authentication, set `telemetry.authTokenEnv` to the **name** of an environment
variable holding a bearer token — the document and that token both travel to your
collector, so `endpoint` still needs to be encrypted in transit; it is sent as an
`Authorization: Bearer <value>` header and never printed, logged, or persisted
anywhere. If `authTokenEnv` is set but the named variable is unset, the send is
refused (never sent unauthenticated) and reported in `doctor`/`telemetry status`.

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
`lastSendAt` / `lastError` / `nextSendAt`. The same fields (minus `intervalMinutes`)
appear in `doctor`'s report and in `server_health`'s `telemetry` block, so a caller
doesn't have to shell out to check them.

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
