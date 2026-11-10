import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  type CallerContext,
  type RegistryOptions,
  type ToolDefinition,
  ToolRegistry,
} from "../src/mcp/registry";
import { confirmationStateProbe } from "../src/mcp/registry/policy-gates";
import { MetricsRecorder } from "../src/metrics/registry";
import { openMemoryDb } from "./helpers";
import { pathlessRegistry } from "./registry-fixtures";
import { makeTempDir, rmTemp } from "./tmp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(
  rootResolver: RegistryOptions["rootResolver"],
  options: Partial<RegistryOptions> = {},
) {
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  cleanups.push(() => db.close?.());
  const handler = vi.fn(() => ({ read: true }));
  const pathAcl = vi.fn(() => [{ op: "read" as const, path: "secret.md" }]);
  const tool: ToolDefinition = {
    name: "central_read",
    description: "A read guarded only by the central path ACL",
    inputSchema: z.object({ vault: z.string().optional() }),
    requiredScopes: ["read:notes"],
    vaultArg: "vault",
    pathAcl,
    handler,
  };
  const registry = new ToolRegistry({ ...options, rootResolver });
  registry.register(tool);
  const ctx: CallerContext = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: "known",
    db,
  };
  return { registry, handler, pathAcl, tool, ctx };
}

describe("central path ACL fails closed", () => {
  it("requires rootResolver at construction, including untyped callers", () => {
    // @ts-expect-error A registry must explicitly supply its vault-root resolver.
    expect(() => new ToolRegistry({})).toThrow(/rootResolver/);
    // @ts-expect-error Omitting all options must not bypass the wiring requirement.
    expect(() => new ToolRegistry()).toThrow(/rootResolver/);
    expect(() => new ToolRegistry({ rootResolver: null as never })).toThrow(/rootResolver/);
  });

  it.each([undefined, ""])(
    "refuses an unresolved root (%s) before extracting paths",
    async (root) => {
      const f = fixture(() => root);
      const result = await f.registry.dispatch("central_read", {}, f.ctx);
      expect(result).toMatchObject({ ok: false, error: { code: "vault_not_found" } });
      expect(f.pathAcl).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
      const audit = f.ctx.db
        .prepare("SELECT error_code FROM event_log WHERE tool_name = ?")
        .get("central_read");
      expect(audit).toMatchObject({ error_code: "vault_not_found" });
    },
  );

  it("does not offload a call whose vault root cannot be resolved", () => {
    const f = fixture(() => undefined);
    expect(f.registry.passesPolicyGates("central_read", {}, f.ctx)).toBe(false);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("meters an unresolved root as a refused call", async () => {
    const metrics = new MetricsRecorder();
    const f = fixture(() => undefined, { metrics });
    await f.registry.dispatch("central_read", {}, f.ctx);
    const text = await metrics.metrics();
    // Metered like the unknown-vault refusal the handler itself would have returned.
    expect(text).toContain(
      'obsidian_tc_tool_calls_total{vault="known",tool="central_read",status="error"} 1',
    );
  });

  it("the pathless test fixture cannot silently allow a pathAcl tool", async () => {
    const f = fixture(() => undefined);
    const registry = pathlessRegistry();
    registry.register(f.tool);
    const result = await registry.dispatch("central_read", {}, f.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "vault_not_found" } });
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("resolves the argument vault, never falling back to the caller's known root", async () => {
    const rootResolver = vi.fn((id: string) => (id === "known" ? "/known" : undefined));
    const f = fixture(rootResolver);
    const result = await f.registry.dispatch("central_read", { vault: "unknown" }, f.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "vault_not_found" } });
    expect(rootResolver).toHaveBeenCalledWith("unknown");
    expect(rootResolver).not.toHaveBeenCalledWith("known");
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("does not issue an unbound path confirmation when the root is unresolved", () => {
    const f = fixture(() => undefined);
    const probe = confirmationStateProbe(f.tool, {}, f.ctx, () => undefined);
    expect(probe).toThrow(expect.objectContaining({ code: "vault_not_found" }));
    expect(f.pathAcl).not.toHaveBeenCalled();
  });

  it("refuses a resolved target before checking or running the handler", async () => {
    const f = fixture(() => undefined);
    const checkResolvedTarget = vi.fn();
    f.registry.register({
      ...f.tool,
      name: "central_active",
      resolveTarget: async () => ({ path: "secret.md" }),
      checkResolvedTarget,
    });
    const result = await f.registry.dispatch("central_active", {}, f.ctx);
    expect(result).toMatchObject({ ok: false, error: { code: "vault_not_found" } });
    expect(checkResolvedTarget).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("keeps tools without pathAcl usable without a filesystem vault", async () => {
    const rootResolver = vi.fn(() => undefined);
    const f = fixture(rootResolver);
    f.registry.register({ ...f.tool, name: "central_status", pathAcl: undefined });
    const result = await f.registry.dispatch("central_status", {}, f.ctx);
    expect(result.ok).toBe(true);
    expect(rootResolver).not.toHaveBeenCalled();
    expect(f.handler).toHaveBeenCalledOnce();
  });

  it("enforces the real root's ACL and allows only the permitted read", async () => {
    const root = makeTempDir("obtc-central-acl-");
    cleanups.push(() => rmTemp(root));
    writeFileSync(join(root, "secret.md"), "not readable");
    const f = fixture((id) => (id === "known" ? root : undefined));
    f.ctx.acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: [],
    });
    const denied = await f.registry.dispatch("central_read", {}, f.ctx);
    expect(denied).toMatchObject({ ok: false, error: { code: "acl_denied" } });
    expect(f.handler).not.toHaveBeenCalled();
    f.ctx.acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["secret.md"],
    });
    const allowed = await f.registry.dispatch("central_read", {}, f.ctx);
    expect(allowed.ok).toBe(true);
    expect(f.handler).toHaveBeenCalledOnce();
  });
});
