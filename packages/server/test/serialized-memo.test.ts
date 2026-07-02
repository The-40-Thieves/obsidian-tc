import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import {
  type CallerContext,
  memoizeSerialized,
  ToolRegistry,
  takeSerialized,
} from "../src/mcp/registry";
import { defineTool } from "../src/tools/m1/define";

const stubDb = {
  prepare() {
    throw new Error("no db in this unit test");
  },
} as unknown as Database;

function ctx(): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db: stubDb,
  };
}

describe("single-serialization memo (THE-294)", () => {
  it("memoizes only non-null objects and take consumes the entry", () => {
    const obj = { a: 1 };
    memoizeSerialized(obj, '{"a":1}');
    memoizeSerialized(null, "null");
    memoizeSerialized("s", '"s"');
    memoizeSerialized(42, "42");
    expect(takeSerialized(obj)).toBe('{"a":1}');
    expect(takeSerialized(obj)).toBeUndefined(); // consumed
    expect(takeSerialized(null)).toBeUndefined();
    expect(takeSerialized("s")).toBeUndefined();
    expect(takeSerialized(42)).toBeUndefined();
  });

  it("a successful dispatch populates the memo with the governor's serialization", async () => {
    const registry = new ToolRegistry();
    const payload = { big: "x".repeat(100), nested: { n: 1 } };
    registry.register(
      defineTool({
        name: "give",
        description: "test tool",
        inputSchema: z.object({}).strict(),
        requiredScopes: [],
        handler: () => payload,
      }),
    );
    const res = await registry.dispatch("give", {}, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(takeSerialized(res.data)).toBe(JSON.stringify(payload));
    expect(takeSerialized(res.data)).toBeUndefined();
  });
});
