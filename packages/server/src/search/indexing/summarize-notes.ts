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
import { tableExists } from "../../db/introspect";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { GatewayClient } from "../../gateway";
import { runWithConcurrency } from "../../util/concurrency";
import { existingSummaryHash, upsertNoteSummary } from "../note-summaries";

const DEFAULT_MAX_CONCURRENCY = 12; // research brief: 8-16 in-flight extract() calls
const DEFAULT_MAX_CONTENT_CHARS = 8000;

const SUMMARY_SYSTEM_PROMPT =
  "Summarize the following note in 2-4 sentences, capturing its main topic and key points. Return only the summary text — no preamble, no markdown formatting.";

export interface SummarizeNotesOptions {
  /** Bounded in-flight extract() calls (research brief: 8-16). Default 12. */
  maxConcurrency?: number;
  /** Cap on the note content sent to the summarizer, mirrors densify-runner's maxContentChars. */
  maxContentChars?: number;
  now?: () => number;
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

/** Summarize every note in `vaultId` whose content_hash has no matching note_summaries row.
 *  Content comes from the ALREADY-INDEXED chunks table (GROUP_CONCAT by path, same shape
 *  densify-runner uses), so this never re-reads vault files and never runs ahead of indexing.
 *
 *  Best-effort per note: a gateway failure or an embed-provider failure on one note is counted and
 *  skipped, never thrown — a slow/unreachable provider degrades the PASS (fewer notes summarized
 *  this run, retried next run via the same content_hash gate), not the caller's whole reindex. */
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

  const toSummarize = notes.filter(
    (n) => existingSummaryHash(db, vaultId, n.path) !== n.contentHash,
  );
  let skipped = notes.length - toSummarize.length;
  let summarized = 0;
  let failed = 0;

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
        });
        const summaryText = completion.text.trim();
        if (summaryText.length === 0) {
          failed += 1;
          return;
        }
        let embedding: number[] | undefined;
        let embeddingModel: string | undefined;
        try {
          const vectors = await embedProvider.embed([summaryText], { input: "document" });
          embedding = vectors[0];
          embeddingModel = embedProvider.id;
        } catch {
          // The summary is still written and still gates re-summarization next pass even when
          // embedding fails — see the migration header. It stays invisible to the retrieval
          // candidate stream (searchNoteSummaries only reads rows WITH an embedding) until a later
          // pass fills the vector in.
        }
        upsertNoteSummary(db, vaultId, {
          path: note.path,
          contentHash: note.contentHash,
          summary: summaryText,
          model: completion.model,
          ...(embedding ? { embedding, embeddingModel } : {}),
          createdAt: now(),
        });
        summarized += 1;
      } catch {
        failed += 1;
      }
    },
  );

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
): Promise<SummarizeNotesStats | null> {
  if (!cfg.enabled) return null;
  const gateway = makeGateway();
  return summarizeNotes(db, vaultId, gateway, embedProvider, {
    ...(cfg.maxConcurrency !== undefined ? { maxConcurrency: cfg.maxConcurrency } : {}),
    ...(cfg.maxContentChars !== undefined ? { maxContentChars: cfg.maxContentChars } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
  });
}
