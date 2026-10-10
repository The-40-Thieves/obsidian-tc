// An outputSchema whose root cannot honestly be `type: object` (z.unknown(), a union that admits an
// array or a primitive) is NOT advertised. The four plur_* proxy tools declare z.unknown() because
// the external backend may return any JSON value; advertising `{type:"object"}` for them made the
// SDK client reject a legitimate array result ("data must be object") - and an array result carries
// no structuredContent at all, which the client also rejects when an outputSchema is advertised.
// The runtime result of those tools is untouched; only the advertisement is withheld.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import { describeCapability, toJson } from "../src/mcp/facade";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

const context = (): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "t",
  db: {} as never,
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
});

function fixtureRegistry(): ToolRegistry {
  const r = new ToolRegistry({ strictOutputSchema: false });
  const base = { inputSchema: z.object({}).strict(), requiredScopes: [] };
  r.register({
    ...base,
    name: "proxy_array",
    description: "unconstrained output; the backend returned an array",
    outputSchema: z.unknown(),
    handler: () => [{ id: "e1" }, { id: "e2" }],
  });
  r.register({
    ...base,
    name: "proxy_scalar",
    description: "unconstrained output; the backend returned a primitive",
    outputSchema: z.any(),
    handler: () => "plain",
  });
  r.register({
    ...base,
    name: "array_or_object",
    description: "a union that admits an array",
    outputSchema: z.union([z.array(z.string()), z.object({ a: z.string() })]),
    handler: () => ["x"],
  });
  r.register({
    ...base,
    name: "object_union",
    description: "all-object union keeps the fold",
    outputSchema: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    handler: () => ({ a: "x" }),
  });
  r.register({
    ...base,
    name: "plain_object",
    description: "constrained output",
    outputSchema: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
  return r;
}

async function connect(registry: ToolRegistry, facadeMode: "flat" | "triad" = "flat") {
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
  const client = new Client({ name: "unconstrained-output", version: "0" });
  await client.connect(ct);
  return client;
}

describe("an unconstrained outputSchema root is not advertised", () => {
  it("tools/list carries no outputSchema for z.unknown(), and a handler returning an array succeeds client-side", async () => {
    const client = await connect(fixtureRegistry());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const omitted of ["proxy_array", "proxy_scalar", "array_or_object"])
      expect(byName.get(omitted)?.outputSchema, omitted).toBeUndefined();
    expect(byName.get("plain_object")?.outputSchema).toMatchObject({ type: "object" });
    expect(byName.get("object_union")?.outputSchema).toMatchObject({ type: "object" });

    // The SDK client validates structuredContent against an advertised outputSchema and throws
    // when one is advertised but absent, so a successful call proves the advertisement is honest.
    const res = await client.callTool({ name: "proxy_array", arguments: {} });
    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res.content)).toContain("e1");
    const scalar = await client.callTool({ name: "proxy_scalar", arguments: {} });
    expect(scalar.isError).not.toBe(true);
    const union = await client.callTool({ name: "array_or_object", arguments: {} });
    expect(union.isError).not.toBe(true);
    await client.close();
  });

  it("describe_capability agrees with tools/list: no output_schema key for those tools", () => {
    const r = fixtureRegistry();
    for (const name of ["proxy_array", "proxy_scalar", "array_or_object"]) {
      const def = r.list().find((d) => d.name === name);
      if (!def) throw new Error(`fixture: ${name}`);
      expect("output_schema" in describeCapability(def), name).toBe(false);
    }
    const kept = r.list().find((d) => d.name === "plain_object");
    expect(describeCapability(kept as never).output_schema).toMatchObject({ type: "object" });
  });

  it("toJson reports the omission as undefined instead of coercing the root", () => {
    expect(toJson(z.unknown())).toBeUndefined();
    expect(toJson(z.object({ a: z.string() }))).toMatchObject({ type: "object" });
  });
});

// The omission set is pinned by name: a regression that starts omitting more tools (or a new
// z.unknown() output slipping in unnoticed) changes this list and fails here.
const EXPECTED_UNADVERTISED_OUTPUTS = [
  "plur_get",
  "plur_recall",
  "plur_recall_hybrid",
  "plur_similarity_search",
];

describe("the real registry omits exactly the unconstrained outputs", () => {
  it("pins the omission set by name, over tools/list and describe_capability", async () => {
    const registry = buildFullRegistry();
    const withSchema = registry.list().filter((d) => d.outputSchema);
    expect(withSchema.length).toBeGreaterThan(150);

    const client = await connect(registry);
    const advertised = new Map<string, boolean>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) advertised.set(t.name, t.outputSchema !== undefined);
      cursor = page.nextCursor;
    } while (cursor);
    await client.close();

    const omittedList = withSchema
      .filter((d) => advertised.get(d.name) === false)
      .map((d) => d.name)
      .sort();
    expect(omittedList).toEqual(EXPECTED_UNADVERTISED_OUTPUTS);
    const omittedDescribe = withSchema
      .filter((d) => !("output_schema" in describeCapability(d)))
      .map((d) => d.name)
      .sort();
    expect(omittedDescribe).toEqual(EXPECTED_UNADVERTISED_OUTPUTS);
  }, 60_000);
});
