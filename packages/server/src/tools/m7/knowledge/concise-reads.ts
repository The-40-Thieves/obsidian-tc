// GH #1027 part 4: the concise form of the knowledge read tools that are not searches
// (vault_context, explain_answer, diagnose_retrieval, knowledge_get_critical), so "what concise
// keeps" has one definition per tool. Every function only REMOVES fields from the detailed payload;
// none adds or rewrites one. What each keeps is stated beside it; the advertised schemas
// (`Conciseable*` in schemas.ts) mark exactly the dropped fields optional.
import type { z } from "zod";
import type {
  DiagnoseRetrievalOutput,
  ExplainAnswerOutput,
  KnowledgeCriticalOutput,
  VaultContextOutput,
} from "./schemas";

type VaultContext = z.infer<typeof VaultContextOutput>;
type ExplainAnswer = z.infer<typeof ExplainAnswerOutput>;
type Diagnose = z.infer<typeof DiagnoseRetrievalOutput>;
type Critical = z.infer<typeof KnowledgeCriticalOutput>;

/** Keeps the packed notes with `{chunk_id, content, score}` per chunk, the syntheses, the open
 *  contradictions, the lessons as `{chunk_id, path, excerpt}`, the episodes, `diff_since` (the
 *  watermark the caller echoes back as `since`) and the `prefetched` / `prefetch_generated_at` pair
 *  (it says the bundle came from the prewarm cache, and how old it is). Drops the route signals, the
 *  query source, the signal note path and hash, the budget and stats blocks, each chunk's `source`
 *  and `hop` and each lesson's `via`. */
export function conciseVaultContext(r: VaultContext): Record<string, unknown> {
  return {
    vault: r.vault,
    notes: r.notes.map((n) => ({
      path: n.path,
      chunks: n.chunks.map((c) => ({
        chunk_id: c.chunk_id,
        ...(c.content !== undefined ? { content: c.content } : {}),
        score: c.score,
      })),
    })),
    syntheses: r.syntheses,
    contradictions: r.contradictions,
    lessons: r.lessons.map((l) => ({ chunk_id: l.chunk_id, path: l.path, excerpt: l.excerpt })),
    ...(r.episodes !== undefined ? { episodes: r.episodes } : {}),
    ...(r.diff_since !== undefined ? { diff_since: r.diff_since } : {}),
    ...(r.prefetched !== undefined ? { prefetched: r.prefetched } : {}),
    ...(r.prefetch_generated_at !== undefined
      ? { prefetch_generated_at: r.prefetch_generated_at }
      : {}),
  };
}

/** The unavailable arm is already a bare message. Otherwise keeps each link's chunk, path, whether the
 *  chunk still resolves, the citation verdict and score, the correlation (an identity or a guess) and
 *  a known episode id, plus `caveat` and `citation_pass`, which stop an unjudged chain reading as an
 *  unused one. Drops `summary` (derivable from `links`) and each link's retrieval echo. */
export function conciseExplainAnswer(r: ExplainAnswer): Record<string, unknown> {
  if (!r.available) return r;
  return {
    available: true,
    vault: r.vault,
    scope: r.scope,
    links: r.links.map((l) => ({
      chunk_id: l.chunk_id,
      path: l.path,
      chunk: l.chunk,
      citation: l.citation,
      citation_score: l.citation_score,
      correlation: l.correlation,
      ...(l.episode_id !== null ? { episode_id: l.episode_id } : {}),
    })),
    caveat: r.caveat,
    citation_pass: r.citation_pass,
  };
}

/** Keeps the plain answer (`returned`, `dropped_at`, `summary`); drops the per-stage trace and the
 *  query / path echo. Uniform for a readable and an unreadable path. */
export function conciseDiagnoseRetrieval(r: Diagnose): Record<string, unknown> {
  return { vault: r.vault, returned: r.returned, dropped_at: r.dropped_at, summary: r.summary };
}

/** Keeps `{path, title, category, source}` per doc; drops `count` and the constant `severity`. */
export function conciseKnowledgeCritical(r: Critical): Record<string, unknown> {
  return {
    vault: r.vault,
    items: r.items.map((i) => ({
      path: i.path,
      title: i.title,
      category: i.category,
      source: i.source,
    })),
  };
}
