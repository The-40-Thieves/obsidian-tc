// THE-628 (first PR): index-time note-level summarizer. Runs as a SEPARATE pass over an already
// (re)indexed vault — not wired into indexVault/indexNote's write path — so those files stay
// byte-identical to before this ticket by construction, not by an internal conditional: the flag-off
// contract is "this module is never called", the simplest possible proof of zero gateway calls.
//
// Mirrors runLlmDensify (search/densify-runner.ts): notes are assembled from the already-indexed
// `chunks` table (no raw file re-read, no dependency on the indexing write-path internals) and the
// gateway is the injected seam (extract role -> local model by default). Gated on the SAME
// content_hash `notes.content_hash` carries (20260702_001_notes.sql) — the note-level analogue of
// computeNotePlan's chunk-level content_hash gate (note-plan.ts) — so an unchanged note is never
// re-summarized and a crashed/interrupted pass resumes for free: the next run re-reads `notes`,
// finds the same unsummarized paths, and picks up where it left off.
//
// TWO PHASES, deliberately. Phase 1 generates summaries (gateway.extract, per note, bounded
// concurrency). Phase 2 embeds them — in BATCHES (embedProvider.embed(texts, ...) over a variable
// array of accumulated summary texts), never one embed() call per note. This is the same shape
// the chunk indexer uses (embed-batches.ts's provider.embed(batch)) and it is not merely a style
// preference: test/query-encoder.test.ts's source-scan gate reserves a single-element LITERAL
// `.embed([...])` call for query-encoder.ts's single-query dense encode and asserts it appears
// NOWHERE else in the tree — an earlier version of this file that embedded one summary at a time
// via `.embed([summaryText], ...)` tripped that gate. Batching is also strictly better here: one
// round trip for N summaries instead of N.
import { tableExists } from "../../db/introspect";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { GatewayClient } from "../../gateway";
import { type EgressFilter, isExcludedPath } from "../../plane/egress-filter";
import { runWithConcurrency } from "../../util/concurrency";
import { existingSummaryHash, upsertNoteSummary } from "../note-summaries";

const DEFAULT_MAX_CONCURRENCY = 12; // research brief: 8-16 in-flight extract() calls
const DEFAULT_MAX_CONTENT_CHARS = 8000;
// Phase 2's batch size — short summary texts, so a generous batch still stays well inside any
// provider's per-request budget. Sequential across batches (not concurrent): each request already
// carries many summaries, so fanning out several such requests at once multiplies provider load
// for little wall-clock gain, unlike phase 1's per-note gateway calls.
const SUMMARY_EMBED_BATCH = 64;

const SUMMARY_SYSTEM_PROMPT =
  "Summarize the following note in 2-4 sentences, capturing its main topic and key points. Return only the summary text — no preamble, no markdown formatting.";

export interface SummarizeNotesOptions {
  /** Bounded in-flight extract() calls (research brief: 8-16). Default 12. */
  maxConcurrency?: number;
  /** Cap on the note content sent to the summarizer, mirrors densify-runner's maxContentChars. */
  maxContentChars?: number;
  now?: () => number;
  /** THE-934 fix round 1: egress.excludePaths, compiled. Undefined -> nothing excluded. */
  excludeFilter?: EgressFilter;
}

export interface SummarizeNotesStats {
  /** Notes present in `notes` for this vault. */
  considered: number;
  /** Newly (re)summarized this pass — a gateway call was made and a row was written. */
  summarized: number;
  /** Content_hash unchanged (already summarized at this version) or note had no chunk content to
   *  summarize (e.g. every chunk secret-gated) — no gateway call either way. */
  skipped: number;
  /** A gateway call was attempted and failed, or returned an unusable (empty) summary. */
  failed: number;
}

/** A phase-1 output: a note that was successfully summarized (gateway call succeeded, non-empty
 *  text) and is now waiting for phase 2's batch embed. */
interface PendingSummary {
  path: string;
  contentHash: string;
  summaryText: string;
  model: string;
}

/** Summarize every note in `vaultId` whose content_hash has no matching note_summaries row.
 *  Content comes from the ALREADY-INDEXED chunks table (GROUP_CONCAT by path, same shape
 *  densify-runner uses), so this never re-reads vault files and never runs ahead of indexing.
 *
 *  Best-effort throughout, never throws: a gateway failure on one note (phase 1) is counted as
 *  `failed` and that note is retried next pass via the content_hash gate; an embed-provider
 *  failure on one BATCH (phase 2) leaves that batch's summaries written but unembedded (still
 *  counted in `summarized` — the text was genuinely produced) rather than losing them. A slow or
 *  unreachable provider degrades the PASS, not the caller's whole reindex. */
export async function summarizeNotes(
  db: Database,
  vaultId: string,
  gateway: GatewayClient,
  embedProvider: EmbeddingProvider,
  opts: SummarizeNotesOptions = {},
): Promise<SummarizeNotesStats> {
  const now = opts.now ?? Date.now;
  const maxChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  if (!tableExists(db, "notes") || !tableExists(db, "note_summaries")) {
    return { considered: 0, summarized: 0, skipped: 0, failed: 0 };
  }

  const notes = db
    .prepare("SELECT path, content_hash AS contentHash FROM notes WHERE vault_id = ? ORDER BY path")
    .all(vaultId) as Array<{ path: string; contentHash: string }>;

  // THE-934 fix round 1 (Blocking-4): an excluded note is never summarised at all -- dropped
  // BEFORE gateway.extract is ever built, same "consumer filters first" chokepoint the four
  // original assemblers use. Counted as `skipped`, not `failed` (it is a deliberate exclusion, not
  // an error), and re-evaluated every pass (no persisted "excluded" state), so a rename out of the
  // excluded folder is picked up on the very next run.
  const excludeFilter = opts.excludeFilter;
  const notExcluded = notes.filter(
    (n) => excludeFilter === undefined || !isExcludedPath(excludeFilter, n.path),
  );
  const toSummarize = notExcluded.filter(
    (n) => existingSummaryHash(db, vaultId, n.path) !== n.contentHash,
  );
  let skipped = notes.length - toSummarize.length;
  let failed = 0;

  // Phase 1: generate summaries. Gateway calls stay per-note, under bounded concurrency — this
  // half is unchanged from the original design; only the embed half (phase 2, below) moved.
  const pending: PendingSummary[] = [];
  await runWithConcurrency(
    toSummarize,
    Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    async (note) => {
      const row = db
        .prepare(
          "SELECT group_concat(content, char(10)) AS content FROM chunks WHERE vault_id = ? AND path = ? ORDER BY chunk_index",
        )
        .get(vaultId, note.path) as { content: string | null } | undefined;
      const content = (row?.content ?? "").slice(0, maxChars);
      if (content.trim().length === 0) {
        // Nothing to summarize (e.g. every chunk was secret-gated) — not a failure, and NOT a
        // gateway call. Left unsummarized rather than writing an empty/placeholder row so the
        // candidate stream never surfaces a content-free "summary".
        skipped += 1;
        return;
      }
      try {
        const completion = await gateway.extract({
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: `Note path: ${note.path}\n\n${content}` },
          ],
          temperature: 0,
          maxTokens: 256,
          // THE-934: the egress guard's backstop check -- this note already cleared the
          // notExcluded filter above.
          sourcePaths: [note.path],
        });
        const summaryText = completion.text.trim();
        if (summaryText.length === 0) {
          failed += 1;
          return;
        }
        pending.push({
          path: note.path,
          contentHash: note.contentHash,
          summaryText,
          model: completion.model,
        });
      } catch {
        failed += 1;
      }
    },
  );

  // Phase 2: batch-embed every generated summary, then persist. `texts` below is a variable
  // (`pending.slice(...).map(...)`), never a literal array — see this file's header comment for
  // why that distinction is load-bearing. A summary row is written (and counted in `summarized`)
  // whether or not its batch's embed succeeded: the content_hash gate must advance either way (a
  // note whose summary text was generated is NOT regenerated next pass just because embedding
  // failed), and an unembedded row simply stays invisible to searchNoteSummaries (which only
  // reads rows WITH an embedding) until a later pass fills the vector in — same contract as
  // before, now applied per BATCH instead of per note.
  let summarized = 0;
  for (let i = 0; i < pending.length; i += SUMMARY_EMBED_BATCH) {
    const batch = pending.slice(i, i + SUMMARY_EMBED_BATCH);
    const texts = batch.map((p) => p.summaryText);
    let vectors: number[][] | null = null;
    try {
      // THE-934: sourcePaths declares exactly the notes this batch's summary texts were derived
      // from -- every one already cleared the notExcluded filter above.
      vectors = await embedProvider.embed(texts, {
        input: "document",
        sourcePaths: batch.map((p) => p.path),
      });
    } catch {
      vectors = null; // whole-batch failure -> this batch's summaries land without embeddings
    }
    batch.forEach((p, j) => {
      const embedding = vectors?.[j];
      upsertNoteSummary(db, vaultId, {
        path: p.path,
        contentHash: p.contentHash,
        summary: p.summaryText,
        model: p.model,
        ...(embedding ? { embedding, embeddingModel: embedProvider.id } : {}),
        createdAt: now(),
      });
      summarized += 1;
    });
  }

  return { considered: notes.length, summarized, skipped, failed };
}

export interface NoteSummaryPassConfig {
  enabled: boolean;
  maxConcurrency?: number;
  maxContentChars?: number;
  now?: () => number;
}

/**
 * The gate for the WHOLE note-summary pass, structured so "flag off" is provably zero gateway
 * calls rather than merely tested to be: `cfg.enabled === false` returns before `makeGateway` is
 * even invoked, so no GatewayClient is constructed and summarizeNotes never runs. Callers (the
 * `obsidian-tc index` CLI command — see its own doc comment for why this pass belongs there, not
 * in indexVault) pass a lazy gateway factory rather than a constructed client for exactly this
 * reason: constructing a client is cheap, but the intent — "off means untouched" — is clearest
 * when the off path cannot even reach the construction call.
 */
export async function maybeSummarizeVault(
  db: Database,
  vaultId: string,
  cfg: NoteSummaryPassConfig,
  makeGateway: () => GatewayClient,
  embedProvider: EmbeddingProvider,
  /** THE-934 fix round 1: egress.excludePaths, compiled. Undefined -> nothing excluded. */
  excludeFilter?: EgressFilter,
): Promise<SummarizeNotesStats | null> {
  if (!cfg.enabled) return null;
  const gateway = makeGateway();
  return summarizeNotes(db, vaultId, gateway, embedProvider, {
    ...(cfg.maxConcurrency !== undefined ? { maxConcurrency: cfg.maxConcurrency } : {}),
    ...(cfg.maxContentChars !== undefined ? { maxContentChars: cfg.maxContentChars } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
    ...(excludeFilter !== undefined ? { excludeFilter } : {}),
  });
}
