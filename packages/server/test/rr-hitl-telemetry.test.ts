// Release-review findings on completion telemetry: events must be filed under the vault a call
// ACTED ON (not the stdio placeholder it started on), and a denied item inside a successful batch
// must not emit a second completion event. The ledger selects cases by the RR-<id> prefix.
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { getDefaultElicitTtlSeconds } from "../src/elicit";
import { createElicitCodec } from "../src/elicit-request-state";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { buildResourceUri } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { requireConfirmation } from "../src/vault/hitl";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { openMemoryDb } from "./helpers";

interface Emitted {
  vault: string;
  type: string;
  data: Record<string, unknown>;
}

const vaults: TestVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});

const tool = (def: Partial<ToolDefinition> & { name: string }): ToolDefinition =>
  ({
    description: "test-only",
    inputSchema: z.object({ vault: VaultId }).strict(),
    vaultArg: "vault",
    requiredScopes: [],
    handler: () => ({ ok: true }),
    ...def,
  }) as unknown as ToolDefinition;

const placeholderCtx = (db: ReturnType<typeof openMemoryDb>): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "a",
  db,
});

describe("RR-L2 telemetry carries the vault the call acted on", () => {
  it("RR-L2 reviewer repro: an unbound stdio call from placeholder vault a that targets b files its completion and cache-reset events under b", async () => {
    const emitted: Emitted[] = [];
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry({
      emit: (vault, type, data) => emitted.push({ vault, type, data: data as never }),
    });
    registry.register(tool({ name: "reset_vault_cache" }));
    const r = await registry.dispatch("reset_vault_cache", { vault: "b" }, placeholderCtx(db));
    expect(r.ok).toBe(true);
    const byType = (t: string) => emitted.filter((e) => e.type === t).map((e) => e.vault);
    expect(byType("tc.tool.call.completed")).toEqual(["b"]);
    expect(byType("tc.vault.cache_reset")).toEqual(["b"]);
  });

  it("RR-L2 a call that targets no other vault still files under the caller's own", async () => {
    const emitted: Emitted[] = [];
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry({
      emit: (vault, type, data) => emitted.push({ vault, type, data: data as never }),
    });
    registry.register(tool({ name: "reset_vault_cache" }));
    await registry.dispatch("reset_vault_cache", { vault: "a" }, placeholderCtx(db));
    expect(emitted.filter((e) => e.type === "tc.tool.call.completed").map((e) => e.vault)).toEqual([
      "a",
    ]);
  });

  it("RR-L2 the handler-side confirmation relay (tc.elicit.consumed) names the effect vault, through a real form round trip", async () => {
    const emitted: Emitted[] = [];
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry({
      emit: (vault, type, data) => emitted.push({ vault, type, data: data as never }),
    });
    registry.register(
      tool({
        name: "rr_gated",
        handler: (_i: unknown, ctx: CallerContext) => {
          requireConfirmation(ctx, "rr_gated", { vault: "b" }, true, { path: "n.md" });
          return { ok: true };
        },
      }),
    );
    const server = createMcpServer({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      context: () => placeholderCtx(db),
      visibility: { grantedScopes: new Set(["*"]) },
      elicitCodec: createElicitCodec(
        randomBytes(32).toString("hex"),
        getDefaultElicitTtlSeconds(),
      ),
      legacyElicitationShim: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "rr", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { approve: true },
    }));
    await client.connect(clientTransport);
    try {
      const res = await client.callTool({ name: "rr_gated", arguments: { vault: "b" } });
      expect(res.isError, JSON.stringify(res)).toBeFalsy();
      expect(emitted.filter((e) => e.type === "tc.elicit.consumed").map((e) => e.vault)).toEqual([
        "b",
      ]);
      // Two dispatches (the refused one that raised the form, then the approved one): both under b.
      expect(
        emitted.filter((e) => e.type === "tc.tool.call.completed").map((e) => e.vault),
      ).toEqual(["b", "b"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("RR-L6 denied read_resources items are not completions", () => {
  it("RR-L6 reviewer repro: one allowed and three denied URIs -> ONE tc.tool.call.completed, three tc.acl.denied", async () => {
    const emitted: Emitted[] = [];
    const v = makeTestVault({
      files: { "pub/a.md": "A", "secret/b.md": "B", "secret/c.md": "C" },
      centralAcl: true,
      acl: { readPaths: ["pub/**"] },
      registryOpts: {
        emit: (vault, type, data) => emitted.push({ vault, type, data: data as never }),
      },
    });
    vaults.push(v);
    const uri = (rel: string) => buildResourceUri("test", rel);
    const r = await v.call("read_resources", {
      uris: [uri("pub/a.md"), uri("secret/b.md"), uri("secret/c.md"), uri("secret/none.md")],
    });
    expect(r.ok).toBe(true);
    const completions = emitted.filter(
      (e) => e.type === "tc.tool.call.completed" && e.data.tool === "read_resources",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]?.data.status).toBe("ok");
    expect(emitted.filter((e) => e.type === "tc.acl.denied")).toHaveLength(3);
  });
});
