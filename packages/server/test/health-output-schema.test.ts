// THE-1073 fix round 2 (HIGH, both reviewers) — server_health's ACTUAL emitted payload, checked
// against its advertised outputSchema the way a real MCP client checks it: with the SDK's own
// AjvJsonSchemaValidator over the JSON Schema toJson() emits, not with zod's own safeParse.
//
// zod's safeParse SILENTLY STRIPS unknown keys off a non-strict z.object and reports success —
// that is exactly what let fix round 1 through: it added `kind` to `health.reconcileErrors`
// (runtime/reconcile-outcome.ts) to pick a stderr hint, and `IndexHealthSnapshotOutput`'s
// `reconcile_errors: z.array(z.object({ vault, error }))` (tools/admin/health.ts) happily parsed
// the extra field away. The JSON Schema `toJson()` converts to carries `additionalProperties:
// false` regardless, and the SDK's ajv validator — what `Client.callTool` actually runs — rejects
// the UNSTRIPPED payload outright. This test is the gate that stays red for that whole class of
// drift, not just this one field.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { toJson } from "../src/mcp/facade";
import type { CallerContext } from "../src/mcp/registry";
import { reconcileResultsForVault } from "../src/runtime/plane-wiring";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";
import type { IndexStats } from "../src/search/indexer";
import { createHealthTool, type HealthInfo } from "../src/tools/admin/health";

/** A clean IndexStats with one frontmatter failure — every field IndexStats requires. */
function statsWithFrontmatterFailure(): IndexStats {
  return {
    notes_seen: 3,
    notes_indexed: 2,
    chunks_upserted: 4,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: true,
    fts_enabled: true,
    notes_upserted: 2,
    notes_deleted: 0,
    notes_embed_failed: 0,
    chunks_dedup_reused: 0,
    chunks_dedup_unresolved: 0,
    embed_batch_rejections: 0,
    notes_stale_skipped: 0,
    notes_frontmatter_failed: 1,
    frontmatter_failures: [
      { path: "a.md", error: 'frontmatter is not valid YAML in "a.md": bad indentation' },
    ],
    model: "fake",
    dimensions: 8,
  };
}

const ctxBase = {
  caller: null,
  grantedScopes: new Set<string>(),
  vaultId: "v1",
  db: {} as never,
} satisfies Partial<CallerContext>;

describe("server_health's emitted payload vs its advertised outputSchema (ajv, THE-1073 fix round 2)", () => {
  it("a degraded reconcile (frontmatter failure, real reconcileResultsForVault) validates under ajv, the way a real MCP client checks it", () => {
    const health: ReconcileHealth = {
      reconcile: "pending",
      reconcileAt: null,
      reconcileErrors: [],
    };
    applyReconcileOutcome(reconcileResultsForVault("v1", statsWithFrontmatterFailure()), health, {
      now: () => 1,
      write: () => {},
    });
    expect(health.reconcile).toBe("degraded");
    expect(health.reconcileErrors).toHaveLength(1);

    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      getIndexHealth: (authenticated) => ({
        reconcile: health.reconcile,
        reconcile_at: health.reconcileAt,
        write_failures: 0,
        notes_ready: true,
        ...(authenticated ? { detail: { reconcile_errors: health.reconcileErrors } } : {}),
      }),
    });
    const out = tool.handler({}, { ...ctxBase, authenticated: true } as CallerContext);

    // zod's own safeParse — silently strips unknown keys, so this alone would NOT have caught fix
    // round 1's leak. Asserted here as documented contrast, not as the gate.
    expect(tool.outputSchema).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
    expect(tool.outputSchema!.safeParse(out).success).toBe(true);

    // THE GATE: ajv against the JSON Schema toJson() emits — the same validator
    // @modelcontextprotocol/sdk's Client.callTool runs client-side, and the one that actually
    // rejected fix round 1's leaked `kind` field with "must NOT have additional properties".
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const result = validate(JSON.parse(JSON.stringify(out)));
    expect(result.valid).toBe(true);
  });

  // THE-1123: the `toolFacade` block is assembled from internal state (ctx.clientInfo +
  // ctx.effectiveFacadeMode), exactly the shape the zod-safeParse-strips-but-ajv-rejects trap bites
  // — see reference_obsidian_tc_zod_safeparse_strips_but_ajv_rejects_extra_keys. Pinned here so a
  // future field added to that block is caught the same way fix round 1's `kind` leak was.
  it("the toolFacade block (auto mode, resolved from ctx.effectiveFacadeMode) validates under ajv too", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "auto", autoClients: { cursor: "flat" } },
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
      clientInfo: { name: "claude-code-cli" },
      // THE-1123 review fix (HIGH): the REAL dispatch pipeline (mcp/server.ts's tools/call
      // handler) sets this from the SAME resolver `tools/list` used — never re-derived here.
      effectiveFacadeMode: "domain",
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade).toEqual({
      configured: "auto",
      effective: "domain",
      clientName: "claude-code-cli",
    });

    expect(tool.outputSchema).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
    expect(tool.outputSchema!.safeParse(out).success).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const result = validate(JSON.parse(JSON.stringify(out)));
    expect(result.valid).toBe(true);
  });

  // THE-1123 review fix (HIGH): the exact regression the reviewer reproduced — a naive
  // re-resolution from `ctx.clientInfo` would say "domain" here (clientInfo.name matches the
  // built-in claude-code entry), but `ctx.effectiveFacadeMode` is what the real connection actually
  // resolved to (set once, cached, shared with tools/list) and MUST win.
  it("effective reads ctx.effectiveFacadeMode even when a naive re-resolution from clientInfo would disagree", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "auto" },
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
      clientInfo: { name: "claude-code" }, // built-in table alone would say "domain"
      effectiveFacadeMode: "flat", // but THIS connection already resolved to "flat"
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade?.effective).toBe("flat");
  });

  it("a caller with no observable clientInfo omits clientName (never a placeholder)", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "triad" },
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade).toEqual({ configured: "triad", effective: "triad" });
    expect(out.toolFacade).not.toHaveProperty("clientName");

    expect(tool.outputSchema).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const result = validate(JSON.parse(JSON.stringify(out)));
    expect(result.valid).toBe(true);
  });
});
