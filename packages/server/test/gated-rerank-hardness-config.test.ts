// THE-806 — the eval harness and production ran DIFFERENT gatedRerank hardness rules.
//
// `rerank_stage.ts` selects the rule by presence:
//   hardZ !== undefined  ->  zMargin < hardZ        (z-margin, model-agnostic)
//   otherwise            ->  top1  < hardTop1 ?? .55 (absolute cosine, model-specific)
//
// Production built `{ enabled: true }` — neither knob set — so it ALWAYS took the cosine branch.
// `eval/run.ts` built `{ enabled: true, hardZ: hardZ ?? 1.0 }` — so it ALWAYS took the z-margin
// one. Neither could reach the other's rule, which means any golden-set result for
// `--gated-rerank` measured a gate production cannot execute (the THE-699 shape).
//
// These tests pin the two properties that make the arms comparable, and the one that must NOT
// change yet: the shipped default still reproduces the old production behaviour byte for byte.
// Flipping the default is a ranking change and owes the n=250 paired permutation gate.

import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { gatedRerankOptionsFromConfig } from "../src/search/graph_search_stages/rerank_stage";

/** The shipped defaults, read from the schema rather than retyped — a hand-copied literal here
 *  would keep passing after someone changed the schema, which is the failure this guards. */
function defaultHardness() {
  const parsed = ServerConfigSchema.parse({
    vaults: [{ id: "v", path: "/tmp/v" }],
  });
  return parsed.retrieval.gatedRerankHardness;
}

describe("THE-806 — gatedRerank hardness is reachable from config", () => {
  it("defaults reproduce the OLD production behaviour exactly", () => {
    // Before this change production sent `{ enabled: true }` and rerank_stage fell back to
    // `hardTop1 ?? 0.55` / `pool ?? 20`. The defaults must land on the same effective gate, or
    // this "config surface" PR silently shipped a ranking change.
    const opts = gatedRerankOptionsFromConfig(defaultHardness());
    expect(opts).toEqual({ enabled: true, pool: 20, hardTop1: 0.55 });
    // The discriminator rerank_stage keys on. Undefined here IS the cosine branch.
    expect(opts.hardZ).toBeUndefined();
  });

  it("zMargin mode emits hardZ, which is what selects the other branch", () => {
    const opts = gatedRerankOptionsFromConfig({
      mode: "zMargin",
      hardTop1: 0.55,
      hardZ: 1.0,
      pool: 20,
    });
    expect(opts).toEqual({ enabled: true, pool: 20, hardZ: 1.0 });
    // 1.0 is the harness's long-standing default, so this is now constructible in production —
    // the whole point of the ticket.
    expect(opts.hardTop1).toBeUndefined();
  });

  it("emits exactly ONE knob, never both", () => {
    // rerank_stage keys on `hardZ !== undefined`, so emitting both would make hardTop1 silently
    // unreachable — a config value that reads as tuning and changes nothing. Whichever mode is
    // chosen, the other knob must be absent rather than merely ignored.
    for (const mode of ["cosine", "zMargin"] as const) {
      const opts = gatedRerankOptionsFromConfig({ mode, hardTop1: 0.4, hardZ: 2.0, pool: 5 });
      const present = [opts.hardTop1, opts.hardZ].filter((v) => v !== undefined);
      expect(present).toHaveLength(1);
    }
  });

  it("carries pool through, so tuning it is not silently dropped", () => {
    // The THE-693 lesson applied to this block: `graphStream` had to be passed WHOLE because
    // passing only `enabled` gave an operator who tuned the cap the default anyway.
    const opts = gatedRerankOptionsFromConfig({
      mode: "cosine",
      hardTop1: 0.31,
      hardZ: 1.0,
      pool: 7,
    });
    expect(opts.pool).toBe(7);
    expect(opts.hardTop1).toBe(0.31);
  });

  it("the no-config fallback equals the SCHEMA's defaults — two sources that cannot drift", () => {
    // `deps.retrieval.gatedRerankHardness` is optional (fixtures omit it), so the builder carries
    // its own fallback. That is a second declaration of "the default gate", and a second
    // declaration is how defaults silently disagree. This pins them together: change one without
    // the other and this fails.
    expect(gatedRerankOptionsFromConfig(undefined)).toEqual(
      gatedRerankOptionsFromConfig(defaultHardness()),
    );
  });

  it("the schema accepts a zMargin config end to end", () => {
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "v", path: "/tmp/v" }],
      retrieval: { gatedRerank: true, gatedRerankHardness: { mode: "zMargin", hardZ: 1.25 } },
    });
    expect(parsed.retrieval.gatedRerank).toBe(true);
    expect(gatedRerankOptionsFromConfig(parsed.retrieval.gatedRerankHardness)).toEqual({
      enabled: true,
      pool: 20,
      hardZ: 1.25,
    });
  });
});
