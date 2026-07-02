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
const JUDGE_CONCURRENCY = 4;

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
  const roles = ctx.roles;
  // Phase 1 — gather judge tasks with NO network I/O. semanticSearch is a local (sqlite-vec or
  // brute-force) read, so neighbor discovery stays serial on the single connection.
  interface JudgeTask {
    chunk: IndexedChunk;
    neighborId: string;
    neighborPath: string;
    neighborContent: string;
    score: number;
  }
  const tasks: JudgeTask[] = [];
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
    for (const n of neighbors)
      tasks.push({
        chunk,
        neighborId: n.chunk_id,
        neighborPath: n.path,
        neighborContent: n.content ?? "",
        score: n.score,
      });
  }
  // Phase 2 — judge all pairs under bounded concurrency (THE-277). The judge is the only network
  // call; running JUDGE_CONCURRENCY at a time turns a serial per-pair wait into a windowed one. A
  // single pair's judge failure degrades to no_conflict so it never sinks the whole batch.
  const verdicts = await mapLimit(tasks, JUDGE_CONCURRENCY, async (t) => {
    try {
      const res = await roles.judge(
        prompt(
          JUDGE_SYSTEM,
          `FRAGMENT A:\n${t.chunk.content}\n\nFRAGMENT B:\n${t.neighborContent}`,
        ),
      );
      return { verdict: parseVerdict(res.text), model: res.model };
    } catch {
      return { verdict: { kind: "no_conflict", rationale: "judge_error" } as Verdict, model: "" };
    }
  });
  // Phase 3 — apply inserts serially (single-connection writes), in task order.
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] as JudgeTask;
    const { verdict, model } = verdicts[i] as { verdict: Verdict; model: string };
    if (verdict.kind === "no_conflict") continue;
    const a = { id: t.chunk.id, path: t.chunk.path, sha: contentHash(t.chunk.content) };
    const b = { id: t.neighborId, path: t.neighborPath, sha: contentHash(t.neighborContent) };
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
      t.score,
      verdict.kind,
      verdict.rationale,
      model,
      ctx.now(),
    );
    if (info.changes > 0) stats.flagged += 1;
    else stats.skipped += 1;
  }
  return stats;
}

// Bounded-concurrency ordered map: runs `fn` over `items` with at most `limit` in flight and
// returns results in input order. Windows the contradiction judge calls (THE-277).
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
