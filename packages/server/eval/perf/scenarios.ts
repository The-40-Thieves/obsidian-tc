export interface Scenario {
  name: "small" | "medium" | "large";
  seed: number;
  notes: number; // number of source notes
  dupGroups: number; // notes reused verbatim from this many distinct bodies
  linkFanout: number; // outbound [[wikilinks]] per note (drives the graph)
  paragraphs: number; // paragraphs per note (roughly one chunk each)
}

export const SCENARIOS: Record<Scenario["name"], Scenario> = {
  small: { name: "small", seed: 0x5eed, notes: 100, dupGroups: 20, linkFanout: 3, paragraphs: 2 },
  medium: {
    name: "medium",
    seed: 0x5eed,
    notes: 1000,
    dupGroups: 200,
    linkFanout: 4,
    paragraphs: 3,
  },
  large: {
    name: "large",
    seed: 0x5eed,
    notes: 3400,
    dupGroups: 400,
    linkFanout: 4,
    paragraphs: 3,
  }, // ~10k chunks
};
