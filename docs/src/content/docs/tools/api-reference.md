---
title: API Reference
description: Connect to obsidian-tc over MCP (stdio or HTTP), discover and call tools through the triad facade, and authenticate.
sidebar:
  order: 2
---

obsidian-tc **is an MCP server** — its API is the [Model Context Protocol](https://modelcontextprotocol.io) (JSON-RPC 2.0) spoken over **stdio** or **Streamable HTTP**. Any MCP client (Claude Code / Desktop, Cursor, VS Code, or your own) talks to it the same way: negotiate, list tools, call tools. This is the callable reference; the [Tool Reference](/tools/) is the surface overview (facade + domains), and the [configuration reference](/configuration/config-yaml/) documents every option.

## Connect

### stdio (local, default)

The server runs on your machine over stdio — no network, no account, no key. Point any MCP client at the `npx` launcher:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/obsidian-tc.config.json" }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`) uses `mcpServers`; VS Code (`.vscode/mcp.json`) uses `servers`. Claude Code: `claude mcp add obsidian-tc --env OBSIDIAN_TC_CONFIG=/ABSOLUTE/PATH/TO/obsidian-tc.config.json -- npx -y obsidian-tc`. Or run it directly: `obsidian-tc /path/to/vault`.

### Streamable HTTP (remote)

Enable `transports.http` to serve MCP over HTTP for a remote client. A non-loopback bind **requires auth**: the config fails to load if `transports.http` is on a routable host while `auth.mode` is `none` — an unauthenticated server never binds a public address. `GET /obsidian-tc/v1/probe` is a health endpoint that returns `200` when the server is live.

## The tool API: discover, describe, call

By default `tools/list` advertises **three meta-tools** — the `triad` facade, set by `toolFacade.mode`. You search for a capability, inspect its schema, then invoke it. Every underlying tool also stays callable directly by name; the facade just shapes what `tools/list` advertises.

### 1. `find_capability` — search the catalog

BM25 search over the full tool surface. Returns capability names + one-line summaries.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "find_capability", "arguments": { "query": "read a note", "limit": 5 } } }
```

### 2. `describe_capability` — get a tool's schema

Returns the full input schema (JSON Schema 2020-12), the required scope set, and safety hints (`readOnlyHint` / `destructiveHint`).

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "describe_capability", "arguments": { "name": "read_note" } } }
```

### 3. `call_capability` — invoke by name

Runs the target with its arguments, through the same authorization / ACL / HITL / idempotency / rate-limit pipeline as a direct call — the target's own schema validates `args`.

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "call_capability",
    "arguments": { "name": "read_note", "args": { "path": "notes/example.md" } } } }
```

Results come back as MCP tool content — a human-readable `text` block plus `structuredContent` (the typed result). A failed call returns `isError: true` with the structured error attached, so a model can self-correct instead of seeing a protocol error.

The other `toolFacade.mode` values: `domain` (about a dozen `{ action, args }` domain tools) and `flat` (the full surface advertised directly). See the [Tool Reference](/tools/) for the domain map.

## Authenticate

| `auth.mode` | Use |
| --- | --- |
| `none` *(default)* | Loopback only, enforced by the fail-closed interlock above. |
| `jwt` | HS256 (`jwtSecret` / `OBSIDIAN_TC_JWT_SECRET`) **or** asymmetric RS256/ES256/EdDSA via an inline/file JWKS (`kid`-based rotation). Present the token as a bearer credential. |

With `auth.resource` + an `authorizationServers` entry set, the HTTP transport advertises an RFC 9728 Protected Resource Metadata document and a `WWW-Authenticate` challenge (the OAuth 2.1 resource-server role).

## Authorization, ACL, HITL

Every call — direct or via `call_capability` — passes the same gates:

- **Scopes** — each tool declares a required scope set; both `tools/list` and dispatch are filtered to the caller's scopes.
- **ACL** — per-path read / write / delete whitelists (`.obsidian/`, `.git/`, `.trash/` are always denied, case-folded); `readOnly` is a hard kill switch.
- **HITL** — destructive and `execute:*` operations require a human-in-the-loop confirmation token, so `git_commit` and `execute_command` can never fire silently.

## Errors

Failures return a typed error from the `ObsidianTcError` taxonomy (e.g. `plugin_missing`, `embedding_provider_error`, `requires_live_obsidian`, `read_only_mode`) with a `retryable` flag — never an opaque throw. At the MCP boundary a dispatch failure surfaces as a **Tool Execution Error** (`isError: true`, human-readable text plus the structured error as `structuredContent`).

## See also

- [Tool Reference](/tools/) — the tool surface, facade modes, and the domain map.
- [Configuration](/configuration/config-yaml/) — transports, auth, ACL, embeddings, retrieval.
- [Quickstart](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/QUICKSTART.md) — first run and live-bridge setup.
