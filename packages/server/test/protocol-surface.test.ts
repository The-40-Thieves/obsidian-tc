// THE-583: protocol surface a DOWNSTREAM user can rely on, which our own deployment never exercises.
//
// This repo is public. Every item here is optional-to-us and load-bearing for someone else, so each
// is pinned by a test rather than left to hold by accident — the failure mode is silent, and it
// looks exactly like "we don't use it".
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JSON_SCHEMA_OPTS, toJson } from "../src/mcp/facade";

describe("x-mcp-header — custom headers from tool parameters (SEP-2243)", () => {
  it("survives the zod -> JSON Schema conversion", () => {
    // The SDK does the whole protocol side: it scans a tool's inputSchema for these, validates the
    // RFC 9110 token, the primitive-type restriction, case-insensitive uniqueness and the
    // static-reachability rule. All of that is dead if our converter drops the annotation first —
    // and a tool author would have no way to tell, because the tool still works.
    const schema = z.object({ tenant: z.string().meta({ "x-mcp-header": "X-Tenant-Id" }) });
    const json = toJson(schema) as { properties?: Record<string, Record<string, unknown>> };
    expect(json.properties?.tenant?.["x-mcp-header"]).toBe("X-Tenant-Id");
  });

  it("preserves the annotation on a NESTED property", () => {
    // The spec permits them at any depth reachable through `properties`.
    const schema = z.object({
      opts: z.object({ region: z.string().meta({ "x-mcp-header": "X-Region" }) }),
    });
    const json = toJson(schema) as {
      properties?: { opts?: { properties?: Record<string, Record<string, unknown>> } };
    };
    expect(json.properties?.opts?.properties?.region?.["x-mcp-header"]).toBe("X-Region");
  });
});

describe("SEP-2106 — schemas are JSON Schema 2020-12", () => {
  it("targets draft-2020-12", () => {
    // The revision loosened inputSchema/outputSchema to admit any 2020-12 keyword. Emitting an
    // older draft would advertise a dialect whose keywords a conformant client may reject.
    expect(JSON_SCHEMA_OPTS.target).toBe("draft-2020-12");
  });

  it("declares the dialect in $schema", () => {
    const json = toJson(z.object({ a: z.string() })) as { $schema?: string };
    expect(json.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("SEP-2577 client features reach every tool (deprecated, still functional)", () => {
  it("CallerContext carries roots and sample as optional capabilities", async () => {
    // Deprecated is not removed: SEP-2577 guarantees at least a twelve-month functional window, so
    // a client mid-migration still uses these. They are exposed on the context every tool receives
    // rather than consumed by a tool we happen to ship — the useful property for a public server is
    // that a downstream tool author can reach the calling client's roots and model at all.
    const mod = await import("../src/mcp/registry");
    // Structural, not behavioural: the fields are optional, so a missing one is a compile-time
    // change no runtime assertion would catch. This pins that they are still part of the contract.
    const ctx: import("../src/mcp/registry").CallerContext = {
      caller: null,
      authenticated: true,
      grantedScopes: new Set<string>(),
      vaultId: "v1",
      db: {} as never,
      roots: async () => [{ uri: "file:///tmp" }],
      sample: async () => undefined,
    };
    expect(typeof ctx.roots).toBe("function");
    expect(typeof ctx.sample).toBe("function");
    expect(await ctx.roots?.()).toEqual([{ uri: "file:///tmp" }]);
    expect(mod).toBeDefined();
  });
});
