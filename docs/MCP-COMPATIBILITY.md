# MCP protocol & client compatibility

THE-510 shipped two deliverables. **Deliverable A (perf benchmarks) is now published** — see
[Performance benchmarks](https://obsidian-tc.the40thieves.io/observability/performance-benchmarks/).
Its "gated on a measurement host" blocker was refuted on 2026-08-07: six isolated `ubuntu-latest`
dispatches cleared the harness's own variance gate, six times out of six. This page is deliverable
B only: what obsidian-tc's MCP surface can be shown to support, and what cannot honestly be claimed
yet.

**Ground rule: nothing below is asserted without evidence.** Every row cites where that evidence
comes from — a test in this repo's own conformance suite, a source-level check against a locally
available SDK, or "not tested." obsidian-tc is a public repository; a compatibility matrix is a
public claim, and a wrong one is worse than a short one. If you can turn a "not tested" cell into
a real test or a documented live-client integration, that PR is welcome — see below for the
suite this page is generated against reading.

## Protocol revisions this server speaks

obsidian-tc runs a dual-era MCP server (THE-583): it serves **2025-11-25** (the "legacy" era —
`initialize`/`initialized` handshake, per-connection sessions) and **2026-07-28** (the "modern"
era — SEP-2575's stateless per-request envelope, `server/discover` in place of the handshake)
*on the same endpoint, simultaneously*, distinguishing eras per request rather than per
deployment.

This is not incidental. `packages/server/test/mcp-protocol-eras.test.ts` names the reason in its
own header comment: LiteLLM, the gateway obsidian-tc's own production deployment sits behind,
pins the `mcp` Python SDK at `1.28.1`, whose ceiling is 2025-11-25 — "losing legacy is an
outage." Losing the modern era is separately guarded because the opt-in that serves it is easy to
regress silently (moving it to the wrong object leaves every *existing* test green).

The SDK that makes the modern-era assertions below possible is
**`@modelcontextprotocol/server`**, pinned to its non-beta `"2.0.0"` release
(`packages/server/package.json`). It is the only one of the v2 packages this repo imports — 13
import sites across 12 files.

This paragraph used to name `@modelcontextprotocol/node` alongside it as jointly load-bearing. That
was wrong in both directions: `/node` is the **Node.js middleware adapter** (it wraps
`@hono/node-server` for callers who want the SDK to own their HTTP layer), it is not a dependency of
`/server` — the peer edge runs the other way — and this repo never imported it, because
`src/transports/` implements its own transport directly on `@hono/node-server` and `Bun.serve`. It
was removed as an unused dependency; nothing in the matrix below rested on it.

## Capability matrix

Evidence key:
- **suite** — asserted on the wire by this repo's own test suite (file named in the Evidence
  column; `bun run test` / `just test` runs it).
- **source** — read directly from source, not exercised by an HTTP round-trip in that test.
- **not tested** — no assertion exists either way. Never read this as "unsupported"; it means
  exactly what it says.

| Capability | 2025-11-25 (legacy) | 2026-07-28 (modern) | Evidence |
|---|---|---|---|
| Connection model | `initialize` handshake, session-scoped | `server/discover`, stateless per-request (SEP-2575) | suite — `mcp-protocol-eras.test.ts`, `protocol-2026-conformance.test.ts` |
| `tools/list`, `tools/call` | works | works, including with **no** prior handshake at all | suite — `mcp-protocol-eras.test.ts` ("serves a MODERN client: tools/call with NO initialize handshake") |
| `Mcp-Session-Id` | issued | never issued | suite — `protocol-2026-conformance.test.ts` (SEP-2567) |
| Required routing headers (`Mcp-Method`/`Mcp-Name`) | not required | required; a body/header mismatch is refused with error code `-32020` | suite — `protocol-2026-conformance.test.ts`, `mcp-protocol-eras.test.ts` (SEP-2243) |
| Envelope validation (`_meta` client capabilities) | not applicable | a request missing `clientCapabilities` in `_meta` is refused by name | suite — `mcp-protocol-eras.test.ts` (SEP-2575 envelope) |
| `resultType` discriminator on every result | absent | present (`"complete"` on an ordinary result, `"task"` when deferred) | suite — `protocol-2026-conformance.test.ts`, `task-augmented.test.ts` (SEP-2322) |
| Cache hints (`ttlMs`, `cacheScope`) | fields undefined (frozen 2025-era wire schema never defined them) | present on `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`; `tools/list` is `private`-scoped (per-caller filtering), `prompts/list` is `public` | suite — `protocol-2026-conformance.test.ts`, `mcp-protocol-eras.test.ts` (SEP-2549) |
| SSE stream resumability (`Last-Event-ID`) | n/a | not advertised — removed in this revision; a `Last-Event-ID` header is accepted but ignored, not treated as a redelivery cursor | suite — `protocol-2026-conformance.test.ts` (SEP-2575) |
| Removed legacy methods (`ping`, `logging/setLevel`, `initialize`) | served | explicitly refused (JSON-RPC error, not silently ignored) | suite — `protocol-2026-conformance.test.ts` |
| Unknown/future protocol version | — | refused with `400` naming the unrecognized version; the advertised set is finite | suite — `mcp-protocol-eras.test.ts` |
| Tasks extension (`tasks/get`, `tasks/cancel`, `tasks/update`, `notifications/tasks`) | **not served at all** — "Tasks does not exist in that revision" | served, but only when the *client* declares the `io.modelcontextprotocol/tasks` extension capability; a client that does not is never handed a deferred-task handle and gets a synchronous result instead | suite — `mcp-tasks-wire.test.ts`, `task-augmented.test.ts`, `notifications-tasks.test.ts` |
| `subscriptions/listen` (server-push events outside a request) | n/a | works — acknowledges a subscription and delivers events published outside any in-flight request; does not deliver types the client didn't opt into | suite — `subscriptions-listen.test.ts` (SEP-2575) |
| HITL multi-round-trip (`inputRequired` + signed `requestState`) | n/a (no `_meta` envelope to carry it) | a destructive call the caller must confirm returns `inputRequired` + a `requestState`, not a bare error; the same state must be echoed back to authorize the *same* call — different arguments, tool, vault, or caller are all refused | suite — `hitl-multi-round-trip.test.ts`, `elicit-request-state.test.ts` (SEP-2260/2322) |
| JSON Schema dialect on `inputSchema`/`outputSchema` | draft-2020-12 | draft-2020-12 (unchanged; SEP-2106 loosened the *keyword set* accepted, not the dialect this server emits) | suite — `protocol-surface.test.ts`, `schema-dialect.test.ts`, `tool-surface-2025.test.ts` |
| `outputSchema` + `structuredContent`, tool-execution errors as structured results (SEP-1303) | present | present (unchanged by the 2026 revision) | suite — `tool-surface-2025.test.ts` |
| `x-mcp-header` custom-header annotation on tool parameters (SEP-2243) | present | present | suite — `protocol-surface.test.ts` |
| Client `roots`/`sampling` capabilities reaching every tool (SEP-2577) | supported, gated on the client advertising it | supported and explicitly marked *deprecated-but-functional* by the spec (12-month functional window) — this server still honors it | suite — `protocol-surface.test.ts`, `client-features.test.ts` |
| Client-declared logging level filtering (RFC 5424 severities) | supported | supported | suite — `client-features.test.ts` |
| DNS-rebinding guard (`Host`/`Origin` allow-listing) | enforced | enforced | suite — `http-rebinding-guard.test.ts` — transport-level, not protocol-era-scoped |
| Protected Resource Metadata (RFC 9728) | served when `resource`/AS are configured | served when `resource`/AS are configured | suite — `mcp-auth-prm.test.ts` — transport-level, not protocol-era-scoped |
| Per-caller dispatch isolation (identity/scopes/vault never leak across concurrent callers) | enforced | enforced | suite — `http-caller-isolation.test.ts` — transport-level, not protocol-era-scoped |
| Live third-party client (Claude Desktop, Cursor, VS Code, an actual LiteLLM instance, MCP Inspector, …) | **not tested** | **not tested** | none — see "What this page does not claim," below. Claude Code is the exception: re-verified against 1.20.0 and recorded in the [client matrix](https://obsidian-tc.the40thieves.io/getting-started/mcp-clients/) |

## SDK support (a different axis — read separately)

The table above is about what *this server* does on the wire, asserted by *this server's own*
test suite. It says nothing about what any given MCP client SDK actually implements — a client
could be fully spec-conformant and still choose not to speak the 2026-07-28 era for years (exactly
what LiteLLM's pin does today). The following is source-level evidence from the SDK checkouts
available locally (`~/src/*-sdk`, `~/src/inspector`), gathered by checking whether each SDK's own
protocol-revision registry lists `2026-07-28` as a known/supported version — **not** by running
a live client against obsidian-tc.

| SDK | Local checkout | 2026-07-28 referenced in source? |
|---|---|---|
| TypeScript (`typescript-sdk`) | `2.0.0` @ `cc4b416` (2026-07-28) | Yes — separate `spec.types.2026-07-28.ts` / `spec.types.2025-11-25.ts` modules, `protocolEras.ts` |
| Python (`python-sdk`) | `2.0.0` @ `6f69a37` (2026-07-28) | Yes — `mcp_types/version.py` explicitly enumerates `KNOWN_PROTOCOL_VERSIONS` (2024-11-05 … 2026-07-28), splitting `HANDSHAKE_PROTOCOL_VERSIONS` (pre-2026) from `MODERN_PROTOCOL_VERSIONS` (`2026-07-28` only) — the same era split obsidian-tc implements independently |
| C# (`csharp-sdk`) | `v2.0.0` @ `15f8b2d` (2026-07-28) | Yes (docs reference tasks/mrtr extensions and a roadmap entry) |
| Go (`go-sdk`) | `v1.7.0` @ `bc72835` (2026-07-27) | Yes (README/docs reference it) |
| Rust (`rust-sdk` / `rmcp`) | `v3.0.0` @ `4e361b7` (2026-07-28) | Yes (README/docs reference it) |
| Ruby (`ruby-sdk`) | @ `5a879b3` (2026-07-28) | Yes (`lib/mcp/server.rb`, `server_session.rb` reference it) |
| Java (`java-sdk`) | @ `fd00498` (2026-07-10) | No hit for `2026-07-28` in this checkout |
| Kotlin (`kotlin-sdk`) | `0.15.0` @ `76b8e7d` (2026-07-28) | No hit for `2026-07-28` in this checkout |
| PHP (`php-sdk`) | @ `9a6d24c` (2026-07-27) | No hit for `2026-07-28` in this checkout |
| Swift (`swift-sdk`) | `0.12.1` @ `a0ae212` (2026-04-29, oldest checkout of the ten) | No hit for `2026-07-28` in this checkout |
| MCP Inspector | `2.0.0-1-gfb1b0cb` @ `fb1b0cb` (2026-07-28) | Yes (built on the 2.0.0-era TS SDK) |

This is a shallow check — a grep for the literal string `2026-07-28` across each checkout, plus
(for TypeScript and Python) reading the actual protocol-version registry the SDK ships — not a
functional test against any of them, and not exhaustive per-feature parity (a "Yes" here says the
SDK's own source acknowledges the revision exists; it says nothing about which SEPs above it
actually implements). "No hit" is not proof of absence; it means this specific checkout, at this
specific commit, at this specific search, found nothing. Commands run, for reproducibility:

```bash
for d in ~/src/*-sdk; do
  grep -rl "2026-07-28" "$d" --include="*.md" --include="*.json" --include="*.py" \
    --include="*.ts" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" \
    --include="*.swift" --include="*.rb" --include="*.php" --include="*.cs" \
    | grep -v node_modules | grep -v /test/ | grep -v /tests/
done
```

### Known client-side hazard: `structuredContent` on an error result (THE-827)

This server attaches the structured error object as `structuredContent` alongside `isError: true`
(the SEP-1303 row above). That is deliberate, documented, and asserted by
`tool-surface-2025.test.ts`. **A strict client may nonetheless replace our error with its own.**

The TypeScript SDK this server depends on — `@modelcontextprotocol/sdk` **1.29.0**, the version
resolved in this repo — implements the `isError` exemption on only one of the two paths in
`dist/esm/client/index.js`:

```js
// :499  comment states the rule
// If tool has outputSchema, it MUST return structuredContent (unless it's an error)
// :500  presence check — correctly exempts errors
if (!result.structuredContent && !result.isError) { ... }
// :504  validation — the exemption is MISSING here
if (result.structuredContent) {
    const validationResult = validator(result.structuredContent);   // :507
    // throws McpError(InvalidParams) when the error object does not match the SUCCESS outputSchema
}
```

An error object never matches a tool's success `outputSchema`, so on a client that validates,
the caller receives `-32602 Structured content does not match the tool's output schema` **instead
of** the server's actual error. The error is not merely unreadable; it is replaced. Every one of
this server's registered tools declares an `outputSchema`, so no tool is exempt by construction.

The same SDK's *server* half (`dist/esm/server/mcp.js`, `validateToolOutput`) does short-circuit on
`result.isError`, so this is a half-implemented exemption rather than a deliberate design.
Upstream fix: [typescript-sdk#1945](https://github.com/modelcontextprotocol/typescript-sdk/pull/1945) —
open and unreleased when this was written (2026-08-14).

**Why the server does not work around it.** Dropping `structuredContent` from error results would
make this a client-side non-issue, and it was considered and rejected: it retracts a documented
SEP-1303 capability, deletes the conformance test that proves it, and there is **no spec text**
granting error results an exemption from "clients SHOULD validate structured results against this
schema" — so a validating client is arguably correct and the server is arguably the one at fault.
Trading a real capability for a workaround to someone else's half-applied exemption is the worse
of the two. Recorded here so that a downstream caller who sees `-32602` where they expected a
typed error can identify it in one read.

Scope, in this page's usual terms: verified by reading the 1.29.0 files vendored into this repo's
own `node_modules`, and by reading the upstream PR. **Not** verified against a live client, and
**not** confirmed either way for the 2.x SDK line — that checkout has a different layout and the
check was inconclusive, which is reported rather than guessed.

## What this page does not claim

- **No live client was probed for this page.** A live obsidian-tc instance is reachable on an
  internal tailnet for exactly this purpose, but that network is unreachable from the environment
  this page was written in — the attempt (`curl` to the metrics/MCP endpoints) failed to resolve
  the host, and this page does not pretend otherwise. Nothing here should be read as "tested
  against a live server"; every "suite" cell is an in-process HTTP round-trip the test itself
  starts and tears down.
- **No specific downstream client (Claude Desktop, Cursor, VS Code, Claude Code, an actual
  LiteLLM deployment, MCP Inspector run interactively) was connected to obsidian-tc for this
  page.** The one concrete production fact available — that LiteLLM pins `mcp` 1.28.1 and
  therefore speaks 2025-11-25 — is cited above because it is documented in this repo's own test
  suite as the reason legacy-era support is load-bearing, not because LiteLLM itself was
  re-verified here.
- **A client vendor's own documentation was not treated as evidence.** The instruction this page
  was written under is explicit about why: a client's docs describe that client's *intent*, not
  what obsidian-tc has been shown to do when talking to it.

## Re-running the evidence

Every "suite" cell above traces to a real, currently-passing test:

```bash
cd packages/server
node ./node_modules/vitest/vitest.mjs run \
  test/protocol-2026-conformance.test.ts \
  test/mcp-protocol-eras.test.ts \
  test/protocol-surface.test.ts \
  test/client-features.test.ts \
  test/mcp-tasks-wire.test.ts \
  test/task-augmented.test.ts \
  test/notifications-tasks.test.ts \
  test/subscriptions-listen.test.ts \
  test/hitl-multi-round-trip.test.ts \
  test/elicit-request-state.test.ts \
  test/schema-dialect.test.ts \
  test/tool-surface-2025.test.ts \
  test/http-rebinding-guard.test.ts \
  test/mcp-auth-prm.test.ts \
  test/http-caller-isolation.test.ts
```
