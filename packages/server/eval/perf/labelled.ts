/** In-repo, throwaway synthetic relevance set. NOT the private golden set (THE-421 leak class):
 *  these queries + paths are generated from the same seeded corpus and carry no real vault data.
 *  Populated to match SCENARIOS.small's note-<n>.md paths; relevance = notes sharing the query's
 *  body pool index. */
export interface LabelledQuery {
  query: string;
  relevantPaths: string[];
}

/** For the small scenario: dupGroups=20, notes=100, so body i backs notes i, i+20, i+40, i+60, i+80. */
export const LABELLED: LabelledQuery[] = [0, 1, 2, 3, 4].map((i) => ({
  query: `Body ${i}`,
  relevantPaths: [i, i + 20, i + 40, i + 60, i + 80].map((n) => `note-${n}.md`),
}));
