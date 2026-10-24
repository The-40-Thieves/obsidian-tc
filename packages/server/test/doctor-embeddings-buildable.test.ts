// THE-1122 review round 3: embeddingsBuildableCheck's three-way status on a failed resolution —
// see that function's own comment for the reasoning. Mirrors doctor-reranker-buildable.test.ts's
// shape for the sibling `reranker.buildable` check.
import { describe, expect, it } from "vitest";
import { version } from "../package.json";
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
  it("FAILS with remediation naming the explicit install command (not --omit=optional)", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(false),
      platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => false },
    }).run(ctx);
    expect(String(r.remediation)).toContain(
      `npm i @the-40-thieves/obsidian-tc-embedder-local@${version}`,
    );
    expect(String(r.remediation)).not.toContain("--omit=optional");
  });

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

  it("WARNs when a future binary has no runtime, even on a real install", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(false),
      platformOverride: { platform: "linux", arch: "x64", binary: true },
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/cannot run it anyway/);
  });

  it("a future no-runtime binary takes precedence over source-checkout remediation", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(true),
      platformOverride: { platform: "linux", arch: "x64", binary: true },
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/cannot run it anyway/);
  });

  it("on darwin-x64's Node route an unresolved local embedder is the ordinary fail, not a platform warning", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: unresolvedProbe(false),
      platformOverride: { platform: "darwin", arch: "x64" },
    }).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).not.toMatch(/cannot run it anyway/);
  });

  it("resolved successfully on a supported platform under --probe: ok (#1231: a plain run warns, see the -probe test file)", async () => {
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
      probeRequested: true,
    }).run(ctx);
    expect(r.status).toBe("ok");
  });
});
