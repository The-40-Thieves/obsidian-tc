// THE-806 step 2: `--gated-rerank` used to build its OWN hardZ-only literal
// (`{ enabled: true, hardZ: hardZ ?? 1.0 }`), never reading `retrieval.gatedRerankHardness` — the
// exact config surface THE-806 step 1 built precisely so "production and the eval harness can
// construct the SAME object" (rerank_stage.ts's own doc comment on `gatedRerankOptionsFromConfig`).
// That promise was never kept on the harness side: passing `--gated-rerank` against an eval config
// carrying a `retrieval.gatedRerankHardness` block silently ignored it and always took the
// z-margin branch — so a golden-set result still measured a hardness rule a real deployment
// reading that SAME config file could not reproduce. Same defect class as the original ticket,
// one seam over.
//
// `resolveGatedRerankOptions` is the fix: it always routes through `gatedRerankOptionsFromConfig`
// (the function `retrieval-runtime.ts` calls at boot), so a cosine-mode config measures the cosine
// gate and a zMargin-mode config measures the zMargin gate — whichever a deployment reading that
// config would run. `GATED_HARD_Z` keeps working as a threshold-sweep convenience, but ONLY in
// zMargin mode, since `gatedRerankOptionsFromConfig`'s contract is to emit EXACTLY one knob — a
// cosine-mode config with a stray `GATED_HARD_Z` must not silently smuggle a second, unreachable
// knob back in.
import { describe, expect, it } from "vitest";
import { resolveGatedRerankOptions } from "../eval/run";

describe("resolveGatedRerankOptions (THE-806 step 2)", () => {
  it("no hardness block (fixture default): reproduces the schema default — cosine@0.55, pool 20", () => {
    expect(resolveGatedRerankOptions(undefined, undefined)).toEqual({
      enabled: true,
      pool: 20,
      hardTop1: 0.55,
    });
  });

  it("cosine-mode config: emits hardTop1 only, ignoring a stray GATED_HARD_Z override", () => {
    const opts = resolveGatedRerankOptions(
      { mode: "cosine", hardTop1: 0.55, hardZ: 1.0, pool: 20 },
      2.5,
    );
    expect(opts).toEqual({ enabled: true, pool: 20, hardTop1: 0.55 });
  });

  it("zMargin-mode config: emits hardZ from the config when no override is given", () => {
    const opts = resolveGatedRerankOptions(
      { mode: "zMargin", hardTop1: 0.55, hardZ: 1.0, pool: 20 },
      undefined,
    );
    expect(opts).toEqual({ enabled: true, pool: 20, hardZ: 1.0 });
  });

  it("zMargin-mode config: GATED_HARD_Z overrides the configured threshold for a sweep", () => {
    const opts = resolveGatedRerankOptions(
      { mode: "zMargin", hardTop1: 0.55, hardZ: 1.0, pool: 20 },
      1.5,
    );
    expect(opts).toEqual({ enabled: true, pool: 20, hardZ: 1.5 });
  });
});
