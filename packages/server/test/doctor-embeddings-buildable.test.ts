// THE-1122 review round 3: embeddingsBuildableCheck's three-way status on a failed resolution —
// see that function's own comment for the reasoning. Mirrors doctor-reranker-buildable.test.ts's
// shape for the sibling `reranker.buildable` check.
import { describe, expect, it } from "vitest";
import { embeddingsBuildableCheck } from "../src/doctor/embeddings-buildable";
import type { DoctorContext } from "../src/doctor/types";

const ctx = {} as DoctorContext;

function unresolvedProbe(inSourceCheckout: boolean) {
  return () =>
    Promise.resolve({
      ok: false as const,
      attempts: ["bare-specifier: not found"],
      inSourceCheckout,
    });
}

describe("embeddings.buildable (THE-1122 review round 3: three-way status)", () => {
  it("not 'local' — nothing to resolve, always ok", async () => {
    const r = await embeddingsBuildableCheck({ denseProvider: "openai" }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("FAILS when the platform is supported and the package genuinely cannot resolve (real install, not a source checkout)", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(false),
      platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => false },
    }).run(ctx);
    expect(r.status).toBe("fail");
    expect(String(r.remediation)).toMatch(/npm add|bun run build/);
  });

  it("WARNs (not FAILs) when this is a source checkout that simply hasn't been built yet", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(true),
      platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => false },
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/not yet built/);
  });

  it("WARNs (not FAILs) when the platform is genuinely unsupported, even on a real (non-source-checkout) install", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(false),
      platformOverride: { platform: "darwin", arch: "x64" },
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/cannot run it anyway/);
  });

  it("WARNs on an unsupported platform even when it IS a source checkout (platform takes precedence in the summary text)", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(true),
      platformOverride: { platform: "darwin", arch: "x64" },
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/cannot run it anyway/);
  });

  it("resolved successfully on a supported platform: ok", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: () =>
        Promise.resolve({
          ok: true,
          route: "bare-specifier",
          attempts: [],
          inSourceCheckout: false,
        }),
      platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => false },
    }).run(ctx);
    expect(r.status).toBe("ok");
  });
});
