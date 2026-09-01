// Proves the execute:<plugin> security mechanism end-to-end through dispatch:
// the degradation gate (requirePlugin), deny-by-default scope checks, and the
// hardcoded HITL floor on the execute family (scopes.ts HITL_FLOOR_FAMILIES).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilitySnapshot } from "../src/bridge/capabilities";
import { requirePlugin } from "../src/bridge/degrade";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { defineTool } from "../src/tools/m1/define";
import { openMemoryDb } from "./helpers";

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error("expected a throw");
}

function thrown(fn: () => unknown): { code: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    return e as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a throw");
}

describe("requirePlugin degradation gate", () => {
  const reachable: CapabilitySnapshot = {
    companion: "reachable",
    plugins: { dataview: { installed: true, version: "0.5.66" }, tasks: { installed: false } },
  };

  it("returns the reported version when the plugin is available", () => {
    expect(requirePlugin(reachable, "dataview").version).toBe("0.5.66");
  });

  it("degrades to plugin_missing when the plugin is not installed", () => {
    expect(thrownCode(() => requirePlugin(reachable, "tasks"))).toBe("plugin_missing");
  });

  it("degrades to plugin_missing when the companion is absent", () => {
    expect(thrownCode(() => requirePlugin({ companion: "missing", plugins: {} }, "dataview"))).toBe(
      "plugin_missing",
    );
  });

  it("degrades to plugin_unreachable when the companion did not answer", () => {
    expect(
      thrownCode(() => requirePlugin({ companion: "unreachable", plugins: {} }, "dataview")),
    ).toBe("plugin_unreachable");
  });

  // THE-923: requirePlugin previously dropped snap.unreachableCause on the floor, so a
  // plugin-proxy tool call saw only the static "reload the plugin" text even when the snapshot
  // already knew the real fetch cause (e.g. a TLS trust failure).
  it("carries cause_code from snap.unreachableCause when the companion is unreachable", () => {
    const e = thrown(() =>
      requirePlugin(
        { companion: "unreachable", plugins: {}, unreachableCause: "DEPTH_ZERO_SELF_SIGNED_CERT" },
        "dataview",
      ),
    );
    expect(e.code).toBe("plugin_unreachable");
    expect(e.details?.cause_code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("omits cause_code when the snapshot recorded no unreachable cause", () => {
    const e = thrown(() => requirePlugin({ companion: "unreachable", plugins: {} }, "dataview"));
    expect(e.details && "cause_code" in e.details).toBe(false);
  });
});

describe("execute:<plugin> scope + HITL floor through dispatch", () => {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registry.register(
    defineTool({
      name: "__bridge_read_probe",
      domain: "admin",
      description: "read-side bridge probe tool",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["read:dataview"],
      handler: () => ({ ok: 1 }),
    }),
  );
  registry.register(
    defineTool({
      name: "__bridge_execute_probe",
      domain: "admin",
      description: "execute-side bridge probe tool",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["execute:templater"],
      handler: () => ({ ran: true }),
    }),
  );

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["read:dataview"]),
    vaultId: "v",
    db,
    ...over,
  });

  it("grants a read-side tool to a token holding read:<plugin>", async () => {
    const res = await registry.dispatch("__bridge_read_probe", {}, ctx());
    expect(res.ok).toBe(true);
  });

  it("denies a read-side tool to a token lacking read:<plugin> (deny-by-default)", async () => {
    const res = await registry.dispatch(
      "__bridge_read_probe",
      {},
      ctx({ grantedScopes: new Set(["read:tasks"]) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("denies an execute-side tool to a token holding only read:<plugin>", async () => {
    const res = await registry.dispatch(
      "__bridge_execute_probe",
      {},
      ctx({ grantedScopes: new Set(["read:templater"]) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("HITL-floors an execute-side tool even with the scope but no elicit token", async () => {
    const res = await registry.dispatch(
      "__bridge_execute_probe",
      {},
      ctx({ grantedScopes: new Set(["execute:templater"]) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
  });

  it("admits an execute-side tool with the scope + a valid elicit token", async () => {
    const hash = argsHash("__bridge_execute_probe", {});
    const token = issueElicitToken(db, {
      vaultId: "v",
      toolName: "__bridge_execute_probe",
      argsHash: hash,
      caller: "t",
    });
    const res = await registry.dispatch(
      "__bridge_execute_probe",
      {},
      ctx({ grantedScopes: new Set(["execute:templater"]), elicitToken: token }),
    );
    expect(res.ok).toBe(true);
  });

  it("honors the execute:* family wildcard with a valid elicit token", async () => {
    const hash = argsHash("__bridge_execute_probe", {});
    const token = issueElicitToken(db, {
      vaultId: "v",
      toolName: "__bridge_execute_probe",
      argsHash: hash,
      caller: "t",
    });
    const res = await registry.dispatch(
      "__bridge_execute_probe",
      {},
      ctx({ grantedScopes: new Set(["execute:*"]), elicitToken: token }),
    );
    expect(res.ok).toBe(true);
  });
});
