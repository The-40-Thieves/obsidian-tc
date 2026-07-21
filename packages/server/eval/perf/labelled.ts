/** In-repo, throwaway synthetic relevance set. NOT the private golden set (THE-421 leak class):
 *  these queries + paths are generated from the same seeded corpus and carry no real vault data.
 *  Populated to match SCENARIOS.small's note-<n>.md paths; relevance = notes sharing the query's
 *  body pool index.
 *
 *  THE-459: the query used to be the literal heading text `Body ${i}`, but every body in the
 *  corpus (see harness.ts buildVault) shares the word "body" plus random words drawn from the
 *  same tiny WORDS vocabulary, so body group i was never lexically/semantically distinguishable
 *  from any other group -> recall_at10/ndcg_at10 measured 0 (a dead family-9 gate). The query is
 *  now the distinctive `zqmarker${i}` sentinel that harness.ts injects into group i's body
 *  (function of the group index only, so all notes in the group stay byte-identical). */
export interface LabelledQuery {
  query: string;
  relevantPaths: string[];
}

/** For the small scenario: dupGroups=20, notes=100, so body i backs notes i, i+20, i+40, i+60, i+80. */
export const LABELLED: LabelledQuery[] = [0, 1, 2, 3, 4].map((i) => ({
  query: `zqmarker${i}`,
  relevantPaths: [i, i + 20, i + 40, i + 60, i + 80].map((n) => `note-${n}.md`),
}));
