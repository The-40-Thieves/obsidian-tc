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
 *  key is what a non-strict schema silently drops, hiding the defect. `name` is parameterized so
 *  the changed-tool test can register a SECOND gated tool sharing the same input shape. */
function dangerTool(name: string): ToolDefinition {
  return {
    name,
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
  registry.register(dangerTool("danger_write"));
  registry.register(dangerTool("danger_write_2"));
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

async function mintToken(db: unknown, toolName: string, argsHash: unknown): Promise<string> {
  return issueElicitToken(db as Parameters<typeof issueElicitToken>[0], {
    vaultId: VAULT_ID,
    toolName,
    argsHash: String(argsHash),
    caller: CALLER,
  });
}

/** consumed_at for a minted token, read straight from the elicit_tokens row — the ground truth for
 *  single-use / precedence assertions, independent of any dispatch-level error shape. */
function consumedAt(db: unknown, token: string): number | null {
  const row = (db as { prepare: (sql: string) => { get: (t: string) => unknown } })
    .prepare("SELECT consumed_at FROM elicit_tokens WHERE token = ?")
    .get(token) as { consumed_at: number | null };
  return row.consumed_at;
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
    const token = await mintToken(db, "danger_write", argsHash);

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
    const token = await mintToken(db, "danger_write", argsHash);

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
    const token = await mintToken(db, "danger_write", argsHash);

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

  it("a token minted for a DIFFERENT gated tool with the SAME args: the HITL error, not success", async () => {
    // argsHash() folds the tool name into the hash (hash.ts), so a token minted against
    // danger_write's hash carries a different hash than danger_write_2's hash of the identical
    // raw args — the binding is per-TOOL, not just per-args.
    const { client, server, db } = await connect("triad");
    const need = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md" } },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    expect(typeof argsHash).toBe("string");
    const token = await mintToken(db, "danger_write", argsHash);

    const res = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write_2", args: { path: "a.md", elicit_token: token } },
    });
    expect(res.isError).toBe(true);
    expect(structured(res).code).toBe("elicit_required");
    await client.close();
    await server.close();
  });

  it("changed args, then replay of the SAME token: HITL error both times, single-use enforced", async () => {
    const { client, server, db } = await connect("triad");
    const need = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md" } },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    expect(typeof argsHash).toBe("string");
    const token = await mintToken(db, "danger_write", argsHash);

    // Same token, DIFFERENT args than it was minted for: dispatch recomputes the hash off the
    // actual call, which no longer matches (elicit.ts's args_hash equality check).
    const mismatched = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "b.md", elicit_token: token } },
    });
    expect(mismatched.isError).toBe(true);
    expect(structured(mismatched).code).toBe("elicit_required");
    expect(consumedAt(db, token)).toBeNull(); // a rejected verify must not consume the token

    // The SAME token against the args it WAS minted for: succeeds, and verifyAndConsumeElicit
    // marks it consumed as a side effect (single-use, `UPDATE ... WHERE consumed_at IS NULL`).
    const first = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md", elicit_token: token } },
    });
    expect(first.isError).not.toBe(true);
    expect(structured(first)).toMatchObject({ wrote: "a.md" });
    expect(consumedAt(db, token)).not.toBeNull();

    // Replaying the exact same call with the exact same (now-consumed) token: refused. elicit.ts's
    // verifyAndConsumeElicit checks `consumed_at !== null` before the hash check and returns
    // false, so dispatch throws elicit_required again rather than re-running the write.
    const replay = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md", elicit_token: token } },
    });
    expect(replay.isError).toBe(true);
    expect(structured(replay).code).toBe("elicit_required");
    await client.close();
    await server.close();
  });

  it("precedence: an INNER call_capability token wins over an OUTER tools/call token", async () => {
    const { client, server, db } = await connect("triad");
    const need = await client.callTool({
      name: "call_capability",
      arguments: { name: "danger_write", args: { path: "a.md" } },
    });
    const argsHash = (structured(need).details as { args_hash?: string } | undefined)?.args_hash;
    expect(typeof argsHash).toBe("string");
    const outerToken = await mintToken(db, "danger_write", argsHash);
    const innerToken = await mintToken(db, "danger_write", argsHash);

    // elicit_token at BOTH the outer tools/call envelope (a sibling of `name`/`args`, stripped
    // generically before facade routing) and call_capability's inner args (the documented
    // location — per splitElicitToken's comment, "the inner one wins").
    const res = await client.callTool({
      name: "call_capability",
      arguments: {
        name: "danger_write",
        args: { path: "a.md", elicit_token: innerToken },
        elicit_token: outerToken,
      },
    });
    expect(res.isError).not.toBe(true);
    expect(structured(res)).toMatchObject({ wrote: "a.md" });

    // The inner token is the one actually consumed for this call...
    expect(consumedAt(db, innerToken)).not.toBeNull();
    // ...the outer token was never consulted and remains unconsumed.
    expect(consumedAt(db, outerToken)).toBeNull();
    await client.close();
    await server.close();
  });
});
