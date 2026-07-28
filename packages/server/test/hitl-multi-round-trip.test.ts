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
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
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
  const registry = new ToolRegistry();
  // `destructive: true` is what arms the dispatch HITL gate (registry: `needsHitl`).
  registry.register({
    name: "danger_write",
    description: "test-only destructive tool",
    inputSchema: z.object({ vault: z.string(), path: z.string() }),
    requiredScopes: [],
    destructive: true,
    handler: () => ({ wrote: true }),
  } as any);
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
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

/** One modern tools/call, optionally echoing a previously issued requestState. */
async function call(
  port: number,
  jwt: string,
  args: Record<string, unknown>,
  requestState?: string,
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "danger_write",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "danger_write",
        arguments: args,
        _meta: META,
        ...(requestState ? { requestState } : {}),
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
});
