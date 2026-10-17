# Legacy-era shims

obsidian-tc serves two MCP protocol eras from one process: **2026-07-28** (modern) and
**2025-11-25** plus older (legacy). The legacy era stays because the LiteLLM gateway pins the
Python `mcp` package 1.28.1, whose ceiling is 2025-11-25 (`packages/server/src/mcp/server.ts`,
the `supportedProtocolVersions` comment).

Policy: new features are designed **modern-first** (see "Modern-first protocol code" in
`CONTRIBUTING.md`). Legacy-only code is a compatibility shim. Every such block is labelled with the
line `// legacy-era shim: see LEGACY_SHIMS.md` and listed below, so the whole era can be deleted in
one pass once the removal gates clear.

`node scripts/check-legacy-shims.mjs` (ledger entry `legacy-shim inventory`) fails when a source
file carries the marker and has no row here, or a row names a file with no marker. The marker
goes on the legacy-only lines themselves. Files that are mostly modern (`server.ts`,
`elicit-form.ts`) carry the marker only on their legacy blocks, not at the top of the file.

## Legacy-only code

Each row is one legacy-only block. The line is where its marker sits: above the block, or at the end of a one-line block.

| Location | What it does | Why it exists | Deleting it involves |
| --- | --- | --- | --- |
| `packages/server/src/mcp/elicit-shim-guard.ts:1` | `ShimGuardedServer` overrides `_wrapHandler` for `tools/call`. When the SDK's `LegacyInputRequiredShim` ends a call with its own "Fulfilling input required ... failed" result, it substitutes the `onConfirmLegFailure` refusal. It also applies `ensureTextContent` to every `tools/call` result. | The SDK shim sends `elicitation/create` itself on a 2025-era stdio connection, and a failed leg otherwise reaches the model with no approval reason. | Delete the file. Construct a plain `Server` at `server.ts:265`. Keep the `ensureTextContent` duty: move it onto the plain `tools/call` result path, because modern results need it too. |
| `packages/server/src/mcp/elicit-form.ts:53` | `hitlFormSource` returns the `form` label for every non-modern connection. | Telemetry label for the server-driven legacy round trip. | Return `request_state` unconditionally, or drop the function. |
| `packages/server/src/mcp/elicit-form.ts:79` | `roundTripDeliverable` also accepts `legacyElicitationShim === true`. | The legacy half of the fail-closed gate, for the stdio shim. | Drop the `legacyElicitationShim` parameter and the `||` term. Keep `negotiatedModern`. |
| `packages/server/src/mcp/elicit-form.ts:317` | `offerInputRequired` records each offer in `offeredErrors`. | Only the shim guard reads the record, to rebuild a refusal when a legacy leg fails. | Delete the `set` call with the map below. |
| `packages/server/src/mcp/elicit-form.ts:322` | `offeredErrors` WeakMap, plus `offeredElicitError` at line 327. | Lookup used only by `ShimGuardedServer`. | Delete both. |
| `packages/server/src/mcp/server.ts:201` | `McpServerOptions.legacyElicitationShim` (opt-in for the SDK shim). | Stdio-only switch. HTTP never sets it. | Delete the option, the `roundTripDeliverable` argument, and `runtime/server-runtime.ts:476`. |
| `packages/server/src/mcp/server.ts:266` | `new ShimGuardedServer(` in `createMcpServer`. | The guard class exists only for the shim (see its row above). | Replace with `new Server(`. |
| `packages/server/src/mcp/server.ts:316` | `inputRequired` options: `legacyShim` (always set explicitly) and `roundTimeoutMs` (the shim's per-leg timeout, capped to the codec TTL). | Configures the SDK legacy shim. | Delete both keys. Keep `requestState` verify and the modern `inputRequired` path. |
| `packages/server/src/mcp/server.ts:444` | `server.onConfirmLegFailure`, the refusal the guard substitutes. | Used only by `ShimGuardedServer`. | Delete with the guard. |
| `packages/server/src/mcp/server.ts:559` | `server.getClientVersion()` passed to `requestCallerMeta` as the `legacyClient` input. | Client identity from a legacy `initialize` handshake, when no per-request envelope exists. | Drop the argument and the `legacyClient` parameter in `request-meta.ts`. |
| `packages/server/src/mcp/facade-mode-resolver.ts:153` | `requestClientName` falls back to `server.getClientVersion()`. | Same legacy `initialize` identity fallback. | Drop the `??` term. |
| `packages/server/src/mcp/request-meta.ts:23` | Third fallback in `requestCallerMeta`, the `clientInfoFromFields(legacyClient)` term. | Same legacy `initialize` identity fallback. | Drop the term and the parameter. |
| `packages/server/src/transports/http.ts:501` | `createMcpHandler(..., { legacy: "stateless" })`. The SDK serves each legacy-era request through a stateless fallback. | Keeps 2025-11-25 clients served over Streamable HTTP. | Change to `{ legacy: "reject" }` (the SDK's strict mode), then delete the option once the legacy versions are gone. |
| `packages/server/src/hitl-telemetry.ts:25` | `HITL_SOURCES` includes `form`. | Label written by the legacy round trip. | Remove `form` from the list. Keep reading old rows that carry it. |
| `packages/server/src/runtime/server-runtime.ts:476` | `legacyElicitationShim: true` for the stdio server. | Turns the SDK shim on for stdio. | Delete the line (see `server.ts:201`). |

## Dual-era, not a shim

These serve both eras or serve modern traffic. They are **not** deleted by the removal, but some
of them mention or branch on the legacy era, so the removal PR must read each one.

| Location | Why it is dual-era |
| --- | --- |
| `packages/server/src/mcp/server.ts:183` | `era?: "legacy" \| "modern"` on `McpServerOptions`. Both eras go through it. Removal makes the default modern. |
| `packages/server/src/mcp/server.ts:10`, `:306`, `:364` | `SUPPORTED_PROTOCOL_VERSIONS` spread into `supportedProtocolVersions` and `server/discover`. The spread holds the legacy list, so removal drops it. |
| `packages/server/src/mcp/server.ts:148` | `visibility` option. Feeds the static `initialize` instructions (legacy) and triad `tools/list` (both eras). |
| `packages/server/src/mcp/server.ts:336-339` | `withCacheHint` adds cache fields only when `isModern`. Modern-only output, no legacy branch to delete. |
| `packages/server/src/mcp/server.ts:522`, `:530` | Call sites of `roundTripDeliverable` and `hitlFormSource`. Both eras; update when the arguments change. |
| `packages/server/src/mcp/elicit-form.ts:1-22`, `:44-47` | Module comment that explains the shim (delete with it), and `negotiatedModern`, the native modern gate (keep). |
| `packages/server/src/mcp/registry/types.ts:79` | `source: "form" \| "request_state"`. Shares the `form` label with `hitl-telemetry.ts`. |
| `packages/server/src/elicit-request-state.ts:60-83` | The codec (`ttlSeconds`) serves the modern `requestState` echo. Its doc comment mentions the shim. Keep the codec. |
| `packages/server/src/mcp/error-rendering.ts:95-130` | Text channel for `elicit_required` on any client that cannot run the round trip. Not legacy-specific. |
| `packages/server/src/mcp/client-info.ts:85-92` | `clientInfoFromFields`. Also bounds modern envelope identity. Keep. |
| `packages/server/src/mcp/client-features.ts:10-22` | `logging: {}` capability, and the SDK-registered `logging/setLevel` (legacy only). Removal is a separate decision. |
| `packages/server/src/transports/http.ts:495` | `era: mcpCtx.era` pass-through from the SDK. Keep. |
| `packages/server/src/transports/http.ts:664`, `:689` | Modern-only interception of the Tasks and advisory extensions. Modern features, keep. |
| `packages/server/src/transports/anonymous-discovery.ts:150` | Modern-only header check. Keep. |
| `packages/server/src/mcp/tasks.ts:170` | `MODERN_PROTOCOL_VERSION`. Keep. |

## Tests and fixtures

Deleted with the shim:

- `packages/server/test/hitl-legacy-shim-construction.test.ts`
- `packages/server/test/hitl-legacy-shim-elicitation.test.ts`

Updated (they set `legacyElicitationShim: true` as a fixture, or cover the legacy era):

- `packages/server/test/elicit-cancel-not-decline.test.ts:114`
- `packages/server/test/hitl-telemetry.test.ts:113`
- `packages/server/test/rr-hitl-telemetry.test.ts:103`
- `packages/server/test/rr-hitl-active-file.test.ts:138`
- `packages/server/test/effective-vault-followups.test.ts:93`
- `packages/server/test/mcp-protocol-eras.test.ts`
- `packages/server/test/mcp-client-compat-matrix.test.ts`
- `packages/server/test/response-format-resources.test.ts` (its `era: "legacy"` helper)

## Docs that describe the dual era

- `docs/MCP-COMPATIBILITY.md:25` and `:180` (the dual-era description and the `ShimGuardedServer` note)
- `docs/src/content/docs/security/hitl-elicit.md:124` (stdio-only legacy shim)
- `docs/design/mcp-dispatch-and-transport.md:134` (both wire codecs served from one server)
- `packages/server/src/mcp/server.ts` comment block above the `supportedProtocolVersions` line (`:306`, the legacy-version rationale)

## Removal gates

The legacy era is deleted only when all three gates hold:

- **(A)** The gateway hop negotiates 2026-07-28, or the gateway is retired. Today it pins `mcp`
  1.28.1 (ceiling 2025-11-25).
- **(B)** Claude Code over stdio negotiates 2026-07-28.
- **(C)** Every client the owner uses is on 2026-07-28.

## One-PR removal steps

1. Drop 2025-11-25 and older from `supportedProtocolVersions` (`server.ts:306`) and from
   `server/discover` (`server.ts:364`). Set `createMcpHandler` to `legacy: "reject"`.
2. Delete every row in "Legacy-only code". Move the `ensureTextContent` duty onto the plain
   `tools/call` result path first.
3. Delete the two shim test files and update the fixtures listed above.
4. Remove the dual-era language from the docs and the `server.ts` comments listed above.
5. Bump the major version (`package.json`, `manifest.json`, `server.json`, and the `CHANGELOG`
   fragment, type `Removed`). Update the table in `SECURITY.md` ("Supported versions").
6. Delete this file and `scripts/check-legacy-shims.mjs` with its ledger entry. The check fails
   on an empty inventory by design, so it must go in the same commit as the last row.

## Not in scope

`packages/plugin/legacy/` is the Obsidian plugin's own legacy directory, not a protocol path.
`CHANGELOG.md` history mentions the shim and stays as written.
