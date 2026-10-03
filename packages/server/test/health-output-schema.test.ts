import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { toJson } from "../src/mcp/facade";
import {
  AUTO_FACADE_DEPRECATION,
  explainAutoFacadeMode,
  healthToolsWiringFields,
} from "../src/mcp/facade-auto";
import type { CallerContext } from "../src/mcp/registry";
import { NON_CORE_TOOL_NAMES } from "../src/mcp/tool-profiles";
import { reconcileResultsForVault } from "../src/runtime/plane-wiring";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";
import type { IndexStats } from "../src/search/indexer";
import { TelemetryCollector } from "../src/telemetry/collector";
import { sendTelemetry } from "../src/telemetry/sender";
import { wireTelemetry } from "../src/telemetry/wiring";
import { createHealthTool, type HealthInfo } from "../src/tools/admin/health";
import { makeTempDir, rmTemp } from "./tmp";

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
    notes_epoch_stale_skipped: 0,
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

  it("the index-on-write frontmatter fields (count + last failure) validate under ajv, and write_failures stays 0", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      getIndexHealth: (authenticated) => ({
        reconcile: "ok",
        reconcile_at: 1,
        write_failures: 0,
        frontmatter_failures: 1,
        notes_ready: true,
        ...(authenticated
          ? {
              detail: {
                reconcile_errors: [],
                last_frontmatter_failure: {
                  vault: "v1",
                  path: "a.md",
                  error: 'frontmatter is not valid YAML in "a.md": bad indentation',
                },
              },
            }
          : {}),
      }),
    });
    const out = tool.handler({}, { ...ctxBase, authenticated: true } as CallerContext);
    // biome-ignore lint/style/noNonNullAssertion: asserted defined by createHealthTool.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    expect(validate(JSON.parse(JSON.stringify(out))).valid).toBe(true);
    const index = (out as { index: { write_failures: number; frontmatter_failures: number } })
      .index;
    expect(index.write_failures).toBe(0);
    expect(index.frontmatter_failures).toBe(1);
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
      toolFacade: { configured: "auto", autoClients: { cursor: "flat" }, profile: "core" },
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
      profile: "core",
      nonCoreToolCount: NON_CORE_TOOL_NAMES.length,
      deprecation: AUTO_FACADE_DEPRECATION,
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

  // allowPlainHttp is deprecated: server_health says so, from the REAL wiring helper that reads
  // the config, and the field survives ajv (declared in the output schema, not silently stripped).
  it("deprecations: an allowPlainHttp still in the config is reported, and validates under ajv", () => {
    const wiring = healthToolsWiringFields({
      vaults: [{ id: "v1" }],
      toolFacade: { mode: "triad", profile: "full" },
      experiential: { citationInfer: { judge: { provider: "typesafe", allowPlainHttp: true } } },
      wikiJudge: { provider: "typesafe", allowPlainHttp: true },
    });
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      ...(wiring.deprecations ? { deprecations: wiring.deprecations } : {}),
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
    } as CallerContext) as HealthInfo;
    expect(out.deprecations).toEqual([
      expect.stringMatching(
        /experiential\.citationInfer\.judge\.allowPlainHttp is deprecated.*next major.*plainHttpHosts/,
      ),
      expect.stringMatching(/wikiJudge\.allowPlainHttp is deprecated/),
    ]);
    // biome-ignore lint/style/noNonNullAssertion: outputSchema is defined for this tool.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    expect(validate(JSON.parse(JSON.stringify(out))).valid).toBe(true);
  });

  it("deprecations: absent when no judge sets allowPlainHttp", () => {
    const wiring = healthToolsWiringFields({
      vaults: [{ id: "v1" }],
      toolFacade: { mode: "triad", profile: "full" },
      experiential: { citationInfer: { judge: { provider: "typesafe" } } },
      wikiJudge: { provider: "gateway", allowPlainHttp: true },
    });
    expect(wiring.deprecations).toBeUndefined();
  });

  // `toolFacade.explainAutoMode`: the optional `explanation` sub-object must survive the SDK's ajv
  // validator too (zod's safeParse strips unknown keys; ajv rejects them), so a field added to the
  // explanation but not to the output schema fails here.
  it("the toolFacade block carrying an explanation validates under zod and ajv", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "auto", profile: "core" },
    });
    const explanation = explainAutoFacadeMode("claude-code", { zed: "flat" });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
      clientInfo: { name: "claude-code" },
      effectiveFacadeMode: "domain",
      facadeExplanation: explanation,
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade?.explanation).toEqual(explanation);
    // biome-ignore lint/style/noNonNullAssertion: outputSchema is defined for this tool.
    const schema = toJson(tool.outputSchema!);
    // biome-ignore lint/style/noNonNullAssertion: outputSchema is defined for this tool.
    expect(tool.outputSchema!.safeParse(out).success).toBe(true);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    expect(validate(JSON.parse(JSON.stringify(out))).valid).toBe(true);
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
      toolFacade: { configured: "auto", profile: "core" },
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
      clientInfo: { name: "claude-code" }, // built-in table alone would say "domain"
      effectiveFacadeMode: "flat", // but THIS connection already resolved to "flat"
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade?.effective).toBe("flat");
  });

  it("an explicit mode reports no deprecation; only auto does", () => {
    for (const configured of ["triad", "domain", "flat"] as const) {
      const tool = createHealthTool({
        version: "test",
        vaults: ["v1"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        toolFacade: { configured, profile: "core" },
      });
      const out = tool.handler({}, {
        ...ctxBase,
        authenticated: false,
      } as CallerContext) as HealthInfo;
      expect(out.toolFacade).not.toHaveProperty("deprecation");
    }
  });

  it("a caller with no observable clientInfo omits clientName (never a placeholder)", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "triad", profile: "core" },
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
    } as CallerContext) as HealthInfo;
    expect(out.toolFacade).toEqual({
      configured: "triad",
      effective: "triad",
      profile: "core",
      nonCoreToolCount: NON_CORE_TOOL_NAMES.length,
    });
    expect(out.toolFacade).not.toHaveProperty("clientName");

    expect(tool.outputSchema).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const result = validate(JSON.parse(JSON.stringify(out)));
    expect(result.valid).toBe(true);
  });

  // THE-1125: the telemetry block validates under ajv — the same zod/ajv drift class THE-1073
  // fixed (a field on an internal record that reaches a tool output must be declared in the zod
  // schema, not merely present at runtime).
  //
  // CI fix (windows-latest): `db` is closed BEFORE cleanup below, and cleanup uses `rmTemp`
  // (test/tmp.ts) — Windows refuses to delete a file with an open handle; see that file's header.
  //
  // Security review (in-pool HIGH-B): the ORIGINAL version of this test hand-wrote the
  // `getTelemetryStatus` fixture, including a `lastSendAt` — which meant it could never have
  // caught the actual bug: `wiring.ts`'s REAL `getStatus()` also returns `nextSendAt` once a send
  // has happened, and that field was declared nowhere, so zod's safeParse silently stripped it
  // while ajv rejected the real (unstripped) payload. This version runs a REAL seeded send
  // through `sendTelemetry` against a real cache.db, then feeds the ACTUAL `getStatus()` output
  // into the health tool — the only way to be sure every field that function can ever return is
  // covered here, not just the ones a fixture author remembered to write down.
  it("the telemetry block, from a REAL wireTelemetry(...).getStatus() after a seeded send, validates under ajv", async () => {
    const cacheDir = makeTempDir("obtc-health-telemetry-ajv-");
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      db = await openDatabase(join(cacheDir, "cache.db"), 5000);
      provisionCacheDb(db, { version: "test" });
      const config = {
        telemetry: { enabled: true, endpoint: "https://collector.example", intervalMinutes: 60 },
        toolFacade: { mode: "triad" },
      } as unknown as ServerConfig;
      const telemetry = wireTelemetry({
        config,
        db,
        serverVersion: "test",
        now: () => 1737936000000,
      });
      // `getStatus()` reads lastSendAt/lastError back off `db` (state.ts), not off any collector
      // instance — so a standalone collector fed straight to `sendTelemetry` against the SAME db
      // is enough to seed real state for `telemetry.getStatus()` below to read back. This send
      // fails (no real Loki reachable), which is what makes `lastError` populated too — the
      // fullest real shape `getStatus()` can return.
      await sendTelemetry({
        db,
        collector: new TelemetryCollector(),
        endpoint: "https://collector.example",
        serverVersion: "test",
        facadeMode: "triad",
        now: () => 1737936000000,
        fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
      });

      const tool = createHealthTool({
        version: "test",
        vaults: ["v1"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        getTelemetryStatus: telemetry.getStatus,
      });
      const out = tool.handler({}, {
        ...ctxBase,
        authenticated: false,
      } as CallerContext) as HealthInfo;

      // The real shape: enabled, redacted endpoint, installId, lastSendAt, lastError, AND
      // nextSendAt — this is exactly the field ajv used to reject.
      expect(out.telemetry?.enabled).toBe(true);
      expect(out.telemetry?.endpoint).toBe("https://collector.example");
      expect(out.telemetry?.installId).toBeTruthy();
      expect(out.telemetry?.lastSendAt).toBe(1737936000000);
      expect(out.telemetry?.lastError).toBeTruthy();
      expect(out.telemetry?.nextSendAt).toBe(1737936000000 + 60 * 60_000);

      expect(tool.outputSchema).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
      const schema = toJson(tool.outputSchema!);
      const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
      const result = validate(JSON.parse(JSON.stringify(out)));
      expect(result.valid).toBe(true);
    } finally {
      db?.close?.();
      rmTemp(cacheDir);
    }
  });

  it("the telemetry block (disabled, no install id yet) validates under ajv too", () => {
    const tool = createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      getTelemetryStatus: () => ({ enabled: false }),
    });
    const out = tool.handler({}, {
      ...ctxBase,
      authenticated: false,
    } as CallerContext) as HealthInfo;
    expect(out.telemetry).toEqual({ enabled: false });
    expect(out.telemetry).not.toHaveProperty("endpoint");
    expect(out.telemetry).not.toHaveProperty("installId");

    expect(tool.outputSchema).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above.
    const schema = toJson(tool.outputSchema!);
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    const result = validate(JSON.parse(JSON.stringify(out)));
    expect(result.valid).toBe(true);
  });
});
