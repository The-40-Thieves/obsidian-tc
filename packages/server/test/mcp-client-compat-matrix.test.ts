// THE-725 — the MCP-client compatibility matrix, as DATA, driving assertions through the real
// negotiation code rather than reimplementing it.
//
// This server is mid-migration across two live spec revisions (THE-583): 2025-11-25 (the
// "legacy" era — `initialize`/`initialized` handshake, per-connection sessions) and 2026-07-28
// (the "modern" era — SEP-2575's stateless per-request envelope, `server/discover` in place of
// the handshake). `mcp-protocol-eras.test.ts` and `protocol-2026-conformance.test.ts` already
// pin large parts of that wire behavior feature-by-feature; this file exists to answer a
// DIFFERENT question — "for each (spec revision, feature) cell, what does the server actually
// do, and is that asserted from code or does it need a live client to confirm?" — as one table,
// so the answer to "is this cell covered" is a lookup rather than a memory.
//
// MATRIX is the single source of truth. Every "asserted-from-code" cell below is required to have
// a passing assertion wired to it (the coverage test at the bottom fails loudly if one is added to
// MATRIX without a corresponding `assert`, or vice versa) — the table cannot silently drift from
// what actually runs. `docs/MCP-CLIENT-COMPAT-MATRIX.md` carries the human-readable form of this
// same table; keep them in sync by hand (the doc cites this file as its evidence).
//
// The two axes named by the ticket:
//   * client identity — 2025-11-25 `_meta` passthrough vs 2026-07-28 SEP-2575 (`client-info.ts`)
//   * the three deprecated-but-served server->client features — Logging (`logging/setLevel`),
//     Roots, Sampling (SEP-2577, `client-features.ts`) — plus `server/discover` itself, the
//     2026-07-28 handshake replacement.
import { Server } from "@modelcontextprotocol/server";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { clientRoots, clientSupportsSampling, sampleViaClient } from "../src/mcp/client-features";
import { extractClientInfo } from "../src/mcp/client-info";
import type { ToolDefinition } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";

type Revision = typeof LEGACY | typeof MODERN;
type Feature = "client-identity" | "logging/setLevel" | "roots" | "sampling" | "server/discover";
type Provenance = "asserted-from-code" | "needs-live-client-verify";

interface MatrixCell {
  revision: Revision;
  feature: Feature;
  /** What the server actually does — the doc's prose for this cell, verbatim. */
  expectation: string;
  provenance: Provenance;
  /** Present iff provenance === "asserted-from-code". Drives the real negotiation code. */
  assert?: () => Promise<void> | void;
}

/**
 * Probe tool: echoes back exactly what THE-627/SEP-2577 wiring put on the CallerContext, so a
 * test can observe `ctx.clientInfo` / `ctx.roots` / `ctx.sample` through the REAL server.ts
 * request-handler code path (lines building `ctx` in `tools/call`) instead of re-deriving what
 * should be there.
 */
const ECHO_TOOL: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "echo_caller_context",
  domain: "admin",
  description: "test-only: reports what THE-627/SEP-2577 wiring attached to this call's context",
  inputSchema: z.object({}).strict(),
  requiredScopes: [],
  handler: async (_input, ctx) => ({
    client_name: ctx.clientInfo?.name ?? null,
    client_version: ctx.clientInfo?.version ?? null,
    has_roots: typeof ctx.roots === "function",
    roots: (await ctx.roots?.()) ?? null,
    has_sample: typeof ctx.sample === "function",
  }),
};

async function boot() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({
      version: "0.0.0-test",
      vaults: ["v1"],
      startedAt: Date.now(),
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  registry.register(ECHO_TOOL);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "none" },
  }).auth;
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
}

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = line ? line.slice(6) : text;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const legacy = (port: number, body: unknown) =>
  post(port, body, { "mcp-protocol-version": LEGACY });

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "matrix-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { roots: {}, sampling: {} },
};

const modern = (
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
) =>
  post(
    port,
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } },
    { "mcp-protocol-version": MODERN, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
  );

/** A server whose client capabilities are forced — the pattern client-features.test.ts uses to
 *  exercise the CAPABILITY-GATING logic in isolation from era/transport plumbing. */
function serverWithCaps(caps: unknown): Server {
  const s = new Server({ name: "t", version: "0" }, { capabilities: { logging: {} } });
  (s as unknown as { getClientCapabilities: () => unknown }).getClientCapabilities = () => caps;
  return s;
}

const MATRIX: MatrixCell[] = [
  // --- client identity -----------------------------------------------------------------------
  //
  // FINDING (this ticket): the header comment on client-info.ts claims client identity is read
  // from per-request `_meta`, "same code path in both eras". That is true of `extractClientInfo`
  // in ISOLATION (client-info.test.ts proves it against a hand-built `_meta` bag) — but it is NOT
  // what happens on the real wire, in EITHER era, on the SDK version this repo pins (2.0.0).
  //
  // `io.modelcontextprotocol/clientInfo` is one of four keys `@modelcontextprotocol/server`
  // treats as RESERVED per-request envelope material (`RESERVED_ENVELOPE_META_KEYS` —
  // protocolVersion, clientInfo, clientCapabilities, logLevel; `dist/src-*.cjs`,
  // `liftWireOnlyMaterial`). The SDK LIFTS these out of inbound `_meta` before ANY registered
  // handler runs — "on every message", not just modern ones — and surfaces them instead at
  // `ctx.mcpReq.envelope`. So `req.params._meta` never carries this key by the time server.ts's
  // `tools/call` handler reads it: `extractClientInfo(req.params._meta)` calls a real, tested
  // function on an argument that is now `undefined` in both eras, not a stale-in-one-era gap.
  //
  // Caught by watching this exact cell FAIL first: an earlier draft asserted a captured name/
  // version and got `null`/`null` back in both eras. `client-info.test.ts`'s round-trip tests
  // never caught this because they call `insertSession`/`extractClientInfo` directly, never
  // through a real `tools/call` request — this is the first test in the repo to drive THE-627
  // client-identity capture end to end over HTTP. Recorded here rather than silently fixed:
  // fixing it (reading `ctx.mcpReq.envelope` instead) is a behavior change to production code,
  // outside a docs+tests ticket's scope.
  {
    revision: LEGACY,
    feature: "client-identity",
    expectation:
      "server.ts reads client identity from `req.params._meta` via `extractClientInfo` — but the " +
      "SDK reserves `io.modelcontextprotocol/clientInfo` as envelope material and lifts it out of " +
      "`params._meta` before the handler runs, on EVERY message regardless of era (see the FINDING " +
      "comment above `MATRIX`). So a legacy client's declared identity NEVER reaches this code path " +
      "today: `ctx.clientInfo` is always absent, even though the client sent the key correctly.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await legacy(h.port, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "echo_caller_context",
            arguments: {},
            _meta: { "io.modelcontextprotocol/clientInfo": { name: "litellm-sim", version: "9" } },
          },
        });
        expect(r.status).toBe(200);
        const structured = r.json.result.structuredContent;
        // Not "unrecognized" (that would read as a bug in extractClientInfo itself) — genuinely
        // absent by the time the handler runs. See the FINDING comment above MATRIX.
        expect(structured.client_name).toBeNull();
        expect(structured.client_version).toBeNull();
      } finally {
        await h.close();
      }
    },
  },
  {
    revision: MODERN,
    feature: "client-identity",
    expectation:
      "same reservation applies under 2026-07-28 — the SDK's own comment on the lift function " +
      "says 'reserved on every message', not 'reserved on modern messages'. A modern client's " +
      "`_meta.io.modelcontextprotocol/clientInfo` is lifted to `ctx.mcpReq.envelope` before " +
      "server.ts's handler runs, so `ctx.clientInfo` is absent here too, identically to legacy.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await modern(
          h.port,
          "tools/call",
          { name: "echo_caller_context", arguments: {} },
          "echo_caller_context",
        );
        expect(r.status).toBe(200);
        const structured = r.json.result.structuredContent;
        expect(structured.client_name).toBeNull();
        expect(structured.client_version).toBeNull();
      } finally {
        await h.close();
      }
    },
  },

  // --- logging/setLevel ------------------------------------------------------------------------
  //
  // FINDING (this ticket): client-features.ts's header comment states `logging/setLevel` "is not
  // a routable method in SDK v2 (absent from both wire registries; a handler registered for it
  // answers -32601, measured)". That is true under MODERN (protocol-2026-conformance.test.ts
  // proves it — the method is REMOVED by SEP-2575 and the modern route refuses it by name before
  // any Server handler runs). It does NOT hold under LEGACY on this SDK version: because
  // server.ts declares the `logging: {}` capability, `Server`'s constructor auto-registers ITS
  // OWN built-in `logging/setLevel` handler (`_registerLoggingHandler`, `dist/mcp-*.cjs`) —
  // unconditionally, regardless of era — which stores a level keyed by `transportSessionId` and
  // returns `{}`. Under legacy, that built-in handler is reachable (nothing pre-filters the
  // method the way the modern route does), so the call SUCCEEDS rather than answering -32601.
  // The stored level is inert either way — this transport is stateless, so the keyed session
  // never comes back for a second request — but "succeeds and is silently ignored" and "answers
  // -32601" are a materially different client-facing contract, and only one of them is what a
  // legacy client actually observes today.
  {
    revision: LEGACY,
    feature: "logging/setLevel",
    expectation:
      "SUCCEEDS with an empty result, contrary to client-features.ts's header comment (see the " +
      "FINDING note above): declaring the `logging: {}` capability makes the SDK auto-register " +
      "its own built-in `logging/setLevel` handler, reachable under legacy because nothing " +
      "pre-filters the method the way the modern route's spec-registry check does. The level it " +
      "stores is inert on this stateless transport (nothing ever reads it back), but the call " +
      "itself does not error.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await legacy(h.port, {
          jsonrpc: "2.0",
          id: 1,
          method: "logging/setLevel",
          params: { level: "debug" },
        });
        expect(r.json.error).toBeUndefined();
        expect(r.json.result).toEqual({});
      } finally {
        await h.close();
      }
    },
  },
  {
    revision: MODERN,
    feature: "logging/setLevel",
    expectation:
      "the 2026-07-28 spec removed this method outright (SEP-2575 made verbosity a per-request " +
      "`_meta` field), and it stays unroutable in the SDK for the same reason as legacy — refused, " +
      "not silently accepted.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await modern(h.port, "logging/setLevel", { level: "debug" });
        expect(r.json.result).toBeUndefined();
        expect(r.json.error).toBeDefined();
      } finally {
        await h.close();
      }
    },
  },

  // --- roots -------------------------------------------------------------------------------------
  {
    revision: LEGACY,
    feature: "roots",
    expectation:
      "the GATING LOGIC (clientRoots) is capability-gated and identical across eras — but under " +
      "this server's STATELESS HTTP transport, `createMcpServer` is invoked fresh per HTTP request " +
      "(THE-583), and the SDK backfills `getClientCapabilities()` from the per-request envelope " +
      "ONLY on the modern era. A legacy `tools/call` never re-runs `initialize` on that same fresh " +
      "Server instance, so `_clientCapabilities` is never populated: a legacy client's roots " +
      "capability, declared once at `initialize`, cannot reach any later `tools/call` at all. " +
      "`ctx.roots` is still exposed (it always is — SEP-2577), but calling it always resolves " +
      "`undefined` on this transport under legacy, regardless of what the client declared.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await legacy(h.port, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo_caller_context", arguments: {} },
        });
        expect(r.status).toBe(200);
        const structured = r.json.result.structuredContent;
        expect(structured.has_roots).toBe(true);
        // The point: even though nothing in this request DECLARED roots, has_roots is always
        // true (SEP-2577 exposes the accessor unconditionally) — what proves the asymmetry is
        // that CALLING it resolves undefined, because there is no capability to gate on.
        expect(structured.roots).toBeNull();
      } finally {
        await h.close();
      }
    },
  },
  {
    revision: MODERN,
    feature: "roots",
    expectation:
      "the per-request `_meta.clientCapabilities` backfills `getClientCapabilities()` on THIS " +
      "request (SDK-internal `seedClientIdentityFromEnvelope`, called only on the modern route), " +
      "so a client that declares `roots` on the call reaches the GATE correctly — proven " +
      "code-side by the `sampling` row below, which exercises the identical gate/backfill " +
      "mechanism through a boolean (`clientSupportsSampling`) that needs no live client to read. " +
      "Whether the follow-on `listRoots()` round trip actually returns a real client's roots is a " +
      "SEPARATE claim this repo cannot check itself: this harness has no live bidirectional MCP " +
      "client to answer that request, so `clientRoots`'s try/catch converts the failed round trip " +
      "to `undefined` — observationally identical to the legacy no-capability case above, for a " +
      "completely different reason. That leg needs a real client.",
    provenance: "needs-live-client-verify",
  },

  // --- sampling ------------------------------------------------------------------------------
  {
    revision: LEGACY,
    feature: "sampling",
    expectation:
      "same stateless-transport asymmetry as roots: `clientSupportsSampling` reads " +
      "`getClientCapabilities()` off the fresh per-request Server, which a legacy `tools/call` " +
      "never populates, so `ctx.sample` is never attached to a legacy caller's context at all — " +
      "not merely ungated, ABSENT.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await legacy(h.port, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo_caller_context", arguments: {} },
        });
        expect(r.status).toBe(200);
        expect(r.json.result.structuredContent.has_sample).toBe(false);
      } finally {
        await h.close();
      }
    },
  },
  {
    revision: MODERN,
    feature: "sampling",
    expectation:
      "the per-request envelope backfill applies here too: a modern client that declares " +
      "`sampling` in `_meta.clientCapabilities` on the SAME call gets `ctx.sample` attached.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await modern(
          h.port,
          "tools/call",
          { name: "echo_caller_context", arguments: {} },
          "echo_caller_context",
        );
        expect(r.status).toBe(200);
        expect(r.json.result.structuredContent.has_sample).toBe(true);
      } finally {
        await h.close();
      }
    },
  },

  // --- server/discover -------------------------------------------------------------------------
  {
    revision: LEGACY,
    feature: "server/discover",
    expectation:
      "not a 2025-11-25 method at all — `createMcpHandler` validates an inbound method against the " +
      "spec registry for the era the request declared and refuses anything outside it (-32601), " +
      "the same mechanism that keeps a Tasks-extension handler unreachable without going through " +
      "the transport's own front door.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await legacy(h.port, { jsonrpc: "2.0", id: 1, method: "server/discover" });
        expect(r.json.result).toBeUndefined();
        expect(r.json.error).toBeDefined();
      } finally {
        await h.close();
      }
    },
  },
  {
    revision: MODERN,
    feature: "server/discover",
    expectation:
      "REPLACES the removed initialize/initialized handshake (SEP-2575) and is the mandatory way a " +
      "modern client learns supported versions + capabilities; server.ts registers the handler " +
      "unconditionally and it is reachable because createMcpHandler classifies the era per request.",
    provenance: "asserted-from-code",
    assert: async () => {
      const h = await boot();
      try {
        const r = await modern(h.port, "server/discover");
        expect(r.status).toBe(200);
        expect(r.json.error).toBeUndefined();
        expect(r.json.result.supportedVersions).toContain(MODERN);
      } finally {
        await h.close();
      }
    },
  },
];

/** Every cell the matrix declares "asserted-from-code" must actually run — and only those cells. */
const executed = new Set<string>();
const cellKey = (c: Pick<MatrixCell, "revision" | "feature">) => `${c.revision}::${c.feature}`;

describe("THE-725 — MCP-client compatibility matrix (spec revision x feature)", () => {
  for (const cell of MATRIX) {
    it(`${cell.revision} / ${cell.feature} — ${cell.expectation.slice(0, 88)}...`, async () => {
      if (cell.provenance === "needs-live-client-verify") {
        // Documented expectation only — this repo has no live third-party MCP client to connect,
        // so this cell is NOT faked with a stand-in assertion. The test still exists (so the
        // matrix's own coverage check below sees it), and it asserts the one honest thing
        // available: that the cell is tagged correctly and carries no `assert`, i.e. nobody
        // smuggled a fabricated pass in under this tag.
        expect(cell.assert).toBeUndefined();
        return;
      }
      expect(cell.assert).toBeTypeOf("function");
      await cell.assert?.();
      executed.add(cellKey(cell));
    }, 20_000);
  }

  it("every asserted-from-code cell actually ran its assertion — the matrix cannot silently drift", () => {
    const expected = MATRIX.filter((c) => c.provenance === "asserted-from-code").map(cellKey);
    expect(expected.length).toBeGreaterThan(0);
    for (const key of expected) {
      expect(executed.has(key)).toBe(true);
    }
  });

  it("covers all 5 features across both revisions — the axes the ticket named", () => {
    const revisions = new Set(MATRIX.map((c) => c.revision));
    const features = new Set(MATRIX.map((c) => c.feature));
    expect([...revisions].sort()).toEqual([LEGACY, MODERN].sort());
    expect([...features].sort()).toEqual(
      ["client-identity", "logging/setLevel", "roots", "sampling", "server/discover"].sort(),
    );
    expect(MATRIX.length).toBe(revisions.size * features.size);
  });
});

// --- unit-level confirmation of the negotiation primitives themselves -------------------------
//
// The wire-level matrix above proves what the SERVER does end-to-end; these confirm the two
// underlying primitives (extractClientInfo, the client-features gates) are what the wire test
// actually exercises, isolated from HTTP/era plumbing — the same style client-info.test.ts and
// client-features.test.ts already use, kept here so a reader of THE MATRIX can jump straight to
// the function under test without leaving this file.
describe("negotiation primitives the matrix above drives", () => {
  it("extractClientInfo is the SAME function for both eras (client-identity row)", () => {
    const meta = { "io.modelcontextprotocol/clientInfo": { name: "x", version: "1" } };
    expect(extractClientInfo(meta)).toEqual({ name: "x", version: "1" });
  });

  it("clientRoots/clientSupportsSampling gate on getClientCapabilities(), whatever populates it", async () => {
    // Confirms the GATE itself does not know or care about era — only WHETHER capabilities are
    // undefined does, and that is decided upstream by the stateless-transport backfill asserted
    // in the wire cells above.
    expect(clientSupportsSampling(serverWithCaps(undefined))).toBe(false);
    expect(clientSupportsSampling(serverWithCaps({ sampling: {} }))).toBe(true);
    await expect(clientRoots(serverWithCaps(undefined))).resolves.toBeUndefined();
    await expect(
      sampleViaClient(serverWithCaps(undefined), { messages: [], maxTokens: 1 }),
    ).resolves.toBeUndefined();
  });
});
