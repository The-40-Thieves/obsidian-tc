# MCP-client compatibility matrix (THE-725)

This page is a narrower, code-focused companion to
[`MCP-COMPATIBILITY.md`](./MCP-COMPATIBILITY.md) (the full THE-510/THE-583 protocol-conformance
matrix) and to
[`mcp-clients.md`](./src/content/docs/getting-started/mcp-clients.md) (live client-to-server
observations). Where those two ask "what does the server do on the wire, broadly" and "what has a
real client been observed doing against this server," this page asks a narrower question the
server's own negotiation code is mid-migration on: for the **client-identity** surface
(`client-info.ts`) and the three **deprecated-but-served server→client features**
(`client-features.ts` — Logging, Roots, Sampling, SEP-2577) plus `server/discover` itself, what
does the server ACTUALLY do, **per spec revision**, and is that read from code or does it need a
live client to confirm?

**Ground rule, same as `MCP-COMPATIBILITY.md`: nothing below is asserted without evidence.** Every
row cites either the behavioral test that proves it
(`packages/server/test/mcp-client-compat-matrix.test.ts`, table-driven — the doc and the test share
one `MATRIX` array, kept in sync by hand) or is tagged `needs-live-client-verify` and left
unasserted rather than guessed at.

## Evidence key

- **asserted from code** — proven by a passing assertion in
  `mcp-client-compat-matrix.test.ts`, driven through the server's real negotiation code
  (`extractClientInfo`, `clientRoots`, `clientSupportsSampling`, the real HTTP transport via
  `startHttp`) — not a reimplementation of that logic. Re-run: `cd packages/server && node
  ./node_modules/vitest/vitest.mjs run test/mcp-client-compat-matrix.test.ts`.
- **needs live-client verify** — the claim can only be settled by a real, live, bidirectional MCP
  client. This repo's own test harness has no such client (the same limitation
  `MCP-COMPATIBILITY.md` and `mcp-clients.md` name for their own unfilled cells), so the cell is
  left as a documented expectation and not faked with a stand-in assertion.

## Two findings this ticket surfaced

Building the matrix meant watching each cell's test FAIL first against an initial (spec-derived)
expectation, then reading why. Two of those failures turned out not to be test bugs — they are gaps
between what this repo's own code comments claim and what `@modelcontextprotocol/server@2.0.0`
(the pinned SDK) actually does on the wire. Recorded here rather than silently patched: fixing
either is a behavior change to production code, outside a docs+tests ticket's scope.

### 1. Client identity (THE-627) never reaches a real request, in EITHER era

`client-info.ts`'s header comment says client identity is read from per-request `_meta`, "same
[code path] under BOTH specs." That is true of `extractClientInfo` in isolation
(`client-info.test.ts` proves it against a hand-built `_meta` object) — but `_meta` is not what the
handler actually receives once a request has gone through the SDK.

`@modelcontextprotocol/server` treats `io.modelcontextprotocol/clientInfo` as one of four
**reserved per-request envelope keys** (`RESERVED_ENVELOPE_META_KEYS` — protocolVersion,
clientInfo, clientCapabilities, logLevel; see `liftWireOnlyMaterial` in the SDK's own dist source).
Its own comment on that function is explicit: the reserved keys are lifted out of inbound `_meta`
**"before handlers run,"** surfaced instead at `ctx.mcpReq.envelope` — and the comment says
this is reserved **"on every message,"** not "on modern messages only." `server.ts`'s `tools/call`
handler reads `req.params._meta` directly (`extractClientInfo(req.params._meta)`), which by the
time the handler runs has had the `clientInfo` key stripped out from under it — in both
2025-11-25 and 2026-07-28.

Net effect: a real client that correctly sends its identity per THE-627's own design gets it
silently discarded before `ctx.clientInfo` is ever set, in both eras, today. `client-info.test.ts`'s
round-trip tests never caught this because they call `extractClientInfo`/`insertSession` directly —
`mcp-client-compat-matrix.test.ts` is the first test in this repo to drive THE-627 identity capture
through a real `tools/call` request.

**This looks like a real defect and probably warrants its own ticket** (read `ctx.mcpReq.envelope`
instead of `req.params._meta`, or equivalent) — filing/fixing it is out of scope here.

### 2. `logging/setLevel` succeeds under legacy, contrary to `client-features.ts`'s own comment

`client-features.ts` states the method "is not a routable method in SDK v2 (absent from both wire
registries; a handler registered for it answers -32601, measured)." True under **2026-07-28**
(`protocol-2026-conformance.test.ts` proves it — the method is removed by SEP-2575 and refused by
name before any `Server` handler runs). **Not** true under **2025-11-25** on this SDK version:
because `server.ts` declares the `logging: {}` capability, the SDK's `Server` constructor
auto-registers its own built-in `logging/setLevel` handler (`_registerLoggingHandler`) —
unconditionally, regardless of era. Under legacy, nothing pre-filters the method the way the
modern route's spec-registry check does, so that built-in handler is reachable, stores a level
keyed by `transportSessionId`, and returns `{}` — a success, not a `-32601`. The stored level is
inert (this transport is stateless — the same session key never comes back), but "succeeds and is
silently ignored" and "answers -32601" are a materially different contract for a legacy caller.

## The matrix

| Feature | 2025-11-25 (legacy) | 2026-07-28 (modern) | Provenance |
|---|---|---|---|
| **Client identity** (`_meta.io.modelcontextprotocol/clientInfo`) — client-info.ts | Sent correctly by the client, but silently discarded before the handler runs (Finding 1 above) — `ctx.clientInfo` is always absent | Same discarding, same reason — the SDK's reservation is era-independent | asserted from code |
| **`logging/setLevel`** | **Succeeds** with `{}` via the SDK's own built-in handler (Finding 2 above) — the declared level is stored but never consulted on this stateless transport | Refused (SEP-2575 removed the method; the modern route rejects it by name before any `Server` handler runs) | asserted from code |
| **`roots`** (SEP-2577, deprecated-but-served) | `ctx.roots` is unconditionally exposed on every call, but resolves `undefined`: `createMcpServer` runs fresh per HTTP request (THE-583), and this server's stateless legacy route never backfills `getClientCapabilities()` from a prior `initialize` — there is no per-connection state to backfill FROM | `ctx.roots` exposed the same way; the CAPABILITY GATE is proven backfilled correctly per request (`seedClientIdentityFromEnvelope`, SDK-internal) by the `sampling` row below, which shares the identical gate/backfill mechanism through a boolean check that needs no live client. Whether the follow-on `listRoots()` round trip returns a REAL client's roots is a separate claim this harness cannot check — it has no live bidirectional MCP client to answer that request | legacy: asserted from code; modern round trip: **needs live-client verify** |
| **`sampling`** (SEP-2577, deprecated-but-served) | `ctx.sample` is **absent** from the context entirely (not merely ungated) — same stateless-transport reason as `roots`: the capability never reaches `getClientCapabilities()` | `ctx.sample` is **attached** when the client declares `sampling` in `_meta.clientCapabilities` on that same call — the per-request backfill works, provable without a live client because this is a pure gate check (no RPC round trip needed to observe the boolean) | asserted from code |
| **`server/discover`** (SEP-2575 handshake replacement) | Refused — not a 2025-11-25 method; `createMcpHandler` checks the inbound method against the era's own spec registry and answers `-32601` before any `Server` handler is consulted | Works — the mandatory way a modern client learns supported versions + capabilities; reachable because `createMcpHandler` classifies the era per request (an earlier hand-wired Server+transport left it unreachable even when registered) | asserted from code |

## Known MCP client versions (external, sourced 2026-08-20)

The rows above are about what **this server** does; this table is about what the wider MCP client
ecosystem is known to speak, gathered via `context7`/web search rather than by connecting a live
client to obsidian-tc (that would be a `mcp-clients.md` update, not this page's job). Every claim
below names its source; none is treated as ground truth for what obsidian-tc has actually shown
working — `mcp-clients.md`'s own first-party rows outrank this table wherever they overlap.

| Client | Protocol ceiling (as sourced) | Source | Provenance |
|---|---|---|---|
| **Claude Code** (1.20.0) | Negotiates **2025-11-25** against a real obsidian-tc instance | `mcp-clients.md` — first-party, measured directly against this server (re-verified 2026-08-07) | asserted (first-party) |
| Claude Code (generic) | Self-reports `2025-06-18` in its `clientInfo`/initialize payload | [canimcp.dev/client/claude-code](https://canimcp.dev/client/claude-code/) — third-party crawl, snapshot date unclear, disagrees with the first-party row above (a client's self-reported default is not the same claim as a negotiated ceiling against a specific server) | needs-live-client-verify (discrepancy noted, not resolved) |
| Cursor | Self-reports `2025-06-18`; "Stateless requests & per-request negotiation," "Server discovery," and "Multi round-trip requests" are marked unknown/unverified by the source | [canimcp.dev/client/cursor-vscode](https://canimcp.dev/client/cursor-vscode/) | needs-live-client-verify |
| Continue (CLI client) | Tracked at only ~6% feature coverage by the source; no protocol-version string surfaced by this pass | [canimcp.dev](https://canimcp.dev/) (client index; the per-client page returned 404 at fetch time) | needs-live-client-verify |
| Claude Desktop | Not tracked by the source consulted | — (no source found this pass) | needs-live-client-verify |
| Official Python `mcp` SDK, `1.28.1` | Ceiling **2025-11-25** — the v1.x line speaks the pre-stateless spec; `pip install mcp` now defaults to the 2.x (`2026-07-28`-capable) line, so `mcp>=1.28,<2` is what pins a deployment to the older ceiling | `packages/server/src/mcp/server.ts`'s own comment (THE-583, verified directly against this SDK: "negotiated 2025-11-25, listed tools, called one") + [PyPI `mcp` release history](https://pypi.org/project/mcp/2.0.0a1/) | asserted from code (this repo) + third-party corroboration |
| LiteLLM (the gateway in front of obsidian-tc's own production deployment) | Pins the Python `mcp` package at **1.28.1** → ceiling 2025-11-25; LiteLLM's own MCP protocol version independently reports **2025-11-25** as of `v1.80.18` | `CLAUDE.md`/this repo's own deployment notes (the `1.28.1` pin) + [LiteLLM MCP docs](https://docs.litellm.ai/docs/mcp) | asserted from code (this repo's pin) + third-party corroboration (LiteLLM's own docs) |

**Why this table stays this thin.** `verify-ticket-premise` discipline applies here too: a
compatibility claim about a client this repo has not connected to is worth exactly what its source
is worth, and a generic crawler's snapshot of a client's *default* `clientInfo.protocolVersion`
field is not the same claim as "this is the highest revision the client will actually negotiate
against a given server" — a client may request an old default and still accept a server's newer
offer, or vice versa, which is exactly the ambiguity behind the Claude Code discrepancy row above.
None of the `needs-live-client-verify` rows here should be read as "unsupported."

## Re-running the evidence

```bash
cd packages/server
node ./node_modules/vitest/vitest.mjs run test/mcp-client-compat-matrix.test.ts
```

Every `asserted from code` cell above traces to one `it()` in that file, keyed off the same
`MATRIX` array this page's table mirrors by hand. The file's own coverage test
(`"every asserted-from-code cell actually ran its assertion"`) fails if a cell is added to the data
without a matching assertion wired up, or vice versa — the table and the test cannot drift apart
without a red CI run.

## See also

- [`MCP-COMPATIBILITY.md`](./MCP-COMPATIBILITY.md) — the full THE-510/THE-583 protocol-conformance
  matrix (sessions, cache hints, Tasks, HITL, schema dialect, and more) — broader, less code-level.
- [`mcp-clients.md`](./src/content/docs/getting-started/mcp-clients.md) — live, first-party
  observations of real clients (currently: Claude Code) connecting to a running obsidian-tc
  instance over stdio and Streamable HTTP.
