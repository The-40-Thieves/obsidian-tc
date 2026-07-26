export interface Scenario {
  name: "small" | "medium" | "large" | "vault1k" | "vault100k" | "densify";
  seed: number;
  notes: number; // number of source notes
  dupGroups: number; // notes reused verbatim from this many distinct bodies
  linkFanout: number; // outbound [[wikilinks]] per note (drives the graph)
  paragraphs: number; // paragraphs per note (roughly one chunk each)
  /** THE-581: run the graph densification pass during indexVault. Densification is opt-in and OFF
   *  by default, which is exactly why the harness never exercised it: `buildVault` called
   *  indexVault with no `densify` option, so no scenario ever ran the pass and no collector could
   *  see it. A `densify` AXIS rather than a change to the existing scenarios — `small`'s committed
   *  baseline must keep meaning what it meant, so this is new coverage, not a redefinition. */
  densify?: { tagEdges: boolean; knnEdges: boolean };
  // THE-503 Part 2 (scale scenarios): each note yields exactly 2 chunks (one body section, one
  // links section — see harness.ts), so notes*2 is the target chunk count. `expensive` scenarios
  // are NOT part of the default CI-gated set (only `small` has a committed baseline/CI gate
  // today) and are not run automatically by any `perf*` script — they exist for deliberate,
  // manual/nightly use where their cost is acceptable. See eval/perf/README.md for measured
  // single-run timings.
  expensive?: boolean;
}

export const SCENARIOS: Record<Scenario["name"], Scenario> = {
  small: { name: "small", seed: 0x5eed, notes: 100, dupGroups: 20, linkFanout: 3, paragraphs: 2 }, // 200 chunks
  // THE-581: `small`'s corpus shape EXACTLY, plus the densification pass. Sharing the corpus is
  // deliberate — holding notes/dupGroups/linkFanout/paragraphs/seed identical to `small` means any
  // difference between the two scenarios' shared metrics is attributable to densification and
  // nothing else. Both edge kinds are on: they have different cost shapes (tag co-occurrence is
  // a join over note tags; kNN is the per-chunk vec0 scan THE-486/THE-533 bound), and a scenario
  // that enabled only one would leave the other in the same unmeasured state this ticket exists
  // to end.
  densify: {
    name: "densify",
    seed: 0x5eed,
    notes: 100,
    dupGroups: 20,
    linkFanout: 3,
    paragraphs: 2,
    densify: { tagEdges: true, knnEdges: true },
  }, // 200 chunks, densification ON
  // THE-503 Part 2: the "1K chunk vault" tier named explicitly in the ticket, sitting between
  // small (200 chunks, dev-fast) and medium (2000 chunks).
  vault1k: {
    name: "vault1k",
    seed: 0x5eed,
    notes: 500,
    dupGroups: 100,
    linkFanout: 3,
    paragraphs: 2,
  }, // 1,000 chunks
  medium: {
    name: "medium",
    seed: 0x5eed,
    notes: 1000,
    dupGroups: 200,
    linkFanout: 4,
    paragraphs: 3,
  }, // 2,000 chunks
  // THE-503: previously 3400 notes (~6.8k chunks) despite being documented as "~10k chunks" —
  // bumped to actually land on the "10K chunk vault" tier the ticket names. Not CI-baselined
  // (no committed baseline.large.json), so nothing depends on the old exact numbers.
  large: {
    name: "large",
    seed: 0x5eed,
    notes: 5000,
    dupGroups: 1000,
    linkFanout: 4,
    paragraphs: 3,
  }, // 10,000 chunks
  // THE-503 Part 2: the "100K chunk vault" tier. Measured cost scales super-linearly with corpus
  // size (10k chunks ≈ 2 minutes single-shot on the reference dev host — see README.md), so a
  // single run here is expected to take on the order of tens of minutes, and the 5-sample
  // isolated mode proportionally longer still. Deliberately `expensive: true` and excluded from
  // every default script; run manually (`bun eval/perf/run.ts --scenario vault100k --out ...`)
  // when a 100K-chunk data point is actually needed for a THE-467/THE-468 decision, ideally on a
  // dedicated (not shared) host given how sensitive this harness is to contention.
  vault100k: {
    name: "vault100k",
    seed: 0x5eed,
    notes: 50_000,
    dupGroups: 10_000,
    linkFanout: 4,
    paragraphs: 3,
    expensive: true,
  }, // 100,000 chunks
};
