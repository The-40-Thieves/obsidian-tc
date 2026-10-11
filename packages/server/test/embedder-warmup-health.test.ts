// The warmup's state is operator-visible: server_health.embedder_warmup (live) and doctor's
// embeddings.buildable (the state a server on this config will report). The error text can name
// cache paths, so like index.detail it is withheld from unauthenticated and vault-bound callers.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { embeddingsBuildableCheck } from "../src/doctor/embeddings-buildable";
import type { DoctorContext } from "../src/doctor/types";
import type { EmbedderWarmupStatus } from "../src/embeddings/warmup";
import { toJson } from "../src/mcp/facade";
import type { CallerContext } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";

const base = { caller: null, grantedScopes: new Set<string>(), vaultId: "v1", db: {} as never };
const toolWith = (status?: EmbedderWarmupStatus) =>
  createHealthTool({
    version: "t",
    vaults: ["v1"],
    startedAt: 0,
    nativeLoaded: false,
    vecEnabled: false,
    ...(status ? { getEmbedderWarmup: () => status } : {}),
  });
const call = (t: ReturnType<typeof toolWith>, extra: Partial<CallerContext>) =>
  t.handler({}, { ...base, ...extra } as CallerContext) as {
    embedder_warmup?: EmbedderWarmupStatus;
  };

describe("server_health.embedder_warmup", () => {
  it("is absent when the accessor is not wired", () => {
    expect(call(toolWith(), { authenticated: true }).embedder_warmup).toBeUndefined();
  });

  it.each(["not-applicable", "pending", "loading", "ready"] as const)("reports %s", (state) => {
    expect(call(toolWith({ state }), { authenticated: false }).embedder_warmup).toEqual({ state });
  });

  it("failed is visible to everyone, the error text only to an authenticated unbound caller", () => {
    const t = toolWith({ state: "failed", error: "ENOENT /home/x/.obsidian-tc/models" });
    expect(call(t, { authenticated: false }).embedder_warmup).toEqual({ state: "failed" });
    expect(call(t, { authenticated: true, vaultBound: true }).embedder_warmup).toEqual({
      state: "failed",
    });
    expect(call(t, { authenticated: true }).embedder_warmup).toEqual({
      state: "failed",
      error: "ENOENT /home/x/.obsidian-tc/models",
    });
  });

  it("validates under the advertised outputSchema, ajv included", () => {
    const t = toolWith({ state: "failed", error: "boom" });
    const out = call(t, { authenticated: true });
    expect(t.outputSchema?.safeParse(out).success).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: outputSchema asserted defined above.
    const schema = toJson(t.outputSchema!)!;
    const validate = new AjvJsonSchemaValidator().getValidator(schema as never);
    expect(validate(JSON.parse(JSON.stringify(out))).valid).toBe(true);
  });
});

describe("doctor embeddings.buildable warmup state", () => {
  const ctx = {} as DoctorContext;
  const platformOverride = { platform: "linux", arch: "x64", isMuslRuntime: () => false } as const;

  it("local resolved: warmup is pending (it runs after the first initialize)", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: async () => ({
        ok: true,
        route: "bare-specifier",
        attempts: [],
        inSourceCheckout: false,
      }),
      platformOverride,
    }).run(ctx);
    expect(r.details?.warmup).toBe("pending");
  });

  it("a remote provider is not-applicable", async () => {
    const r = await embeddingsBuildableCheck({ denseProvider: "openai" }).run(ctx);
    expect(r.details?.warmup).toBe("not-applicable");
  });

  it("local unresolvable: the warmup will fail, and doctor says why", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: async () => ({
        ok: false,
        attempts: ["bare-specifier: nope"],
        inSourceCheckout: false,
      }),
      platformOverride,
    }).run(ctx);
    expect(r.details?.warmup).toBe("failed");
    expect(String(r.details?.warmupError)).toMatch(/resolve/);
  });
});
