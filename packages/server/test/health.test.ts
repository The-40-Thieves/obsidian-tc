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

  it("surfaces index health; detail (per-vault errors) is authenticated-only (THE-288)", () => {
    const t = createHealthTool({
      version: "1.0.0",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      getIndexHealth: (authenticated) => ({
        reconcile: "degraded",
        reconcile_at: 123,
        write_failures: 2,
        ...(authenticated
          ? {
              detail: {
                reconcile_errors: [{ vault: "v1", error: "embed backend down" }],
                last_write_error: "eperm",
              },
            }
          : {}),
      }),
    });
    const anon = t.handler({}, { ...base, authenticated: false } as CallerContext) as {
      index?: { reconcile: string; write_failures: number; detail?: unknown };
    };
    expect(anon.index?.reconcile).toBe("degraded");
    expect(anon.index?.write_failures).toBe(2);
    // Path-bearing detail is withheld from the unauthenticated liveness probe.
    expect(anon.index?.detail).toBeUndefined();
    const authed = t.handler({}, { ...base, authenticated: true } as CallerContext) as {
      index?: { detail?: { reconcile_errors: unknown[]; last_write_error?: string } };
    };
    expect(authed.index?.detail?.reconcile_errors).toHaveLength(1);
    expect(authed.index?.detail?.last_write_error).toBe("eperm");
  });
});
