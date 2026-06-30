import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, type DispatchProfile, ToolRegistry } from "../src/mcp/registry";
import { defineTool } from "../src/tools/m1/define";

// dispatch only touches ctx.db inside the audit closure, which swallows errors ("audit must
// never break dispatch"), so a throwing stub is enough for a tool with no idempotency key.
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

function noopRegistry(onProfile?: (p: DispatchProfile) => void): ToolRegistry {
  const registry = new ToolRegistry(onProfile ? { onProfile } : {});
  registry.register(
    defineTool({
      name: "noop",
      description: "test tool",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: () => ({ ok: true }),
    }),
  );
  return registry;
}

describe("dispatch profile sink", () => {
  it("reports total + handler time on a successful dispatch", async () => {
    const seen: DispatchProfile[] = [];
    const result = await noopRegistry((p) => seen.push(p)).dispatch("noop", {}, ctx());
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const p = seen[0];
    expect(p?.tool).toBe("noop");
    expect(p?.vaultId).toBe("main");
    expect(p?.handler_ms).toBeGreaterThanOrEqual(0);
    expect(p?.handler_ms).toBeLessThanOrEqual(p?.total_ms ?? -1);
  });

  it("is a no-op (and never throws) when no sink is wired", async () => {
    const result = await noopRegistry().dispatch("noop", {}, ctx());
    expect(result.ok).toBe(true);
  });
});
