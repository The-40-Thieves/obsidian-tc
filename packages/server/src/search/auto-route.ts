// retrieval.searchAutoRoute: how `search_vault`'s `auto` mode decides between its text leg and its
// semantic leg for a string query.
//
// `text-first` (the default, and the only behaviour before this module existed) runs the literal
// text leg and falls back to the semantic leg ONLY when text matched nothing. Any text hit, however
// irrelevant, therefore blocks the fallback — a note that quotes the query verbatim hides the note
// that answers it. The two candidates run the semantic leg on more queries and fuse the legs by
// per-note reciprocal rank (the repo's RRF, `fuseEpisodeRanks`). Both ship dark: the evidence bar
// (ADR-0007 class c) is not met, see the ADR's status section.
import { fuseEpisodeRanks } from "../experiential/episode-search";

export type AutoRoute = "text-first" | "weak-text" | "hybrid";

/** One fused note. `mode_used` is "hybrid"; `snippet`/`line` come from the text leg's best line for
 *  the note and `chunk_id` from the semantic leg's best chunk, each only when that leg returned it. */
export interface FusedHit {
  path: string;
  score: number;
  mode_used: "hybrid";
  snippet?: string;
  line?: number;
  chunk_id?: string;
}

interface LegHit {
  path: string;
  snippet?: string;
  line?: number;
  chunk_id?: string;
}

/** The M2 dependency for a configured route: nothing for the default, so `text-first` never enters
 *  the fusion path and `search_vault` stays byte-identical. */
export function autoRouteDep(route: AutoRoute): { autoRoute?: AutoRoute } {
  return route === "text-first" ? {} : { autoRoute: route };
}

/** Whether `auto` should also run the semantic leg, given how many DISTINCT notes the text leg
 *  matched. `text-first` is today's rule (zero notes); `weak-text` treats a single-note literal hit
 *  as weak evidence; `hybrid` always runs it. */
export function autoNeedsSemanticLeg(route: AutoRoute, textNotes: number): boolean {
  switch (route) {
    case "hybrid":
      return true;
    case "weak-text":
      return textNotes <= 1;
    default:
      return textNotes === 0;
  }
}

/** Reciprocal-rank fusion of the text leg and the semantic leg over distinct notes. Each leg ranks a
 *  note by its first (best) hit; a note in both legs outranks a note in one; ties break by path
 *  (`fuseEpisodeRanks`). With an empty text leg this is the semantic order, deduped by note. */
export function fuseTextAndSemantic(
  text: readonly LegHit[],
  semantic: readonly LegHit[],
  rrfK: number,
): FusedHit[] {
  const firstByPath = (hits: readonly LegHit[]): Map<string, LegHit> => {
    const m = new Map<string, LegHit>();
    for (const h of hits) if (!m.has(h.path)) m.set(h.path, h);
    return m;
  };
  const t = firstByPath(text);
  const s = firstByPath(semantic);
  const rankOf = (m: Map<string, LegHit>): Map<string, number> =>
    new Map([...m.keys()].map((path, i) => [path, i + 1]));
  const tRank = rankOf(t);
  const sRank = rankOf(s);
  const rrf = (ranks: Map<string, number>, path: string): number => {
    const r = ranks.get(path);
    return r === undefined ? 0 : 1 / (rrfK + r);
  };
  return fuseEpisodeRanks([[...t.keys()], [...s.keys()]], rrfK).map((path) => {
    const th = t.get(path);
    const sh = s.get(path);
    return {
      path,
      // A rank-reciprocal sum, not a similarity: comparable only within this result.
      score: rrf(tRank, path) + rrf(sRank, path),
      mode_used: "hybrid" as const,
      ...(th?.snippet !== undefined ? { snippet: th.snippet } : {}),
      ...(th?.line !== undefined ? { line: th.line } : {}),
      ...(sh?.chunk_id !== undefined ? { chunk_id: sh.chunk_id } : {}),
    };
  });
}
