import { describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

describe("server_health (F3)", () => {
  const tool = createHealthTool({ version: "1.0.0", vaults: ["v1", "v2"], startedAt: 0 });
  const base = {
    caller: null,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db: {} as never,
  } satisfies Partial<CallerContext>;

  it("omits the vault-id list for unauthenticated callers but reports vault_count", () => {
    const out = tool.handler({}, { ...base, authenticated: false } as CallerContext) as {
      vault_count: number;
      vaults?: string[];
    };
    expect(out.vault_count).toBe(2);
    expect(out.vaults).toBeUndefined();
  });

  it("includes the vault-id list for authenticated callers", () => {
    const out = tool.handler({}, { ...base, authenticated: true } as CallerContext) as {
      vaults?: string[];
    };
    expect(out.vaults).toEqual(["v1", "v2"]);
  });
});
