// THE-693 — thread config.retrieval.graphStream through M7Deps.retrieval into GraphSearchOptions.
//
// The ticket said enabling the hub defence was "a config flag plus an eval run, not an
// implementation". That was false, and the way it was false is the exact defect the ticket is
// about. `graphStream` is read by graph_expansion.ts (`gsEnabled`, `hubDegreeCap`, `perSeedCap`,
// `expansionSeeds`) but had **zero production assignments** — the only code that ever set it was
// eval/run.ts. It was absent from the config schema too, and `config validate` ACCEPTED
// `retrieval.graphStream.enabled = true` with exit 0 while the key reached nothing. Writing it
// would have produced a config that says "on", a doctor that says nothing, and retrieval entirely
// unchanged: shipped, reachable, tested, never actually running — the THE-692/THE-693 family.
//
// These assert at `buildGraphSearchOptions`, the seam where deps become search options. That is
// deliberately NOT an end-to-end dispatch test: the hub cap's *behaviour* is already evidenced at
// n=250 (202 of 250 queries differ under --graph-stream), so what is unproven and worth pinning is
// that CONFIG reaches that lever at all. A dispatch-level test would also have to thread a needle
// between seed selection and the expansion similarity gate to make the cap observable, and a
// fixture that subtle is one whose failure mode is "proves nothing, quietly".
import { describe, expect, it } from "vitest";
import type { M7Deps } from "../src/tools/m7/knowledge/deps";
import { buildGraphSearchOptions } from "../src/tools/m7/knowledge/retrieval-runtime";

const deps = (retrieval?: M7Deps["retrieval"]): M7Deps =>
  ({
    embeddingProvider: { id: "test:embed" },
    ...(retrieval ? { retrieval } : {}),
  }) as unknown as M7Deps;

const site = {
  route: { class: "standard" },
  query: "zebra keyword",
  vaultId: "main",
  finalTopK: 10,
};

const optsFor = (retrieval?: M7Deps["retrieval"]) =>
  buildGraphSearchOptions(deps(retrieval), site as never) as Record<string, unknown>;

describe("THE-693 — retrieval.graphStream config wiring", () => {
  it("omits graphStream entirely when retrieval is unset", () => {
    expect("graphStream" in optsFor()).toBe(false);
  });

  it("omits it when explicitly disabled — byte-identical to today", () => {
    expect("graphStream" in optsFor({ graphStream: { enabled: false } })).toBe(false);
    // The whole options object must be unchanged, not merely missing that one key: a threading
    // that reordered or dropped a sibling would be a silent regression on every query.
    expect(optsFor({ graphStream: { enabled: false } })).toStrictEqual(optsFor());
  });

  it("passes graphStream through when enabled", () => {
    expect(optsFor({ graphStream: { enabled: true } }).graphStream).toStrictEqual({
      enabled: true,
    });
  });

  it("carries the NESTED tuning values, not just the enabled bit", () => {
    // The failure mode this pins: passing `{ enabled: true }` while hubDegreeCap / perSeedCap /
    // expansionSeeds silently fall back to defaults, so an operator who tunes the cap gets 40
    // regardless and has no way to tell.
    expect(
      optsFor({
        graphStream: { enabled: true, hubDegreeCap: 12, perSeedCap: 2, expansionSeeds: 5 },
      }).graphStream,
    ).toStrictEqual({ enabled: true, hubDegreeCap: 12, perSeedCap: 2, expansionSeeds: 5 });
  });

  it("does not disturb its sibling retrieval options", () => {
    const o = optsFor({
      graphStream: { enabled: true },
      rrfK: 42,
      adaptiveRrf: { enabled: true, gain: 0.3 },
    });
    expect(o.rrfK).toBe(42);
    expect(o.adaptiveRrf).toStrictEqual({ enabled: true, gain: 0.3 });
  });
});
