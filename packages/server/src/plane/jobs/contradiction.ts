// Contradiction detector — THE-233 W-WORKERS, ports KMS ingest/contradictions.ts onto the
// plane. Anthropic judge -> gateway `judge` role; the Supabase neighbor RPC -> semanticSearch
// (sqlite-vec or brute-force). Hook-driven: integration wires it to the W-INGEST onIndexed
// enqueue. For each freshly-indexed chunk, find semantic neighbors in [COSINE_THRESHOLD,
// NEAR_DUPE_CEILING), ask the judge whether the pair conflicts, and flag it. Flag-only: a
// judge or parse failure never throws; pairs are deduped by canonical content-sha ordering.
import { z } from "zod";
import type { Database } from "../../db/types";
import { semanticSearch } from "../../search/semantic";
import { contentHash } from "../../vault/paths";
import { type GatewayRoles, prompt } from "../gateway";

const COSINE_THRESHOLD = 0.85;
const NEAR_DUPE_CEILING = 0.99;
const TOP_K = 5;

export interface IndexedChunk {
  id: string;
  path: string;
  content: string;
  embedding: number[];
}

const verdictSchema = z.object({
  kind: z.enum(["contradiction", "tension", "no_conflict"]),
  rationale: z.string().min(1),
});
export type Verdict = z.infer<typeof verdictSchema>;

const JUDGE_SYSTEM = `You judge whether two text fragments from the same knowledge base conflict. Reply ONLY with a single JSON object on one line: {"kind":"contradiction"|"tension"|"no_conflict","rationale":"<one sentence>"}. No prose before or after. contradiction = one fragment factually negates the other. tension = substantive disagreement on framing, emphasis, or recommendation. no_conflict = compatible, complementary, or unrelated.`;

/** Parse a judge response into a Verdict, falling back to no_conflict on any error. */
export function parseVerdict(text: string): Verdict {
  try {
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    return verdictSchema.parse(JSON.parse(stripped));
  } catch {
    return { kind: "no_conflict", rationale: "judge_parse_error" };
  }
}

export interface ContradictionStats {
  checked: number;
  flagged: number;
  skipped: number;
}

export async function checkContradictions(
  ctx: { db: Database; roles: GatewayRoles | null; now: () => number },
  vaultId: string,
  chunks: IndexedChunk[],
): Promise<ContradictionStats> {
  const stats: ContradictionStats = { checked: 0, flagged: 0, skipped: 0 };
  if (!ctx.roles) return stats; // generative disabled -> nothing to judge
  const insert = ctx.db.prepare(
    "INSERT OR IGNORE INTO contradictions (id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, cosine_similarity, judge_verdict, judge_rationale, judge_model, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
  );
  for (const chunk of chunks) {
    stats.checked += 1;
    const neighbors = semanticSearch(ctx.db, vaultId, chunk.embedding, {
      k: TOP_K + 1,
      returnContent: true,
    }).filter(
      (n) => n.chunk_id !== chunk.id && n.score >= COSINE_THRESHOLD && n.score < NEAR_DUPE_CEILING,
    );
    if (neighbors.length === 0) {
      stats.skipped += 1;
      continue;
    }
    for (const n of neighbors) {
      const res = await ctx.roles.judge(
        prompt(JUDGE_SYSTEM, `FRAGMENT A:\n${chunk.content}\n\nFRAGMENT B:\n${n.content ?? ""}`),
      );
      const verdict = parseVerdict(res.text);
      if (verdict.kind === "no_conflict") continue;
      const a = { id: chunk.id, path: chunk.path, sha: contentHash(chunk.content) };
      const b = { id: n.chunk_id, path: n.path, sha: contentHash(n.content ?? "") };
      const [src, con] = a.sha < b.sha ? [a, b] : [b, a]; // canonical order for dedup
      const id = `ctr_${contentHash(`${src.sha}:${con.sha}`).slice(0, 24)}`;
      const info = insert.run(
        id,
        src.id,
        src.path,
        con.id,
        con.path,
        src.sha,
        con.sha,
        n.score,
        verdict.kind,
        verdict.rationale,
        res.model,
        ctx.now(),
      );
      if (info.changes > 0) stats.flagged += 1;
      else stats.skipped += 1;
    }
  }
  return stats;
}
