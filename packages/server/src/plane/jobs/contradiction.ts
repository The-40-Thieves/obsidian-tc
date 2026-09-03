// Contradiction detector — THE-233 W-WORKERS, ports KMS ingest/contradictions.ts onto the
// plane. Anthropic judge -> gateway `judge` role; the Supabase neighbor RPC -> semanticSearch
// (sqlite-vec or brute-force). Hook-driven: integration wires it to the W-INGEST onIndexed
// enqueue. For each freshly-indexed chunk, find semantic neighbors in [COSINE_THRESHOLD,
// NEAR_DUPE_CEILING), ask the judge whether the pair conflicts, and flag it. Flag-only: a
// judge or parse failure never throws; pairs are deduped by canonical content-sha ordering.
import { z } from "zod";
import type { Database } from "../../db/types";
import { semanticSearch } from "../../search/semantic";
import { blobToFloats } from "../../search/vec";
import { contentHash } from "../../vault/paths";
import { type EgressFilter, isExcludedPath } from "../egress-filter";
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

/**
 * THE-571: re-read a chunk (with its active embedding) at job RUN time.
 *
 * The contradiction job used to carry the whole chunk in `jobs.payload`, which meant JSON-encoding a
 * dense vector into a queue row on every enqueue — on a table that, before this ticket, was never
 * pruned. The payload is now `{ vaultId, chunkId }` and this reads the rest back: a single indexed
 * lookup, cheaper than the embedding it replaces.
 *
 * Re-reading also fixes a staleness bug the size problem was hiding. A payload-embedded vector is a
 * snapshot from enqueue time, so a chunk re-embedded before the job ran would be judged on its OLD
 * vector. Reading at run time always judges what is actually stored.
 *
 * Returns null when the chunk is gone or has no active embedding — deleted or re-embedded between
 * enqueue and run. That is a normal race, NOT a failure: callers must skip, because throwing is how
 * the runner dead-letters, and dead-lettering a job for doing its work correctly is worse than the
 * unbounded growth this ticket set out to fix.
 */
export function loadChunkForContradiction(
  db: Database,
  vaultId: string,
  chunkId: string,
): IndexedChunk | null {
  const row = db
    .prepare(
      `SELECT c.id AS id, c.path AS path, c.content AS content, e.embedding AS embedding
       FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1
       WHERE c.id = ? AND c.vault_id = ?`,
    )
    .get(chunkId, vaultId) as
    | { id: string; path: string; content: string; embedding: Uint8Array }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    content: row.content,
    embedding: [...blobToFloats(row.embedding)],
  };
}

/** THE-457: group a drained contradiction queue by vault, deduplicating chunks by (vault, id) so a
 *  chunk re-enqueued by several rapid re-indexes in one drain window is judged once. Pure helper —
 *  the caller owns the bounded, single-flight drain loop and calls checkContradictions per group. */
const verdictSchema = z.object({
  kind: z.enum(["contradiction", "tension", "no_conflict"]),
  rationale: z.string().min(1),
});
export type Verdict = z.infer<typeof verdictSchema>;

const JUDGE_SYSTEM = `You judge whether two text fragments from the same knowledge base conflict. Reply ONLY with a single JSON object on one line: {"kind":"contradiction"|"tension"|"no_conflict","rationale":"<one sentence>"}. No prose before or after. contradiction = one fragment factually negates the other. tension = substantive disagreement on framing, emphasis, or recommendation. no_conflict = compatible, complementary, or unrelated.`;

/** Parse a judge response into a Verdict, or NULL when it cannot be parsed.
 *
 *  THE-613: this used to fall back to `{ kind: "no_conflict", rationale: "judge_parse_error" }`.
 *  That encodes a FAILURE as a legitimate domain value — "the judge cleared this pair" and "the
 *  judge never answered" became the same object, and since Phase 3 skips every `no_conflict`, the
 *  rationale was then discarded entirely. Returning null keeps the two distinguishable at the one
 *  place that can still tell them apart. */
export function parseVerdict(text: string): Verdict | null {
  try {
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    return verdictSchema.parse(JSON.parse(stripped));
  } catch {
    return null;
  }
}

export interface ContradictionStats {
  checked: number;
  flagged: number;
  skipped: number;
  /** THE-613: pairs the judge could not rule on — call threw, OR the reply did not parse.
   *  NOT the same as a pair judged `no_conflict`. Without this a total gateway outage returned
   *  `{ checked: N, flagged: 0, skipped: 0 }`, byte-identical to a healthy run over a vault with
   *  no contradictions, and the caller had no way to tell "examined and clear" from "never asked".
   *
   *  Stays the TOTAL. `judgeErrors` below is the transport subset, so unparseable = unjudged -
   *  judgeErrors. That is deliberately the OPPOSITE split from citation.ts, where `parseFailures`
   *  was narrowed instead of a total being kept: there the field was NAMED for parsing, so
   *  narrowing made the name true. Here `unjudged` is correctly named for the total and narrowing
   *  it would make the name a lie. Same defect, different fix, because the names differ. */
  unjudged: number;
  /** THE-613 follow-up: of `unjudged`, the pairs where the judge NEVER ANSWERED — the call threw
   *  (transport, HTTP, timeout) — as distinct from answering unparseably. Opposite remedies: an
   *  endpoint or a credential, versus a prompt or a model.
   *
   *  Not hypothetical, and it is the same outage that produced the citation-side version of this:
   *  the gateway `judge` role — which this pass shares — returned HTTP 404 from 2026-08-03 to
   *  2026-08-06 after the Modal workspace was disabled for exhausted credit. Every pair in that
   *  window would have landed in `unjudged` and read as a model that cannot emit JSON. */
  judgeErrors: number;
}

export async function checkContradictions(
  ctx: {
    db: Database;
    roles: GatewayRoles | null;
    now: () => number;
    model?: string;
    /** THE-934: egress.excludePaths, compiled. Absent -> nothing excluded (back-compat). A pair
     *  with either side under an excluded path is dropped BEFORE the judge call — never
     *  candidate-counted, never sent. */
    excludeFilter?: EgressFilter;
  },
  vaultId: string,
  chunks: IndexedChunk[],
): Promise<ContradictionStats> {
  const stats: ContradictionStats = {
    checked: 0,
    flagged: 0,
    skipped: 0,
    unjudged: 0,
    judgeErrors: 0,
  };
  if (!ctx.roles) return stats; // generative disabled -> nothing to judge
  const excludeFilter = ctx.excludeFilter;
  const excluded = (path: string): boolean =>
    excludeFilter !== undefined && isExcludedPath(excludeFilter, path);
  const insert = ctx.db.prepare(
    "INSERT OR IGNORE INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, cosine_similarity, judge_verdict, judge_rationale, judge_model, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
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
    // THE-934: the chunk being judged is never itself under an excluded path in production (an
    // excluded chunk is never embedded, so it never reaches semanticSearch or fires onIndexed —
    // see search/indexing/embed-batches.ts). Checked here anyway as the chokepoint's own
    // enforcement, not merely a consequence of the index-time side effect.
    if (excluded(chunk.path)) {
      stats.skipped += 1;
      continue;
    }
    const neighbors = semanticSearch(ctx.db, vaultId, chunk.embedding, {
      k: TOP_K + 1,
      returnContent: true,
      ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    }).filter(
      (n) =>
        n.chunk_id !== chunk.id &&
        n.score >= COSINE_THRESHOLD &&
        n.score < NEAR_DUPE_CEILING &&
        // THE-934: a pair with an excluded neighbor is dropped wholesale, not merely un-judged —
        // it must never reach the tasks list a judge request is built from.
        !excluded(n.path),
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
  // single pair's judge failure yields a NULL verdict so it never sinks the whole batch — the other
  // pairs are still judged and their verdicts still applied.
  //
  // THE-613: null, not `no_conflict`. Encoding the failure as a clean verdict made a gateway outage
  // indistinguishable from a vault with nothing to flag, and Phase 3 then dropped the rationale on
  // the floor. Null is counted as `unjudged` below and reaches the caller.
  const verdicts = await mapLimit(tasks, JUDGE_CONCURRENCY, async (t) => {
    try {
      const res = await roles.judge({
        ...prompt(
          JUDGE_SYSTEM,
          `FRAGMENT A:\n${t.chunk.content}\n\nFRAGMENT B:\n${t.neighborContent}`,
        ),
        // THE-934: the egress guard's defence-in-depth check reads this — both fragments' paths,
        // already filtered above, are declared so a future change to the filtering logic above
        // (not this line) is what the guard exists to catch.
        sourcePaths: [t.chunk.path, t.neighborPath],
      });
      // `threw: false` even when parseVerdict returns null — the judge ANSWERED, its reply was
      // just unusable. This is the only place that can still tell the two apart.
      return { verdict: parseVerdict(res.text), model: res.model, threw: false };
    } catch {
      return { verdict: null, model: "", threw: true };
    }
  });
  // Phase 3 — apply inserts serially (single-connection writes), in task order.
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] as JudgeTask;
    const { verdict, model, threw } = verdicts[i] as {
      verdict: Verdict | null;
      model: string;
      threw: boolean;
    };
    // THE-613: could-not-judge is counted, not silently treated as clear. Both still `continue` —
    // an unjudged pair writes no row, exactly as before — but the COUNT now leaves the function.
    // The follow-up adds WHICH kind: `unjudged` stays the total and `judgeErrors` is the transport
    // subset, so an operator can tell "the endpoint is down" from "the model is babbling" without
    // reading logs. Both remedies are real and they point in opposite directions.
    if (verdict === null) {
      stats.unjudged += 1;
      if (threw) stats.judgeErrors += 1;
      continue;
    }
    if (verdict.kind === "no_conflict") continue;
    const a = { id: t.chunk.id, path: t.chunk.path, sha: contentHash(t.chunk.content) };
    const b = { id: t.neighborId, path: t.neighborPath, sha: contentHash(t.neighborContent) };
    const [src, con] = a.sha < b.sha ? [a, b] : [b, a]; // canonical order for dedup
    const id = `ctr_${contentHash(`${vaultId}:${src.sha}:${con.sha}`).slice(0, 24)}`;
    const info = insert.run(
      id,
      vaultId,
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
