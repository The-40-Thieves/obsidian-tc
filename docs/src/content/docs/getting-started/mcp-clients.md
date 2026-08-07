---
title: MCP client compatibility
description: Which MCP clients connect to obsidian-tc, over which transports, and what each one actually sees. Measured rows only — untested cells say so.
---

**This table is incomplete on purpose.** Every filled cell was observed against a running server;
every unfilled one says `UNTESTED` rather than guessing. A compatibility matrix whose blanks are
inferred is worth less than no matrix, because a reader cannot tell which cells were measured.

Contributions welcome — the [reproduction steps](#reproducing-a-row) below are the whole method.

## The matrix

Measured against **obsidian-tc 1.19.0** on **Ubuntu 24.04 aarch64** (Ampere), which is also the
platform of a required CI leg and of the maintainer's production deployment.

**Re-verified on 1.20.0 (2026-08-07)** by re-running the stdio probe from
[Reproducing a row](#reproducing-a-row). Every claim in the Claude Code row still holds: the
negotiated version is `2025-11-25`, `tools/list` returns exactly the three facade tools, each
carrying `name` / `title` / `description` / `inputSchema` / `annotations`, and the advertised
capabilities are `tools` / `prompts` / `resources` / `logging`. The captured output below is left at
its original 1.19.0 capture rather than restamped — it was a real observation on a real config, and
re-labelling it with a version it was not taken under would be the kind of quiet drift this page
exists to avoid.

| Client | stdio | Streamable HTTP | Surface | `outputSchema` | Auth |
|---|---|---|---|---|---|
| **Claude Code** | ✅ connects | ✅ connects | 3-tool facade | ✅ honoured | bearer on HTTP; none on stdio |
| Claude Desktop | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` |
| Cursor | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` |
| VS Code | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` | `UNTESTED` |

The three unfilled rows need a desktop session driving GUI clients. Nothing about them is known to
be broken; they simply have not been exercised.

**Why daily production use does not fill them.** It is reasonable to assume a server in constant use
must know which clients connect to it — obsidian-tc even captures `client_name` / `client_version`
from MCP `_meta`. In the maintainer's deployment those columns are `NULL` on every session, because
every request arrives through a gateway that presents its own principal; the end-user client sits
behind that hop and is structurally invisible to the server. So this matrix cannot be back-filled
from traffic, however much traffic there is. It needs **direct** client-to-server connections, which
is exactly what the reproduction steps below describe.

## What was observed

### stdio

The server announces itself and serves without a token:

```
security: profile=trusted-local auth=jwt readOnly=false strictRead=false requireCas=false http=on
obsidian-tc 1.19.0 ready on stdio (vault agents; native=on vec=on)
```

`initialize` returns:

```json
{ "protocolVersion": "2025-11-25",
  "serverInfo": { "name": "obsidian-tc", "version": "1.19.0" },
  "capabilities": { "tools":     { "listChanged": true },
                    "prompts":   { "listChanged": true },
                    "resources": { "listChanged": true, "subscribe": true },
                    "logging":   {} } }
```

`tools/list` returns exactly three tools — `find_capability`, `describe_capability`,
`call_capability` — each carrying `name`, `title`, `description`, `inputSchema`, `annotations`.

**On the negotiated version.** A client that sends a 2025-era `initialize` gets `2025-11-25` back,
*even if it names a later version in the request*. That is correct rather than a downgrade: the
2026-07-28 revision **removed the initialize/initialized handshake entirely** (SEP-2575), so a
2026-era client does not handshake at all and is classified per request instead. Asking for
`2026-07-28` inside an `initialize` is a contradiction in terms, and the server resolves it the
only way it can.

Legacy support is deliberate and load-bearing, not residual: the gateway in front of the
maintainer's deployment pins an MCP client whose ceiling is `2025-11-25`. Dropping the older era
would take that plane down.

### Streamable HTTP

Requires a bearer token, and refuses cleanly without one — HTTP `401` with a well-formed JSON-RPC
error rather than a bare status or a hang:

```json
{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "missing bearer token" }, "id": null }
```

Authenticated, `describe_capability` returns a full JSON Schema `output_schema` alongside
`required_scopes` and `annotations { read_only, destructive }`.

**Auth applies per transport.** With `auth.mode: "jwt"` configured, HTTP demands a bearer while
stdio does not — stdio's trust boundary is the process boundary. Worth knowing before exposing a
port.

### Cross-platform

Four `build-test` legs are **required** on every pull request:

| leg | |
|---|---|
| `ubuntu-latest` | x86_64 |
| `ubuntu-24.04-arm` | **aarch64** |
| `macos-latest` | |
| `windows-latest` | |

The aarch64 leg is not padding. `search/vec.ts` records the same commit producing nDCG@10
**0.8028** on aarch64 and **0.8414** on x86_64 — while `recall_at10` and the candidate counts
matched *exactly*. The difference is **tie ordering**, not retrieval quality: chunks with identical
content embed to bit-identical distances, and on that corpus the rank-10 distance spans the top-10
cut, so the tie order decides top-10 membership. Ranking metrics move; set-based ones do not.

That is a narrow effect on a duplicate-heavy fixture rather than a statement about arm retrieval
being worse. It is still the reason arm is a first-class target rather than a portability
courtesy — the maintainer's production runs Ampere.

## Reproducing a row

### stdio

Pipe a handshake straight into the server; no client required.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| obsidian-tc serve ./my-config.json
```

The process stays alive after answering — stdio has no end-of-stream. Read the responses and stop it.

### Streamable HTTP

```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}'
```

Omit the `Authorization` header to observe the refusal path.

## What each column means

- **stdio / Streamable HTTP** — whether the transport connects and completes a handshake at all.
- **Surface** — whether the client is shown the 3-tool facade (`find_capability` /
  `describe_capability` / `call_capability`) or the full per-tool catalogue. The facade exists
  because tool-selection quality collapses well before a catalogue this size.
- **`outputSchema`** — whether the client requests and honours structured output. The server emits
  `structuredContent` whenever a tool declares an output schema, including on the **error** path so
  a model can self-correct from the validation issues.
- **Auth** — which transports demand a bearer under `auth.mode: "jwt"`.
