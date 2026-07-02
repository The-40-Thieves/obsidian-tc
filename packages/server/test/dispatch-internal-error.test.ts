import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { defineTool } from "../src/tools/m1/define";

// dispatch only touches ctx.db inside the audit closure (which swallows errors), so a throwing
// stub is enough for a tool with no idempotency key.
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

type SinkEvent = { tool: string; vaultId: string; err: unknown };

function registryWithThrower(
  name: string,
  handler: () => unknown,
  onInternalError?: (tool: string, vaultId: string, err: unknown) => void,
): ToolRegistry {
  const registry = new ToolRegistry(onInternalError ? { onInternalError } : {});
  registry.register(
    defineTool({
      name,
      description: "test tool",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler,
    }),
  );
  return registry;
}

describe("dispatch internal-error sink (THE-288)", () => {
  it("routes a non-typed throw to the sink and still redacts the client response", async () => {
    const seen: SinkEvent[] = [];
    const boom = new Error("secret stack detail");
    const registry = registryWithThrower(
      "boom",
      () => {
        throw boom;
      },
      (tool, vaultId, err) => seen.push({ tool, vaultId, err }),
    );
    const res = await registry.dispatch("boom", {}, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // The client never sees the real message or stack — only the redacted internal error.
    expect(res.error.code).toBe("internal");
    expect(res.error.message).toBe("internal error");
    // The operator sink receives the real error object (tool + vault + the thrown value).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: "boom", vaultId: "main", err: boom });
  });

  it("does NOT route a typed ObsidianTcError to the sink (already a clean client error)", async () => {
    const seen: SinkEvent[] = [];
    const registry = registryWithThrower(
      "denied",
      () => {
        throw new ObsidianTcError("forbidden", "nope");
      },
      (tool, vaultId, err) => seen.push({ tool, vaultId, err }),
    );
    const res = await registry.dispatch("denied", {}, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.code).toBe("forbidden");
    expect(seen).toHaveLength(0);
  });

  it("is a no-op (never throws) when no sink is wired", async () => {
    const registry = registryWithThrower("boom2", () => {
      throw new Error("x");
    });
    const res = await registry.dispatch("boom2", {}, ctx());
    expect(res.ok).toBe(false);
  });
});
