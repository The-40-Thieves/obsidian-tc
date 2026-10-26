import type { ResponseFormat } from "@the-40-thieves/obsidian-tc-shared";

// THE-251 / GH #1027: the concise projection (formerly verbosity=terse) — collapse each hit to
// path + score + snippet + chunk_id (whichever are present), dropping heavy per-hit fields
// (line/col/content) to cut agent prompt cost. chunk_id stays: record_retrieval_feedback needs it
// (GH #1219). The shipped default stays "detailed".
export function projectHits(
  items: ReadonlyArray<{ path: string; score?: number; snippet?: string; chunk_id?: string }>,
  format: ResponseFormat,
): unknown[] {
  if (format !== "concise") return items as unknown[];
  return items.map((h) => {
    const out: { path: string; score?: number; snippet?: string; chunk_id?: string } = {
      path: h.path,
    };
    if (h.score !== undefined) out.score = h.score;
    if (h.snippet !== undefined) out.snippet = h.snippet;
    if (h.chunk_id !== undefined) out.chunk_id = h.chunk_id;
    return out;
  });
}
