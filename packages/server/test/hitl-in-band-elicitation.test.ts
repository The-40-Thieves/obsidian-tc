// THE-1106 (GH #967 parts 1/3): on a LEGACY-era connection (2025-11-25 / 2025-06-18 — stdio never
// negotiates 2026-07-28, see McpServerOptions.inBandElicitation's doc comment in mcp/server.ts),
// every HITL-gated call used to be clearable only by shelling out to `obsidian-tc elicit` and
// resubmitting `elicit_token` by hand. An agent with no shell either minted the token itself
// (bypassing the human) or gave up. This wires the server-initiated `elicitation/create` push
// (the mechanism that actually works pre-2026-07-28 — `inputRequired` is unreachable there
// whatever codec is passed) end to end over a REAL in-memory transport, using the classic
// `@modelcontextprotocol/sdk` `Client`, which negotiates via the legacy `initialize` handshake —
// exactly the era this fix targets.
//
// Asserted on the WIRE, not by calling internal functions directly, for the same reason
// hitl-multi-round-trip.test.ts (THE-583's modern counterpart) does: whether the client's
// `elicitation/create` handler is actually invoked, whether the re-dispatch actually completes the
// call, and whether a decline actually renders the ordinary error are exactly the parts that can
// silently not work.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MorgianaEventData, MorgianaEventType } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, verifyAndConsumeElicit } from "../src/elicit";
import { clientSupportsFormElicitation } from "../src/mcp/in-band-elicitation";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { openMemoryDb } from "./helpers";

function collector() {
  const events: Array<{
    vaultId: string;
    type: MorgianaEventType;
    data: Partial<MorgianaEventData>;
  }> = [];
  const emit = (vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData>) =>
    events.push({ vaultId, type, data });
  return { events, emit, types: () => events.map((e) => e.type) };
}

/** An always-gated tool (`destructive: true` arms dispatch's OWN `elicit_required` throw) whose
 *  handler mutates a plain in-memory record — the observable "effect" the wire tests assert on,
 *  standing in for a real vault write/delete without a filesystem fixture (the SAME test-double
 *  shape error-rendering.test.ts's `destructiveTool` already uses for this exact gate). */
function destructiveTool(effect: { applied: number }): ToolDefinition {
  return {
    name: "danger_write",
    description: "test-only destructive tool",
    inputSchema: z.object({ path: z.string() }),
    requiredScopes: [],
    destructive: true,
    handler: () => {
      effect.applied += 1;
      return { wrote: true };
    },
  } as unknown as ToolDefinition;
}

async function boot(opts: { emit?: ReturnType<typeof collector>["emit"] } = {}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const effect = { applied: 0 };
  // `verifyElicit: elicitVerifier` mirrors runtime/governance.ts's real ToolRegistry construction
  // (runtime/server-runtime.ts) — without it dispatch's HITL gate never verifies ANY token, elicit
  // or otherwise, and every re-dispatch would fail closed regardless of what this fix does.
  const registry = new ToolRegistry({ emit: opts.emit, verifyElicit: elicitVerifier });
  registry.register(destructiveTool(effect));

  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
  });

  // No `era`/`elicitCodec` — legacy by construction. `inBandElicitation: true` mirrors
  // runtime/server-runtime.ts's stdio wiring exactly.
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    inBandElicitation: true,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport, db, effect };
}

/** A client that negotiates the legacy `initialize` handshake (the classic SDK `Client` always
 *  does) and answers every `elicitation/create` the way `answer` says. Records each request's
 *  params so a test can assert exactly-once and inspect the message/target. */
function makeClient(
  capabilities: Record<string, unknown>,
  answer: (() => { action: string; content?: Record<string, unknown> }) | undefined,
) {
  const client = new Client({ name: "in-band-test", version: "1.0.0" }, { capabilities });
  const requests: unknown[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push(request.params);
      return answer();
    });
  }
  return { client, requests };
}

describe("THE-1106: in-band elicitation on a legacy-era (stdio) connection", () => {
  it("(a) destructive call -> elicitation/create -> accept{approve:true} completes the call, exactly once, and fires tc.elicit.consumed", async () => {
    const c = collector();
    const { server, clientTransport, effect } = await boot({ emit: c.emit });
    const { client, requests } = makeClient({ elicitation: { form: {} } }, () => ({
      action: "accept",
      content: { approve: true },
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res)).toContain("wrote");
      expect(effect.applied).toBe(1); // the handler ran exactly once
      expect(requests).toHaveLength(1); // exactly one elicitation/create
      const params = requests[0] as { message: string; mode: string };
      expect(params.mode).toBe("form");
      expect(params.message).toContain("danger_write");
      expect(c.types()).toContain("tc.elicit.consumed");
      expect(c.types()).toContain("tc.elicit.in_band");
      const inBand = c.events.find((e) => e.type === "tc.elicit.in_band");
      expect(inBand?.data.status).toBe("ok");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(b) decline -> the elicit_required error result with the directive text; no effect", async () => {
    const c = collector();
    const { server, clientTransport, effect } = await boot({ emit: c.emit });
    const { client, requests } = makeClient({ elicitation: { form: {} } }, () => ({
      action: "decline",
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text).toContain("Error [elicit_required]");
      expect(text).toContain("Ask the user now");
      expect(text).toContain("obsidian-tc elicit");
      expect(effect.applied).toBe(0);
      expect(requests).toHaveLength(1); // never a second prompt
      const inBand = c.events.find((e) => e.type === "tc.elicit.in_band");
      expect(inBand?.data.status).toBe("denied");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(c) accept{approve:false} -> same as decline: elicit_required, no effect, no loop", async () => {
    const { server, clientTransport, effect } = await boot();
    const { client, requests } = makeClient({ elicitation: { form: {} } }, () => ({
      action: "accept",
      content: { approve: false },
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBe(true);
      expect(effect.applied).toBe(0);
      expect(requests).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(d) no elicitation capability -> plain error, the client handler is never called", async () => {
    const { server, clientTransport, effect } = await boot();
    // A real client with no elicitation capability would not register a handler for it either —
    // the classic SDK `Client` itself refuses `setRequestHandler(ElicitRequestSchema, ...)` when
    // its own declared capabilities don't include `elicitation` (`assertRequestHandlerCapability`).
    // `requests` staying empty here proves the same thing a registered-but-uninvoked handler would:
    // the server never attempted to reach a capability the client didn't declare.
    const { client, requests } = makeClient({}, undefined);
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBe(true);
      expect(effect.applied).toBe(0);
      expect(requests).toHaveLength(0); // never invoked
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(e) elicitation: { url: {} } only -> treated as no form support, plain error", async () => {
    const { server, clientTransport, effect } = await boot();
    const { client, requests } = makeClient({ elicitation: { url: {} } }, () => ({
      action: "accept",
      content: { approve: true },
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBe(true);
      expect(effect.applied).toBe(0);
      expect(requests).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(f) elicitation: {} (bare, e.g. Claude Code 2.1.281) -> form IS supported, round trip completes", async () => {
    // Measured fact: Claude Code 2.1.281 initializes a stdio MCP server with protocolVersion
    // "2025-11-25" and capabilities { roots: { listChanged: true }, elicitation: {} } (captured
    // from a stub server's initialize log, 2026-09-24). This is the exact client the predicate fix
    // makes eligible — a bare `elicitation: {}` must be read as form support (the 2025 pre-mode
    // rule), not "no elicitation support".
    const { server, clientTransport, effect } = await boot();
    const { client, requests } = makeClient(
      { roots: { listChanged: true }, elicitation: {} },
      () => ({ action: "accept", content: { approve: true } }),
    );
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBeFalsy();
      expect(effect.applied).toBe(1);
      expect(requests).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(h) the approved re-dispatch's token is single-use: replaying it fails closed", async () => {
    const { server, clientTransport, db } = await boot();
    const { client } = makeClient({ elicitation: { form: {} } }, () => ({
      action: "accept",
      content: { approve: true },
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBeFalsy();
      // The token minted for this call (issueElicitToken, inside tryInBandElicitation) was
      // consumed by the re-dispatch's HITL check (verifyAndConsumeElicit — UPDATE ... WHERE
      // consumed_at IS NULL). It never crosses the wire on the in-band path, so read it straight
      // out of elicit_tokens: exactly one row for this tool, and it is already consumed.
      const row = db
        .prepare(
          "SELECT token, args_hash, consumed_at FROM elicit_tokens WHERE tool_name = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get("danger_write") as { token: string; args_hash: string; consumed_at: number | null };
      expect(row).toBeDefined();
      expect(row.consumed_at).not.toBeNull();
      // Replaying the SAME token against the SAME hash/vault/caller must fail closed —
      // verifyAndConsumeElicit's `consumed_at IS NULL` guard, not a second grant.
      expect(verifyAndConsumeElicit(db, row.token, row.args_hash, "v1", "stdio")).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("(g) HTTP legacy-era: unaffected — no server-initiated request, still the plain error", async () => {
    // transports/http.ts never passes `inBandElicitation`, so a legacy-era HTTP call must behave
    // exactly as before THE-1106: an elicit_required error, no elicitation/create sent. Verified
    // directly against createMcpServer with `inBandElicitation` omitted (http.ts's own construction
    // shape), over the SAME in-memory transport plumbing — the point is the OPTION gates it, not the
    // transport per se (a live HTTP round trip for this is already covered by
    // hitl-multi-round-trip.test.ts and error-rendering.test.ts's modern-era regression guard).
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register(destructiveTool({ applied: 0 }));
    const context = (): CallerContext => ({
      caller: "http-caller",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    });
    const server = createMcpServer({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      context,
      visibility: { grantedScopes: new Set(["*"]) },
      // inBandElicitation deliberately omitted — matches transports/http.ts.
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const { client, requests } = makeClient({ elicitation: { form: {} } }, () => ({
      action: "accept",
      content: { approve: true },
    }));
    try {
      await client.connect(clientTransport);
      const res = await client.callTool({ name: "danger_write", arguments: { path: "a.md" } });
      expect(res.isError).toBe(true);
      expect(requests).toHaveLength(0); // no server-initiated request was sent
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("THE-1106: clientSupportsFormElicitation predicate (the fix itself)", () => {
  it("bare `elicitation: {}` is form support (2025 pre-mode default)", () => {
    expect(clientSupportsFormElicitation({ elicitation: {} })).toBe(true);
  });
  it("`elicitation: { form: {} }` is form support", () => {
    expect(clientSupportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
  });
  it("`elicitation: { url: {} }` alone is NOT form support", () => {
    expect(clientSupportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
  });
  it("no `elicitation` capability at all is NOT form support", () => {
    expect(clientSupportsFormElicitation({})).toBe(false);
    expect(clientSupportsFormElicitation(undefined)).toBe(false);
    expect(clientSupportsFormElicitation(null)).toBe(false);
  });
  it("Claude Code 2.1.281's measured shape ({ roots: {...}, elicitation: {} }) is form support", () => {
    expect(clientSupportsFormElicitation({ roots: { listChanged: true }, elicitation: {} })).toBe(
      true,
    );
  });
});
