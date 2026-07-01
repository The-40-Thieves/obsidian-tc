import { describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

describe("server_health (F3)", () => {
  const tool = createHealthTool({
    version: "1.0.0",
    vaults: ["v1", "v2"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
  });
  const base = {
    caller: null,
    grantedScopes: new Set<string>(),
    vaultId: "v1",
    db: {} as never,
  } satisfies Partial<CallerContext>;

  it("omits the vault-id list for unauthenticated callers but reports vault_count + flags", () => {
    const out = tool.handler({}, { ...base, authenticated: false } as CallerContext) as {
      vault_count: number;
      vaults?: string[];
      native_loaded?: boolean;
      vec_enabled?: boolean;
    };
    expect(out.vault_count).toBe(2);
    expect(out.vaults).toBeUndefined();
    // Capability flags are non-identifying, so the unauthenticated liveness probe still sees them.
    expect(out.native_loaded).toBe(false);
    expect(out.vec_enabled).toBe(false);
  });

  it("includes the vault-id list for authenticated callers", () => {
    const out = tool.handler({}, { ...base, authenticated: true } as CallerContext) as {
      vaults?: string[];
    };
    expect(out.vaults).toEqual(["v1", "v2"]);
  });

  it("reflects the native + vec capability flags from opts", () => {
    const t = createHealthTool({
      version: "1.0.0",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: true,
      vecEnabled: true,
    });
    const out = t.handler({}, { ...base, authenticated: false } as CallerContext) as {
      native_loaded?: boolean;
      vec_enabled?: boolean;
    };
    expect(out.native_loaded).toBe(true);
    expect(out.vec_enabled).toBe(true);
  });
});
