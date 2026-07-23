export interface Scenario {
  name: "small" | "medium" | "large" | "vault1k" | "vault100k";
  seed: number;
  notes: number; // number of source notes
  dupGroups: number; // notes reused verbatim from this many distinct bodies
  linkFanout: number; // outbound [[wikilinks]] per note (drives the graph)
  paragraphs: number; // paragraphs per note (roughly one chunk each)
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
