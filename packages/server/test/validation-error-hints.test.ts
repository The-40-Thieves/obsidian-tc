// THE-1042 (GH #935): a validation error names the broken field (THE-823) but not the fix. This
// closes two gaps, reproduced here verbatim from the issue's two real calls through call_capability
// on a real in-memory session (InMemoryTransport + the wire tools/call handler, same harness as
// facade-elicit-token.test.ts):
//
//   read_note { vault: "Auny", path: "..." }   -> the configured id is "auny"
//   search_text { vault, query, path: "<folder>" } -> search_text scopes with "root", not "path"
//
// Both hints are STRUCTURED in `details` first (a programmatic caller gets them without parsing
// text) and rendered second into content[0].text (THE-823's channel — real clients drop
// structuredContent on isError). Every assertion below checks BOTH.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const CALLER = "test-caller";

/** A nested `.strict()` object, for the "unrecognized_keys inside a nested path" case GH #935
 *  doesn't literally name but the brief requires. */
function nestedTestTool(): ToolDefinition {
  return {
    name: "nested_test_tool",
    description: "test-only tool with a nested strict object",
    inputSchema: z.object({ filter: z.object({ type: z.string().optional() }).strict() }).strict(),
    requiredScopes: [],
    handler: (i: unknown) => ({ echo: i }),
  } as unknown as ToolDefinition;
}

/** Four required fields + `.strict()`: called with one bogus key and no others, this produces
 *  EXACTLY MAX_RENDERED_ISSUES (5) issues — 4 missing-required plus 1 unrecognized_keys — so the
 *  "still within the cap" and "hint renders" cases can be asserted together without the cap itself
 *  eating the very issue carrying the hint. */
function wideTestTool(): ToolDefinition {
  return {
    name: "wide_test_tool",
    description: "test-only tool with four required fields",
    inputSchema: z
      .object(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`field_${i}`, z.string()])))
      .strict(),
    requiredScopes: [],
    handler: (i: unknown) => ({ echo: i }),
  } as unknown as ToolDefinition;
}

interface Harness {
  client: Client;
  server: Awaited<ReturnType<typeof createMcpServer>>;
  cleanup(): Promise<void>;
}

/** Two configured vaults ("auny", "other") + the real read_note/search_text tools (M1/M2) + the
 *  two synthetic tools above, on one registry wired with `visibleVaultIds` the same way
 *  runtime/governance.ts wires it in production (THE-924's list_vaults gate) — this suite exercises
 *  that wiring, not a stand-in for it. `over` becomes the CallerContext for every call on this
 *  connection, so a vaultBound test gets its own `connect()`. */
async function connect(over: Partial<CallerContext> = {}): Promise<Harness> {
  const rootAuny = mkdtempSync(join(tmpdir(), "obtc-auny-"));
  const rootOther = mkdtempSync(join(tmpdir(), "obtc-other-"));
  const vaultRegistry = new VaultRegistry([
    { id: "auny", path: rootAuny },
    { id: "other", path: rootOther },
  ]);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const provider = fakeEmbeddingProvider({ dimensions: 8 });
  const registry = new ToolRegistry({
    visibleVaultIds: (ctx) => {
      if (ctx.vaultBound !== true) return vaultRegistry.list().map((v) => v.id);
      try {
        return [vaultRegistry.resolve(ctx.vaultId).id];
      } catch {
        return [];
      }
    },
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    representation: buildRepresentationManifest(provider, {}),
  });
  registry.register(nestedTestTool());
  registry.register(wideTestTool());

  const context = (): CallerContext => ({
    caller: CALLER,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "auny",
    db,
    ...over,
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: "triad",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return {
    client,
    server,
    cleanup: async () => {
      await client.close();
      await server.close();
      rmTemp(rootAuny);
      rmTemp(rootOther);
    },
  };
}

function textOf(res: unknown): string {
  return (res as { content: [{ text: string }] }).content[0].text;
}

interface ErrorDetails {
  accepted_keys?: Record<string, string[]>;
  key_hints?: Record<string, Record<string, string>>;
  visible_vaults?: string[];
  did_you_mean?: string;
}

function detailsOf(res: unknown): ErrorDetails {
  return (
    ((res as { structuredContent?: { details?: ErrorDetails } }).structuredContent
      ?.details as ErrorDetails) ?? {}
  );
}

async function callCapability(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name: "call_capability", arguments: { name, args } });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("THE-1042 (GH #935): validation errors name the fix", () => {
  it('read_note {vault:"Auny"} (the issue\'s first call, verbatim): did you mean "auny"', async () => {
    const { client, cleanup } = await connect();
    cleanups.push(cleanup);
    const res = await callCapability(client, "read_note", { vault: "Auny", path: "a.md" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('did you mean "auny"');
    expect(detailsOf(res).did_you_mean).toBe("auny");
  });

  it('search_text {vault,query,path} (the issue\'s second call, verbatim): accepted lists "root", alias names "root"', async () => {
    const { client, cleanup } = await connect();
    cleanups.push(cleanup);
    const res = await callCapability(client, "search_text", {
      vault: "auny",
      query: "blog",
      path: "notes",
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("accepted:");
    expect(text).toContain("root");
    expect(text).toMatch(/"root".*"path"|did you mean.*"root"/);
    const details = detailsOf(res);
    expect(details.accepted_keys?.[""]).toContain("root");
    expect(details.key_hints?.[""]).toEqual({ path: "root" });
  });

  it("a vaultBound caller with a wrong (malformed) vault sees ONLY its own id, never the other vault's", async () => {
    // "Other" fails the VaultId regex (uppercase), so this is a validation_error at parseInput —
    // reachable regardless of vaultBound, since parseInput runs BEFORE the THE-267 binding guard.
    // Its case-folded form ("other") is coincidentally the SECOND configured vault's real id: if
    // the visibility gate were not applied, the hint would find and surface it. It must not.
    const { client, cleanup } = await connect({ vaultId: "auny", vaultBound: true });
    cleanups.push(cleanup);
    const res = await callCapability(client, "read_note", { vault: "Other", path: "a.md" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).not.toContain("other");
    const details = detailsOf(res);
    expect(details.visible_vaults).toEqual(["auny"]);
    expect(details.did_you_mean).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("other");
  });

  it("an unknown but well-formed vault id (vault_not_found): the visible vaults list", async () => {
    const { client, cleanup } = await connect();
    cleanups.push(cleanup);
    const res = await callCapability(client, "read_note", { vault: "zzz-unknown", path: "a.md" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("visible vaults:");
    expect(text).toContain("auny");
    expect(text).toContain("other");
    const details = detailsOf(res);
    expect(details.visible_vaults?.sort()).toEqual(["auny", "other"]);
    expect(details.did_you_mean).toBeUndefined();
  });

  it("unrecognized_keys on a nested object path", async () => {
    const { client, cleanup } = await connect();
    cleanups.push(cleanup);
    const res = await callCapability(client, "nested_test_tool", {
      filter: { type: "x", bogus: 1 },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("at filter");
    expect(text).toContain("accepted: type");
    const details = detailsOf(res);
    expect(details.accepted_keys?.filter).toEqual(["type"]);
  });

  it("the 5-issue cap still holds with hints (4 missing-required + 1 unrecognized_keys = exactly 5)", async () => {
    const { client, cleanup } = await connect();
    cleanups.push(cleanup);
    const res = await callCapability(client, "wide_test_tool", { bogus: 1 });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    const issueLines = text.split("\n").filter((l) => l.startsWith("✖"));
    expect(issueLines.length).toBe(5);
    expect(text).not.toMatch(/and \d+ more/);
    expect(text).toContain("accepted:");
    expect(detailsOf(res).accepted_keys?.[""]).toEqual([
      "field_0",
      "field_1",
      "field_2",
      "field_3",
    ]);
  });
});
