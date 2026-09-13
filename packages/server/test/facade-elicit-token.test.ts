// THE-1037 (GH #925): mcp/server.ts's tools/call handler strips `elicit_token` from the OUTER
// envelope into `ctx.elicitToken` (see the comment at that strip site), but `callCapability`
// (mcp/facade.ts) dispatched call_capability's INNER `args.args` straight through untouched. A
// minted token nested there reached the target's `.strict()` schema as an unrecognized key —
// `validation_error`, not redemption — making a gated tool uncallable through the facade at all.
// The domain-grouped facade (`facadeMode: "domain"`) dispatches the same way and had the same gap.
//
// Reproduced end to end over the wire (InMemoryTransport + the real tools/call handler), not via
// m1-helpers' `.call`, which invokes registry.dispatch directly and would never see a bug that
// lives entirely in the boundary between the wire handler and dispatch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import type { FacadeMode } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { openMemoryDb } from "./helpers";

const VAULT_ID = "v1";
const CALLER = "test-caller";

/** A destructive `.strict()` tool — the shape that surfaces the bug: an unrecognized `elicit_token`
 *  key is what a non-strict schema silently drops, hiding the defect. */
function dangerTool(): ToolDefinition {
  return {
    name: "danger_write",
    description: "test-only destructive tool",
    inputSchema: z.strictObject({ path: z.string() }),
    requiredScopes: [],
    destructive: true,
    handler: (i: { path: string }) => ({ wrote: i.path }),
  } as unknown as ToolDefinition;
}

async function connect(facadeMode: FacadeMode) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registry.register(dangerTool());
  const context = (): CallerContext => ({
    caller: CALLER,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: VAULT_ID,
    db,
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server, db };
}

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function mintToken(db: unknown, argsHash: unknown): Promise<string> {
  return issueElicitToken(db as Parameters<typeof issueElicitToken>[0], {
    vaultId: VAULT_ID,
    toolName: "danger_write",
    argsHash: String(argsHash),
    caller: CALLER,
  });
}

describe("THE-1037: elicit_token nested in call_capability's inner args (GH #925)", () => {
  it("without a token: elicit_required, unchanged", async () => {
    const { client, server } = await connect("triad");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md" } },
    });
    expect(res.isError).toBe(true);
    expect(structured(res).code).toBe("elicit_required");
    await client.close();
    await server.close();
  });

  it("with a minted token in the INNER args: succeeds (fails today with validation_error)", async () => {
    const { client, server, db } = await connect("triad");
    const need = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md" } },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    expect(typeof argsHash).toBe("string");
    const token = await mintToken(db, argsHash);

    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md", elicit_token: token } },
    });
    expect(structured(res).code).not.toBe("validation_error");
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({ wrote: "a.md" });
    await client.close();
    await server.close();
  });

  it("a WRONG token in the inner args: the HITL error, not validation_error", async () => {
    const { client, server } = await connect("triad");
    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md", elicit_token: "not-a-real-token" } },
    });
    expect(res.isError).toBe(true);
    expect(structured(res).code).toBe("elicit_required");
    await client.close();
    await server.close();
  });

  it("regression guard: the direct tools/call path still redeems an OUTER elicit_token", async () => {
    const { client, server, db } = await connect("flat");
    const need = await client.callTool({
      name: "danger_write",
      arguments: { path: "a.md" },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    const token = await mintToken(db, argsHash);

    const res = await client.callTool({
      name: "danger_write",
      arguments: { path: "a.md", elicit_token: token },
    });
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({ wrote: "a.md" });
    await client.close();
    await server.close();
  });

  it("the domain-grouped path (facadeMode: domain) redeems a token too", async () => {
    const { client, server, db } = await connect("domain");
    const need = await client.callTool({
      name: "other",
      arguments: { action: "danger_write", args: { path: "a.md" } },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    expect(typeof argsHash).toBe("string");
    const token = await mintToken(db, argsHash);

    const res = await client.callTool({
      name: "other",
      arguments: { action: "danger_write", args: { path: "a.md", elicit_token: token } },
    });
    expect(structured(res).code).not.toBe("validation_error");
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({ wrote: "a.md" });
    await client.close();
    await server.close();
  });
});
