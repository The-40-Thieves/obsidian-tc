// Chunk-store writer: turns notes into persisted chunks + embeddings, and keeps
// the store incremental. A chunk's id is stable for a (vault, path, position), so
// re-indexing skips chunks whose content hash is unchanged, re-embeds changed
// ones, and prunes chunks that no longer exist in the note. chunk_embeddings is
// deleted explicitly (not relying on FK cascade, which node:sqlite tests run with
// foreign_keys off). vec_chunks is kept in lock-step only when the extension loaded.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { parseNote } from "../vault/frontmatter";
import { type ExtractedLink, extractLinks } from "../vault/links";
import { readNote } from "../vault/notes-io";
import { contentHash, resolveVaultPath, walkVault } from "../vault/paths";
import { chunkNote, enrichChunkText } from "./chunk";
import { deleteChunkColbert, ensureChunkColbert, upsertChunkColbert } from "./chunk_colbert";
import { deleteChunkFtsRow, ensureChunkFts, upsertChunkFtsRow } from "./chunk_fts";
import type { ColbertMatrix } from "./colbert";
import { computeKnnEdges, reconcileDerivedEdges, tagCooccurrenceEdges } from "./derived-edges";
import { desiredEdges, reconcileVaultEdges } from "./edges";
import {
  buildNoteRecord,
  deleteNoteRow,
  ensureNotesFts,
  hasNotesTable,
  type NoteRecord,
  noteRowHash,
  upsertNoteRow,
} from "./fts";
import { scanSecrets } from "./secrets";
import { deleteChunkSparse, ensureChunkSparse, type SparseVec, upsertChunkSparse } from "./sparse";
import { ensureVecChunks, floatBlob, upsertVec } from "./vec";

export interface IndexStats {
  notes_seen: number;
  notes_indexed: number;
  chunks_upserted: number;
  chunks_deleted: number;
  chunks_unchanged: number;
  edges_inserted: number;
  edges_deleted: number;
  secrets_skipped: number;
  vec_enabled: boolean;
  /** THE-291 (additive): FTS5 availability + notes-metadata write counts. */
  fts_enabled: boolean;
  notes_upserted: number;
  notes_deleted: number;
  /** THE-390 (additive): notes skipped this pass because the embed provider rejected one of
   *  their chunks even as a single-text request; retried automatically next reconcile. */
  notes_embed_failed: number;
  model: string;
  dimensions: number;
}

/** A chunk that was (re)embedded this pass; handed to the optional index hook. */
export interface IndexedChunk {
  id: string;
  path: string;
  content: string;
  embedding: number[];
}

/** THE-233 W-INGEST seam: notified of newly-embedded chunks. W-WORKERS wires the
 *  contradiction-check enqueue here at integration; default is no hook. */
export type IndexHook = (chunks: IndexedChunk[]) => void;

// Stable, content-independent id for a chunk slot. Re-chunking the same note
// reproduces these ids, so content_hash alone decides re-embed vs. skip.
export function chunkId(vaultId: string, path: string, index: string): string {
  const key = [vaultId, path, index].join(" ");
  return "chk_".concat(contentHash(key).slice(0, 24));
}

interface ExistingRow {
  id: string;
  content_hash: string;
}

// A note's chunk after secret-gating, carrying its stable chunk id. embedText (THE-406) is the
// context-enriched text that is embedded + BM25-indexed INSTEAD of content when
// embeddings.chunkContext is on; content stays the raw display text everywhere.
type PlannedChunk = ReturnType<typeof chunkNote>[number] & { id: string; embedText?: string };

// THE-408: enrichChunkText moved to ./chunk (import-cycle-free for chunk_fts); re-exported here
// for existing importers (tests, scripts).
export { enrichChunkText } from "./chunk";

// A note's pending writes, computed (including the embed() network call) WITHOUT touching the
// database or opening a transaction, so many plans can be applied inside one transaction.
interface NoteWritePlan {
  path: string;
  existing: ExistingRow[];
  desiredIds: Set<string>;
  toEmbed: PlannedChunk[];
  vectors: number[][];
  /** THE-388: filled by embedPlans only when the provider emits embedFull() (bge-m3), parallel to
   *  vectors; written to chunk_sparse / chunk_colbert. Absent for dense-only providers. */
  sparse?: SparseVec[];
  colbert?: ColbertMatrix[];
  ts: number;
}

interface PlanResult {
  plan: NoteWritePlan | null;
  unchanged: number;
  secretsSkipped: number;
  /** THE-291: secret-flagged chunk contents, excised from the note's FTS copy. */
  flagged: string[];
}

// Provider-sized embed sub-batch + how many to run in flight (THE-277) — the defaults used when a
// caller passes no embed config. GH #171/#172: a request is ALSO capped by estimated tokens
// (EMBED_MAX_BATCH_TOKENS), so a token-dense sub-batch can't overrun a stock local runner's budget
// and crash it regardless of the input count. THE-390: the token cap must stay UNDER the provider's
// loaded context — Ollama defaults to n_ctx 4096 and 400-rejects a request whose SUMMED tokens
// exceed it, and estimateTokens undercounts real tokenization (~2-2.5x on link-dense markdown).
// 2048 estimated keeps a batch inside a 4096 context with that drift; must match the
// EmbeddingsConfigSchema default.
const EMBED_BATCH = 512;
const EMBED_CONCURRENCY = 4;
const EMBED_MAX_BATCH_TOKENS = 2048;

// Rough token estimate for batch budgeting (~4 chars/token). Provider-agnostic and intentionally
// coarse: it only needs to prevent a runaway single request, not be exact.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Compute a note's write plan WITHOUT embedding — NO network, NO database writes, NO transaction.
// Vectors are filled later by embedPlans, which batches the embed() calls across many notes so a
// reconcile does not pay one serial round-trip per note. Returns { plan: null } when the note is
// unchanged (nothing to prune or embed), so the caller opens no transaction for a warm re-index.
function computeNotePlan(
  db: Database,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
): PlanResult {
  const body = parseNote(raw).body;
  // Secret-gate (THE-134 fold): a chunk whose content matches a credential shape is dropped
  // before embedding — never embedded, never stored, pruned if it existed. Class names only
  // are logged; the matched value is never logged or thrown.
  let secretsSkipped = 0;
  const flagged: string[] = [];
  // THE-406: with enrichment on, the content hash is computed over the ENRICHED text, so flipping
  // embeddings.chunkContext re-embeds every chunk on the next pass instead of silently serving
  // vectors built from a different representation.
  const desired = chunkNote(body)
    .map((c) => {
      if (!enrich) return { ...c, id: chunkId(vaultId, path, c.index) };
      const embedText = enrichChunkText(path, c.headings, c.content);
      return {
        ...c,
        id: chunkId(vaultId, path, c.index),
        embedText,
        contentHash: contentHash(embedText),
      };
    })
    .filter((c) => {
      const scan = scanSecrets(c.content);
      if (scan.clean) return true;
      flagged.push(c.content);
      secretsSkipped += 1;
      process.stderr.write(
        `[ingest] secret-gate skipped ${path}#${c.index} (${scan.classes.join(", ")})\n`,
      );
      return false;
    });
  const desiredIds = new Set(desired.map((d) => d.id));
  const existing = db
    .prepare("SELECT id, content_hash FROM chunks WHERE vault_id = ? AND path = ?")
    .all(vaultId, path) as ExistingRow[];
  const existingHash = new Map(existing.map((e) => [e.id, e.content_hash]));
  const toEmbed = desired.filter((d) => existingHash.get(d.id) !== d.contentHash);
  const unchanged = desired.length - toEmbed.length;
  const willPrune = existing.some((e) => !desiredIds.has(e.id));
  if (toEmbed.length === 0 && !willPrune) {
    return { plan: null, unchanged, secretsSkipped, flagged };
  }
  return {
    plan: { path, existing, desiredIds, toEmbed, vectors: [], ts },
    unchanged,
    secretsSkipped,
    flagged,
  };
}

/** THE-390: outcome of an embedPlans pass. `failed` lists plans with at least one chunk the
 *  provider rejected even as a single-text request (HTTP 400/413); their vectors are NOT
 *  populated and they must not be applied — the content-hash skip retries them next reconcile.
 *  `rejections` counts rejected requests that were bisected + retried (an operator signal that
 *  `embeddings.maxBatchTokens` sits over the provider context and the pass is paying retries). */
export interface EmbedReport {
  failed: NoteWritePlan[];
  rejections: number;
}

// A provider "request rejected" error — HTTP 400/413, most commonly Ollama refusing a request
// whose summed tokens exceed the model's loaded n_ctx (THE-390). Distinct from an outage
// (timeout / 5xx / network error), which must keep aborting the reconcile.
function isEmbedRejection(e: unknown): boolean {
  if (!(e instanceof ObsidianTcError) || e.code !== "embedding_provider_error") return false;
  const status = e.details?.status;
  return status === 400 || status === 413;
}

// One sub-batch's outputs, aligned to its input order; null marks a quarantined text.
interface SubBatchOut {
  dense: Array<number[] | null>;
  sparse?: Array<SparseVec | null>;
  colbert?: Array<ColbertMatrix | null>;
}

// Embed one sub-batch, bisecting on a provider rejection: the token budget is an ESTIMATE
// (chars/4 undercounts real tokenization), so a packed batch can overshoot the provider context
// and 400 — halve and retry instead of aborting the whole reconcile (THE-390). A single text
// still rejected alone is quarantined as null, never silently truncated. Any other error
// propagates unchanged: a dead backend must abort, not degrade into one failing request per text.
async function embedSubBatch(
  provider: EmbeddingProvider,
  batch: string[],
  useFull: boolean,
  counters: { rejections: number },
): Promise<SubBatchOut> {
  try {
    if (useFull && provider.embedFull) {
      const full = await provider.embedFull(batch);
      return {
        dense: full.map((f) => f.dense),
        sparse: full.map((f) => f.sparse),
        colbert: full.map((f) => f.colbert),
      };
    }
    return { dense: await provider.embed(batch) };
  } catch (e) {
    if (!isEmbedRejection(e)) throw e;
    counters.rejections += 1;
    if (batch.length === 1) {
      return useFull ? { dense: [null], sparse: [null], colbert: [null] } : { dense: [null] };
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await embedSubBatch(provider, batch.slice(0, mid), useFull, counters);
    const right = await embedSubBatch(provider, batch.slice(mid), useFull, counters);
    return {
      dense: left.dense.concat(right.dense),
      ...(useFull
        ? {
            sparse: (left.sparse ?? []).concat(right.sparse ?? []),
            colbert: (left.colbert ?? []).concat(right.colbert ?? []),
          }
        : {}),
    };
  }
}

// Embed all of `plans`' to-embed chunks in provider-sized sub-batches under bounded concurrency
// (THE-277), then write the vectors back onto each plan IN ORDER. Batching across notes turns a
// reconcile's K serial per-note embed round-trips into ceil(total_chunks / batchSize) requests with
// a few in flight. Order is preserved: sub-batch i lands at results[i], concatenated in index order
// and sliced back to each plan by its toEmbed length. The write lock is never held across this.
export async function embedPlans(
  provider: EmbeddingProvider,
  plans: NoteWritePlan[],
  batchSize: number,
  concurrency: number,
  maxBatchTokens: number = EMBED_MAX_BATCH_TOKENS,
): Promise<EmbedReport> {
  const contents: string[] = [];
  // THE-406: embed the enriched text when present; c.content remains the stored display text.
  for (const p of plans) for (const c of p.toEmbed) contents.push(c.embedText ?? c.content);
  if (contents.length === 0) return { failed: [], rejections: 0 };
  // Pack sub-batches greedily under BOTH caps: at most `batchSize` inputs and at most
  // `maxBatchTokens` estimated tokens per request (GH #172 — a fixed 512-input batch packed ~87k
  // tokens into one call and crashed a stock local runner). A single text that alone exceeds the
  // token cap still goes in its own batch: never split, never dropped.
  const subBatches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const text of contents) {
    const t = estimateTokens(text);
    if (cur.length > 0 && (cur.length >= batchSize || curTokens + t > maxBatchTokens)) {
      subBatches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(text);
    curTokens += t;
  }
  if (cur.length > 0) subBatches.push(cur);
  // THE-388: when the provider emits embedFull() (bge-m3), collect the sparse + ColBERT heads per
  // sub-batch alongside the dense vector; dense-only providers take the embed() path unchanged.
  const hasFull = typeof provider.embedFull === "function";
  const counters = { rejections: 0 };
  const results: SubBatchOut[] = new Array(subBatches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < subBatches.length; i = next++) {
      results[i] = await embedSubBatch(provider, subBatches[i] as string[], hasFull, counters);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, subBatches.length) }, () => worker()),
  );
  const flatDense = results.flatMap((r) => r.dense);
  const flatSparse = hasFull ? results.flatMap((r) => r.sparse ?? []) : null;
  const flatColbert = hasFull ? results.flatMap((r) => r.colbert ?? []) : null;
  const failed: NoteWritePlan[] = [];
  let off = 0;
  for (const p of plans) {
    const n = p.toEmbed.length;
    const dense = flatDense.slice(off, off + n);
    if (dense.some((v) => v === null)) {
      // A quarantined chunk fails its whole NOTE: vectors stay empty so an accidental apply
      // cannot write a bogus embedding, and the caller must exclude the plan (THE-390).
      failed.push(p);
    } else {
      p.vectors = dense as number[][];
      if (flatSparse) p.sparse = flatSparse.slice(off, off + n) as SparseVec[];
      if (flatColbert) p.colbert = flatColbert.slice(off, off + n) as ColbertMatrix[];
    }
    off += n;
  }
  return { failed, rejections: counters.rejections };
}

// Single-note plan + embed (indexNote / index-on-write path). indexVault batches embeds instead.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
): Promise<PlanResult> {
  const res = computeNotePlan(db, vaultId, path, raw, ts, enrich);
  if (res.plan) {
    const { failed } = await embedPlans(provider, [res.plan], EMBED_BATCH, EMBED_CONCURRENCY);
    // Index-on-write is a single note: a quarantined chunk means the note cannot be applied,
    // so keep the caller's existing best-effort failure semantics (counted as a write failure)
    // rather than writing a partial note.
    if (failed.length > 0) {
      throw err.embeddingProviderError(
        "provider rejected a single-chunk embed request (over its context?)",
        { provider: provider.provider, path },
      );
    }
  }
  return res;
}

// Apply a note's write plan (prune + upserts). Contains NO transaction control — the CALLER owns
// BEGIN/COMMIT/ROLLBACK, so one transaction can batch many notes' applies.
function applyNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  plan: NoteWritePlan,
  hasVec: boolean,
  hasChunkFts: boolean,
  hasChunkSparse: boolean,
  hasChunkColbert: boolean,
): { upserted: number; deleted: number } {
  // Prepare the prune DELETEs once (not three per pruned chunk). The vec0 DELETE is prepared only
  // when the extension loaded — the table may not exist otherwise.
  const delEmb = db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
  const delChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
  const delVec = hasVec ? db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
  const upChunk = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, token_count = excluded.token_count, updated_at = excluded.updated_at",
  );
  const upEmb = db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
  );
  let deleted = 0;
  for (const e of plan.existing) {
    if (plan.desiredIds.has(e.id)) continue;
    delEmb.run(e.id);
    delChunk.run(e.id);
    if (delVec) delVec.run(e.id);
    if (hasChunkFts) deleteChunkFtsRow(db, e.id);
    if (hasChunkSparse) deleteChunkSparse(db, e.id);
    if (hasChunkColbert) deleteChunkColbert(db, e.id);
    deleted += 1;
  }
  plan.toEmbed.forEach((d, i) => {
    const vec = plan.vectors[i] ?? [];
    upChunk.run(
      d.id,
      vaultId,
      plan.path,
      d.index,
      JSON.stringify(d.headings),
      d.content,
      d.contentHash,
      d.tokenCount,
      plan.ts,
      plan.ts,
    );
    upEmb.run(d.id, provider.id, provider.dimensions, floatBlob(vec), plan.ts);
    if (hasVec) upsertVec(db, d.id, vec, { vaultId, path: plan.path, model: provider.id });
    // THE-406: BM25 matches on the same text the dense vector embeds (enriched when the flag is
    // on); bm25Chunks JOINs chunks for the raw display content, so search output is unchanged.
    if (hasChunkFts) upsertChunkFtsRow(db, d.id, vaultId, plan.path, d.embedText ?? d.content);
    // THE-395: an empty head (the serving runtime could not produce it) is skipped, not stored —
    // an all-empty chunk_sparse / chunk_colbert would only bloat scans with dead rows.
    const sp = plan.sparse?.[i];
    if (hasChunkSparse && sp && Object.keys(sp).length > 0)
      upsertChunkSparse(db, d.id, vaultId, sp);
    const cb = plan.colbert?.[i];
    if (hasChunkColbert && cb && cb.length > 0) upsertChunkColbert(db, d.id, vaultId, cb);
  });
  return { upserted: plan.toEmbed.length, deleted };
}

// Notify the index hook of a committed plan's (re)embedded chunks. Call only AFTER the plan's
// transaction has committed, so a consumer never observes an uncommitted (possibly rolled-back)
// chunk.
function fireIndexHook(onIndexed: IndexHook | undefined, plan: NoteWritePlan): void {
  if (onIndexed && plan.toEmbed.length > 0) {
    onIndexed(
      plan.toEmbed.map((d, i) => ({
        id: d.id,
        path: plan.path,
        content: d.content,
        embedding: plan.vectors[i] ?? [],
      })),
    );
  }
}

// Index a single note atomically: plan (incl. embed, outside the txn), then prune + upsert in one
// transaction. Used by the index-on-write / deindex paths; indexVault batches instead.
export async function indexNote(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  hasVec: boolean,
  now: () => number,
  onIndexed?: IndexHook,
  /** THE-406: embeddings.chunkContext — enrich the embedded/BM25 text with title + breadcrumb. */
  enrich = false,
): Promise<{ upserted: number; deleted: number; unchanged: number; secretsSkipped: number }> {
  const { plan, unchanged, secretsSkipped, flagged } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
    enrich,
  );
  // THE-291: the metadata/FTS row rides the same write (skip empty content — a true delete goes
  // through deindexNote; an empty note has nothing to index).
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db, { now });
  const hasChunkFts = ensureChunkFts(db, { now, enrich });
  const hasEmbedFull = typeof provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(db);
  const note: NoteRecord | null =
    hasNotes && raw !== "" ? buildNoteRecord(path, raw, flagged, null, now()) : null;
  if (!plan) {
    // Chunks unchanged; refresh the notes row only when missing/stale (backfill path).
    if (note && noteRowHash(db, vaultId, path) !== note.contentHash) {
      db.exec("BEGIN");
      try {
        upsertNoteRow(db, vaultId, note, hasFts, now());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
  }
  let result: { upserted: number; deleted: number };
  db.exec("BEGIN");
  try {
    result = applyNoteWrites(
      db,
      provider,
      vaultId,
      plan,
      hasVec,
      hasChunkFts,
      hasChunkSparse,
      hasChunkColbert,
    );
    if (note) upsertNoteRow(db, vaultId, note, hasFts, now());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  fireIndexHook(onIndexed, plan);
  return { ...result, unchanged, secretsSkipped };
}

/**
 * THE-291: drop EVERYTHING indexed for a path — chunks, embeddings, vec rows, and the notes +
 * FTS metadata — in one transaction. The delete/move paths call this instead of the legacy
 * empty-content reindex (which cannot distinguish a deleted note from an empty one for the
 * notes table).
 */
export function deindexNote(
  db: Database,
  vaultId: string,
  path: string,
  hasVec: boolean,
  /** THE-408: embeddings.chunkContext — a divergence-rebuild fired from this path must match the
   *  index's enrichment. */
  enrich = false,
): void {
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db);
  const hasChunkFts = ensureChunkFts(db, { enrich });
  const hasChunkSparse = tableExists(db, "chunk_sparse");
  const hasChunkColbert = tableExists(db, "chunk_colbert");
  db.exec("BEGIN");
  try {
    const rows = db
      .prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?")
      .all(vaultId, path) as Array<{ id: string }>;
    const delEmb = db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
    const delChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
    const delVec = hasVec ? db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
    for (const r of rows) {
      delEmb.run(r.id);
      delChunk.run(r.id);
      if (delVec) delVec.run(r.id);
      if (hasChunkFts) deleteChunkFtsRow(db, r.id);
      if (hasChunkSparse) deleteChunkSparse(db, r.id);
      if (hasChunkColbert) deleteChunkColbert(db, r.id);
    }
    if (hasNotes) deleteNoteRow(db, vaultId, path, hasFts);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Does vault_edges carry the densification columns (migration 20260713_001: confidence +
 *  source_fingerprint)? A vault_edges provisioned BEFORE that migration — or a bare fixture — has neither,
 *  and the derived-edge upsert would throw and take the whole index pass down with it. No columns means no
 *  derived edge can exist, so there is nothing to reconcile and nothing to prune: skipping is safe. */
function hasDerivedEdgeColumns(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(vault_edges)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    return names.has("confidence") && names.has("source_fingerprint");
  } catch {
    return false;
  }
}

/** Per-note frontmatter tag sets (notes.tags is a JSON array). A note with unparseable tags contributes
 *  none — one bad row never aborts the index pass. */
function readNoteTags(db: Database, vaultId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare("SELECT path, tags FROM notes WHERE vault_id = ?").all(vaultId) as Array<{
    path: string;
    tags: string | null;
  }>;
  for (const row of rows) {
    try {
      const parsed = row.tags ? (JSON.parse(row.tags) as unknown) : [];
      if (Array.isArray(parsed)) {
        out.set(
          row.path,
          parsed.filter((t): t is string => typeof t === "string"),
        );
      }
    } catch {
      // unparseable tags -> this note contributes none
    }
  }
  return out;
}

export interface IndexVaultArgs {
  db: Database;
  provider: EmbeddingProvider;
  vaultId: string;
  root: string;
  sub?: string;
  isReadable: (rel: string) => boolean;
  now?: () => number;
  onIndexed?: IndexHook;
  /** GH #171/#172: embed-batch tuning; each field falls back to its module default. Callers thread
   *  config.embeddings.{batchSize,concurrency,maxBatchTokens} here so a slow or small local runner
   *  can be tuned without touching code. */
  embed?: { batchSize?: number; concurrency?: number; maxBatchTokens?: number };
  /** THE-406: embeddings.chunkContext — embed + BM25-index each chunk with a note-title +
   *  heading-breadcrumb prefix (display content stays raw). Callers MUST thread the same value on
   *  every index path (boot reconcile, index_vault tool, index-on-write): the chunk content hash
   *  covers the enriched text, so mixed values would re-embed the same chunks back and forth. */
  chunkContext?: boolean;
  /** Graph densification (docs/plans/2026-07-13-graph-densification.md): build derived edges during
   *  index_vault. tagEdges = shared-frontmatter-tag co-occurrence; knnEdges = vec0 kNN neighbors.
   *  Off unless threaded from config.retrieval.densify. Full-state per kind (toggling off prunes). */
  densify?: {
    tagEdges?: boolean;
    knnEdges?: boolean;
    knnK?: number;
    knnMinSim?: number;
    maxTagFanout?: number;
  };
  /** THE-291: fires when the notes/FTS metadata pass has committed (independent of embed
   *  success), so the caller can flip metadata readiness even if the embed pass later fails. */
  onNotesPass?: () => void;
}

export async function indexVault(args: IndexVaultArgs): Promise<IndexStats> {
  const now = args.now ?? Date.now;
  const hasVec = ensureVecChunks(args.db, args.provider.dimensions, { now });
  // THE-291: notes metadata + FTS ride the reconcile. The UNFILTERED walk backs the stale-path
  // sweep (ACL-invisible-but-present files must never be deindexed); the readable subset drives
  // indexing exactly as before.
  const hasNotes = hasNotesTable(args.db);
  const hasFts = hasNotes && ensureNotesFts(args.db, { now });
  const hasChunkFts = ensureChunkFts(args.db, { now, enrich: args.chunkContext === true });
  const hasEmbedFull = typeof args.provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(args.db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(args.db);
  const walked = walkVault(args.root, { sub: args.sub, extensions: [".md"] });
  const walkedSet = new Set(walked.map((e) => e.relPath));
  const statByPath = new Map(walked.map((e) => [e.relPath, { mtime: e.mtime, size: e.size }]));
  const notes = walked.map((e) => e.relPath).filter(args.isReadable);
  const stats: IndexStats = {
    notes_seen: notes.length,
    notes_indexed: 0,
    chunks_upserted: 0,
    chunks_deleted: 0,
    chunks_unchanged: 0,
    edges_inserted: 0,
    edges_deleted: 0,
    secrets_skipped: 0,
    vec_enabled: hasVec,
    fts_enabled: hasFts,
    notes_upserted: 0,
    notes_deleted: 0,
    notes_embed_failed: 0,
    model: args.provider.id,
    dimensions: args.provider.dimensions,
  };
  // Collect each note's links during the index walk so vault_edges is reconciled in one
  // full-state pass — the undirected links_to graph W-RETRIEVAL walks (THE-233 W-INGEST).
  const noteLinks = new Map<string, ExtractedLink[]>();
  // Two-phase batching: PLAN each note (including its embed() network call) with no transaction,
  // then APPLY a batch of plans in ONE transaction. The write lock is never held across a note's
  // embed, and a K-note reconcile pays ~ceil(N/BATCH) fsyncs instead of N. A batch is the atomic
  // unit — a mid-batch failure rolls the whole batch back; that only costs re-work (the reconcile
  // is idempotent, the content-hash skip re-converges next pass), never correctness. Safe because
  // indexVault is the sole writer on this single connection during the reconcile, so a plan's
  // pre-read `existing` snapshot cannot be raced before its apply.
  const BATCH = 100;
  let batch: NoteWritePlan[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const applied = batch;
    batch = [];
    // Batch the embed() calls across the whole batch (THE-277) BEFORE opening the write txn, so the
    // reconcile makes ceil(chunks/EMBED_BATCH) requests with a few in flight instead of one serial
    // round-trip per note. The write lock is still never held across a network call.
    const report = await embedPlans(
      args.provider,
      applied,
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens ?? EMBED_MAX_BATCH_TOKENS,
    );
    if (report.rejections > 0) {
      process.stderr.write(
        `[index] vault "${args.vaultId}": ${report.rejections} embed request(s) exceeded the ` +
          `provider's context (HTTP 400/413) and were bisected + retried. Lower ` +
          `embeddings.maxBatchTokens to avoid the extra round-trips.\n`,
      );
    }
    // THE-390: a chunk the provider rejects even alone quarantines its NOTE — the rest of the
    // batch still applies and the reconcile completes (surfaced via stats + reconcile health;
    // the content-hash skip retries the note next pass). Deliberate consequence: a quarantined
    // note keeps serving its LAST-INDEXED chunks (stale-but-consistent) rather than being pruned
    // to a search hole or failing the whole reindex; its notes/FTS metadata may be newer, which
    // the notes pass already allows by design (THE-291 independence).
    let toApply = applied;
    if (report.failed.length > 0) {
      const failedSet = new Set(report.failed);
      toApply = applied.filter((p) => !failedSet.has(p));
      stats.notes_embed_failed += report.failed.length;
      const sample = report.failed
        .slice(0, 3)
        .map((p) => p.path)
        .join(", ");
      process.stderr.write(
        `[index] vault "${args.vaultId}": embed provider rejected ${report.failed.length} ` +
          `note(s) even at single-text size (${sample}${report.failed.length > 3 ? ", ..." : ""}) ` +
          `— skipped this pass. If this persists, the chunk exceeds the provider's context; ` +
          `use a larger-context embedding model.\n`,
      );
    }
    args.db.exec("BEGIN");
    try {
      for (const plan of toApply) {
        const r = applyNoteWrites(
          args.db,
          args.provider,
          args.vaultId,
          plan,
          hasVec,
          hasChunkFts,
          hasChunkSparse,
          hasChunkColbert,
        );
        stats.chunks_upserted += r.upserted;
        stats.chunks_deleted += r.deleted;
        if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
      }
      args.db.exec("COMMIT");
    } catch (e) {
      args.db.exec("ROLLBACK");
      throw e;
    }
    for (const plan of toApply) fireIndexHook(args.onIndexed, plan);
  };
  // THE-291: the notes/FTS pass is flushed INDEPENDENTLY of the chunk/embed pass, so a broken
  // embedding backend cannot block metadata/FTS readiness (they need no embeddings). Notes
  // batches commit inline during the walk; chunk plans still batch through the embed flush.
  let notesBatch: NoteRecord[] = [];
  const flushNotes = (): void => {
    if (!hasNotes || notesBatch.length === 0) return;
    const rows = notesBatch;
    notesBatch = [];
    args.db.exec("BEGIN");
    try {
      for (const rec of rows) upsertNoteRow(args.db, args.vaultId, rec, hasFts, now());
      args.db.exec("COMMIT");
    } catch (e) {
      args.db.exec("ROLLBACK");
      throw e;
    }
    stats.notes_upserted += rows.length;
  };
  for (const rel of notes) {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    noteLinks.set(rel, extractLinks(parseNote(raw).body));
    const { plan, unchanged, secretsSkipped, flagged } = computeNotePlan(
      args.db,
      args.vaultId,
      rel,
      raw,
      now(),
      args.chunkContext === true,
    );
    stats.chunks_unchanged += unchanged;
    stats.secrets_skipped += secretsSkipped;
    if (hasNotes && raw !== "") {
      const rec = buildNoteRecord(rel, raw, flagged, statByPath.get(rel) ?? null, now());
      if (noteRowHash(args.db, args.vaultId, rel) !== rec.contentHash) {
        notesBatch.push(rec);
        if (notesBatch.length >= BATCH) flushNotes();
      }
    }
    if (plan) {
      batch.push(plan);
      if (batch.length >= BATCH) await flush();
    }
  }
  flushNotes();
  // THE-291: stale-path sweep — ONLY on unscoped runs (a folder-scoped index_vault call must
  // never deindex the rest of the vault), and diffed against the UNFILTERED walk so files an
  // ACL-restricted caller cannot see are not destroyed.
  if (hasNotes && args.sub === undefined) {
    const known = args.db
      .prepare("SELECT path FROM notes WHERE vault_id = ?")
      .all(args.vaultId) as Array<{ path: string }>;
    for (const row of known) {
      if (!walkedSet.has(row.path)) {
        deindexNote(args.db, args.vaultId, row.path, hasVec, args.chunkContext === true);
        stats.notes_deleted += 1;
      }
    }
  }
  args.onNotesPass?.();
  await flush();
  // Edge maintenance is full-state (resolving targets needs the whole note universe), so it
  // runs once per indexVault pass, not per-note-write. Skipped gracefully when vault_edges is
  // absent (pre-integration, before W-SCHEMA lands).
  if (tableExists(args.db, "vault_edges")) {
    const edgeStats = reconcileVaultEdges(
      args.db,
      args.vaultId,
      desiredEdges(noteLinks, notes),
      now,
    );
    stats.edges_inserted = edgeStats.inserted;
    stats.edges_deleted = edgeStats.deleted;
    // Densification (docs/plans/2026-07-13-graph-densification.md): derived edges — shared-tag
    // co-occurrence + vec0 kNN neighbors — reconciled on their OWN edge_types, so the literal layer and
    // the LLM layer (semantically_similar_to, built out-of-band by the densify-llm runner) are never
    // touched here.
    //
    // The reconcile runs on EVERY pass, with an EMPTY desired set when a flag is off. That is what makes
    // "turn the flag off" actually prune. Gating the reconcile behind the flag (the original shape) left
    // previously-generated rows in vault_edges forever: invisible while includeInWalk was false, but
    // ready to reappear the moment it flipped. Reconciling to empty is a cheap no-op once the layer is
    // already empty. kNN needs vec_chunks (populated by the embed pass above; computeKnnEdges returns []
    // when sqlite-vec is unavailable).
    // Guarded on the densification columns: reconciling unconditionally against a vault_edges that
    // predates migration 20260713_001 would throw on the upsert and kill the entire index pass.
    if (hasDerivedEdgeColumns(args.db)) {
      const tagDesired =
        args.densify?.tagEdges && tableExists(args.db, "notes")
          ? tagCooccurrenceEdges(readNoteTags(args.db, args.vaultId), {
              maxTagFanout: args.densify.maxTagFanout ?? 25,
            })
          : [];
      reconcileDerivedEdges(args.db, args.vaultId, tagDesired, ["shared_tag"], now);

      const knnDesired = args.densify?.knnEdges
        ? computeKnnEdges(args.db, args.vaultId, {
            k: args.densify.knnK ?? 8,
            minSim: args.densify.knnMinSim ?? 0,
          })
        : [];
      reconcileDerivedEdges(args.db, args.vaultId, knnDesired, ["similar_to"], now);
    }
  }
  return stats;
}
