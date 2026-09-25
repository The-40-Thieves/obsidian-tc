// THE-583: the 2026-07-28 HITL round trip (SEP-2260 / SEP-2322), end to end over the wire.
//
// The revision replaced server-initiated elicitation with a client-driven round trip: the server
// answers `inputRequired` carrying an opaque `requestState`, and the client re-issues the same call
// echoing it back. That matters for interoperability — the 2025 shape was an `elicit_required`
// error plus a bespoke `elicit_token` argument, which only a client written against THIS server
// could complete.
//
// Asserted on the WIRE rather than through the codec, because the codec passing tells you nothing
// about whether the transport verifies the state before handlers run, whether dispatch consults it,
// or whether the binding actually gates a second call. Those are the parts that can silently not
// work.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { requireConfirmation } from "../src/vault/hitl";
import { openMemoryDb } from "./helpers";

const MODERN = "2026-07-28";
const SECRET = "test-only-secret-not-a-real-credential-0123456789";

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "hitl-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

async function boot() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const effect = { applied: 0, seen: [] as string[] };
  const events: string[] = [];
  const registry = new ToolRegistry({ emit: (_v, type) => events.push(type) });
  // `destructive: true` is what arms the dispatch HITL gate (registry: `needsHitl`).
  registry.register({
    name: "danger_write",
    description: "test-only destructive tool",
    inputSchema: z.object({ vault: z.string(), path: z.string() }),
    requiredScopes: [],
    destructive: true,
    handler: () => ({ wrote: true }),
  } as any);
  // THE-1106 fix round 2 (HIGH): a REAL handler-side-gated tool shape (write_note overwrite of a
  // non-empty note) — `vault/hitl.ts`'s `requireConfirmation`, never dispatch's OWN `checkHitl`.
  registry.register({
    name: "write_note",
    description: "test-only write_note overwrite-gate shape",
    inputSchema: z.object({
      vault: z.string(),
      path: z.string(),
      overwriteNonEmpty: z.boolean().optional(),
    }),
    requiredScopes: [],
    handler: (i: { path: string; overwriteNonEmpty?: boolean }, ctx: CallerContext) => {
      requireConfirmation(ctx, "write_note", i, i.overwriteNonEmpty === true, { path: i.path });
      effect.applied += 1;
      effect.seen.push(i.path);
      return { wrote: true };
    },
  } as any);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  const h = await startHttp({
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
  return { ...h, effect, events };
}

async function token(): Promise<string> {
  const { SignJWT } = await import("jose");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "agent-1",
    scopes: ["*"],
    aud: "http://test",
    iat: now,
    exp: now + 600,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

/** One modern tools/call, optionally echoing a previously issued requestState AND the embedded
 *  request's response (`inputResponses`) — THE-1106 fix round 1: a spec-compliant retry carries
 *  BOTH (`InputResponses` is a real field on a retried request's params, not a shim-only concept —
 *  `@modelcontextprotocol/server`'s `createMcpHandler-*.d.mts` names it "A map of embedded input
 *  responses" on the retry), and dispatch now requires the confirm leg's OWN accept/decline
 *  (`ctx.mcpReq.inputResponses`) before trusting an echoed state — a verified `requestState` alone
 *  only proves the token is authentic, not that the human approved. Defaults to an accepting
 *  response whenever a state is echoed, matching what a real client sends after the human approves;
 *  pass `inputResponses: null` to omit it (an incomplete/non-compliant retry) or a different value
 *  to simulate a decline. */
async function call(
  port: number,
  jwt: string,
  args: Record<string, unknown>,
  requestState?: string,
  inputResponses: Record<string, unknown> | null | undefined = requestState
    ? { confirm: { action: "accept", content: { approve: true } } }
    : undefined,
  toolName = "danger_write",
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": toolName,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
        _meta: META,
        ...(requestState ? { requestState } : {}),
        ...(inputResponses ? { inputResponses } : {}),
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text || "{}");
}

describe("HITL multi-round-trip (THE-583, SEP-2260/2322)", () => {
  it("answers a destructive call with inputRequired + a requestState, not a bare error", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const first = await call(h.port, jwt, { vault: "v1", path: "a.md" });
      const result = first.result;
      expect(result).toBeDefined();
      // The protocol's own shape — this is what a generic client keys off.
      expect(result.resultType).toBe("input_required");
      expect(typeof result.requestState).toBe("string");
      expect(result.inputRequests?.confirm?.method).toBe("elicitation/create");
    } finally {
      await h.close();
    }
  }, 25_000);

  it("completes the call when the SAME state is echoed back", async () => {
    // The round trip actually closing is the point. If the transport did not verify the state, or
    // dispatch did not consult it, this would loop on input_required forever.
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "a.md" };
      const first = await call(h.port, jwt, args);
      const state = first.result.requestState as string;

      const second = await call(h.port, jwt, args, state);
      expect(second.error).toBeUndefined();
      expect(second.result?.resultType).not.toBe("input_required");
      expect(second.result?.isError).not.toBe(true);
      expect(JSON.stringify(second.result)).toContain("wrote");
    } finally {
      await h.close();
    }
  }, 25_000);

  it("refuses to let a confirmation authorize DIFFERENT arguments", async () => {
    // The binding that makes a confirmation a confirmation. Approving a write of a.md must not
    // authorize a write of b.md — otherwise one approval is a general-purpose write capability.
    const h = await boot();
    const jwt = await token();
    try {
      const first = await call(h.port, jwt, { vault: "v1", path: "a.md" });
      const state = first.result.requestState as string;

      const elsewhere = await call(h.port, jwt, { vault: "v1", path: "b.md" }, state);
      // Still asking for confirmation — the state did not authorize this call.
      expect(elsewhere.result?.resultType).toBe("input_required");
    } finally {
      await h.close();
    }
  }, 25_000);

  it("rejects a forged state rather than treating it as absent", async () => {
    // A tampered state must fail closed. Silently ignoring it would degrade to "no confirmation
    // supplied", which is safe here only by accident — and would hide an attack.
    const h = await boot();
    const jwt = await token();
    try {
      const forged = await call(h.port, jwt, { vault: "v1", path: "a.md" }, "not-a-real-state");
      const answered = forged.error !== undefined || forged.result?.resultType === "input_required";
      expect(answered).toBe(true);
      expect(JSON.stringify(forged)).not.toContain("wrote");
    } finally {
      await h.close();
    }
  }, 25_000);

  // THE-1106 fix round 1 (CRITICAL, cross-vendor review): a verified `requestState` alone proves
  // the token is authentic and bound to this call — it says nothing about whether the human
  // actually approved. Before this fix, echoing a VALID state back was enough to satisfy the HITL
  // gate regardless of what `inputResponses` said, so a client (or a bug) that echoed the state
  // after a DECLINE still completed the write. Reproduced directly by the stdio shim's wire tests
  // (test/hitl-legacy-shim-elicitation.test.ts); this is the same property proven on the modern,
  // client-driven wire this file otherwise covers.
  it("a declined confirmation echoing the SAME state must NOT complete the call", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "a.md" };
      const first = await call(h.port, jwt, args);
      const state = first.result.requestState as string;

      const declined = await call(h.port, jwt, args, state, {
        confirm: { action: "decline" },
      });
      expect(JSON.stringify(declined)).not.toContain("wrote");
      expect(declined.result?.isError).toBe(true);
      // And no infinite/looping re-offer: the decline renders the plain elicit_required error,
      // never a second input_required round.
      expect(declined.result?.resultType).not.toBe("input_required");
    } finally {
      await h.close();
    }
  }, 25_000);

  it("approve: false on the embedded response must NOT complete the call either", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "a.md" };
      const first = await call(h.port, jwt, args);
      const state = first.result.requestState as string;

      const notApproved = await call(h.port, jwt, args, state, {
        confirm: { action: "accept", content: { approve: false } },
      });
      expect(JSON.stringify(notApproved)).not.toContain("wrote");
      expect(notApproved.result?.isError).toBe(true);
    } finally {
      await h.close();
    }
  }, 25_000);

  // THE-1106 fix round 2 (MEDIUM, grok): the actual pre-fix ATTACK, not just a decline — a client
  // (malicious or merely non-compliant) that echoes a VALID requestState but OMITS inputResponses
  // entirely. Before THE-1106 fix round 1's CRITICAL fix, `echoed !== undefined` alone was enough
  // to satisfy the gate; this proves the omission case specifically, since `call()`'s own default
  // (accept+approve:true whenever a state is echoed) would otherwise mask it silently.
  it("a valid requestState echoed with inputResponses OMITTED must NOT complete the call", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "a.md" };
      const first = await call(h.port, jwt, args);
      const state = first.result.requestState as string;

      const omitted = await call(h.port, jwt, args, state, null);
      expect(JSON.stringify(omitted)).not.toContain("wrote");
      // No responses at all reads as "not yet answered" — a fresh offer, not a hard error, and
      // absolutely not a completion.
      expect(omitted.result?.resultType).toBe("input_required");
    } finally {
      await h.close();
    }
  }, 25_000);

  // THE-1106 fix round 2 (HIGH): the regression this whole fix round exists for, on the MODERN
  // client-driven wire — `vault/hitl.ts`'s OWN gate (write_note overwrite), not dispatch's.
  it("(HIGH fix, handler-side gate) write_note overwrite -> an approved state clears vault/hitl.ts's OWN gate, exactly one write", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "notes/a.md", overwriteNonEmpty: true };
      const first = await call(h.port, jwt, args, undefined, undefined, "write_note");
      expect(first.result?.resultType).toBe("input_required");
      const state = first.result.requestState as string;

      const second = await call(h.port, jwt, args, state, undefined, "write_note");
      expect(second.error).toBeUndefined();
      expect(second.result?.resultType).not.toBe("input_required");
      expect(JSON.stringify(second.result)).toContain("wrote");
      expect(h.effect.applied).toBe(1);
      expect(h.effect.seen).toEqual(["notes/a.md"]);
      // THE-1106 fix round 2 (HIGH, audit): the ONLY signal for this — dispatch's own
      // tc.elicit.consumed relay never runs for a non-dispatch-gated tool.
      expect(h.events).toContain("tc.elicit.consumed");
    } finally {
      await h.close();
    }
  }, 25_000);

  it("(HIGH fix) write_note overwrite: a declined state never writes and never satisfies vault/hitl.ts's gate", async () => {
    const h = await boot();
    const jwt = await token();
    try {
      const args = { vault: "v1", path: "notes/a.md", overwriteNonEmpty: true };
      const first = await call(h.port, jwt, args, undefined, undefined, "write_note");
      const state = first.result.requestState as string;

      const declined = await call(
        h.port,
        jwt,
        args,
        state,
        { confirm: { action: "decline" } },
        "write_note",
      );
      expect(JSON.stringify(declined)).not.toContain("wrote");
      expect(declined.result?.isError).toBe(true);
      expect(h.effect.applied).toBe(0);
    } finally {
      await h.close();
    }
  }, 25_000);
});
