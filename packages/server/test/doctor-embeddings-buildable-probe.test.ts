// #1231: a resolved `local` embedder has only been RESOLVED, never run. Plain `doctor` must not
// report it as a pass; under `doctor --probe` the dense execution probe (retrieval.heads) runs it,
// so the resolution line may pass. Sibling of doctor-embeddings-buildable.test.ts.
import { describe, expect, it } from "vitest";
import { embeddingsBuildableCheck } from "../src/doctor/embeddings-buildable";
import type { DoctorContext } from "../src/doctor/types";

const ctx = {} as DoctorContext;
const linux = { platform: "linux", arch: "x64", isMuslRuntime: () => false } as const;

function resolvedProbe() {
  return () =>
    Promise.resolve({
      ok: true as const,
      route: "source-checkout",
      attempts: [],
      inSourceCheckout: true,
    });
}

describe("embeddings.buildable (#1231: resolved is not the same as working)", () => {
  it("plain doctor: a resolved local embedder is a WARNING that names --probe, never an ok", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: resolvedProbe(),
      platformOverride: linux,
    }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toMatch(/dense search not probed; run `doctor --probe`/);
    expect(String(r.remediation)).toMatch(/doctor --probe/);
  });

  it("under --probe, a resolved local embedder passes this line (the dense probe runs in retrieval.heads)", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: resolvedProbe(),
      platformOverride: linux,
      probeRequested: true,
    }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("an unresolvable local embedder still fails under --probe", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: () =>
        Promise.resolve({
          ok: false as const,
          attempts: ["bare-specifier: not found"],
          inSourceCheckout: false,
        }),
      platformOverride: linux,
      probeRequested: true,
    }).run(ctx);
    expect(r.status).toBe("fail");
  });

  it("a resolved local embedder in a darwin-x64 standalone binary stays a warning under --probe too", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: resolvedProbe(),
      platformOverride: { platform: "darwin", arch: "x64", binary: true },
      probeRequested: true,
    }).run(ctx);
    expect(r.status).toBe("warning");
  });

  it("on darwin-x64's Node route (wasm fallback) a resolved local embedder is ok under --probe", async () => {
    const r = await embeddingsBuildableCheck({
      denseProvider: "local",
      probeLocalEmbedder: resolvedProbe(),
      platformOverride: { platform: "darwin", arch: "x64" },
      probeRequested: true,
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.platform).toMatch(/wasm fallback/);
  });
});
