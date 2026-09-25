// THE-1106 fix round 2 (LOW 2, cross-vendor review): the "legacy HTTP is stdio-only" behavioural
// test in hitl-legacy-shim-elicitation.test.ts proves less than it looks like it does — stateless
// legacy HTTP has no client capabilities either way (no real `initialize` handshake ever runs on
// that ephemeral Server instance), so `canElicit` alone already fails the gate regardless of what
// `legacyShim` was passed to the `Server` constructor; the behavioural test would pass unchanged
// even with the explicit `legacyShim` assertion removed entirely. This file asserts the ACTUAL
// construction-time fact directly: `createMcpServer` passes `{ legacyShim: false }` to the SDK's
// `Server` constructor for every server built WITHOUT `legacyElicitationShim: true` (http.ts's
// shape) and `{ legacyShim: true }` for one built WITH it (stdio's shape) — by wrapping the real
// `Server` class and capturing its constructor's second argument, since `_inputRequiredServing` is
// a private field with no public accessor (the same reason `LEGACY_SHIM_ASSERTED_EXPLICIT` was
// deleted from mcp/elicit-form.ts as a no-op constant that checked nothing).
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { createElicitCodec } from "../src/elicit-request-state";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...actual,
    Server: class extends actual.Server {
      constructor(info: ConstructorParameters<typeof actual.Server>[0], options: unknown) {
        capturedOptions.push(options as Record<string, unknown>);
        super(info, options as ConstructorParameters<typeof actual.Server>[1]);
      }
    },
  };
});

describe("THE-1106 fix round 2 (LOW 2): Server constructor receives the ACTUAL legacyShim value", () => {
  it("stdio-shaped construction (legacyElicitationShim: true) passes { legacyShim: true }", async () => {
    capturedOptions.length = 0;
    const { createMcpServer } = await import("../src/mcp/server");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "d",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => ({ pong: true }),
    } as never);
    createMcpServer({
      name: "o",
      version: "0",
      registry,
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      legacyElicitationShim: true,
    });
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.inputRequired).toMatchObject({ legacyShim: true });
  });

  it("HTTP-shaped construction (legacyElicitationShim omitted) passes { legacyShim: false }", async () => {
    capturedOptions.length = 0;
    const { createMcpServer } = await import("../src/mcp/server");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "d",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => ({ pong: true }),
    } as never);
    createMcpServer({
      name: "o",
      version: "0",
      registry,
      context: (): CallerContext => ({
        caller: "http",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      era: "modern",
      // legacyElicitationShim deliberately omitted, matching transports/http.ts.
    });
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.inputRequired).toMatchObject({ legacyShim: false });
  });

  it("(LOW 1) roundTimeoutMs is derived from the codec's OWN ttlSeconds, not the SDK's 600s default", async () => {
    capturedOptions.length = 0;
    const { createMcpServer } = await import("../src/mcp/server");
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "d",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => ({ pong: true }),
    } as never);
    // A deliberately un-round TTL (42s) so a match against the shim's own 600s default, or
    // against ANY other plausible constant, would fail loudly rather than coincidentally pass.
    const elicitCodec = createElicitCodec("test-only-secret-not-a-real-credential-0123456789", 42);
    createMcpServer({
      name: "o",
      version: "0",
      registry,
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      legacyElicitationShim: true,
      elicitCodec,
    });
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.inputRequired).toMatchObject({ roundTimeoutMs: 42_000 });
  });
});
