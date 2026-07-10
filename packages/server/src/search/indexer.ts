// Chunk-store writer: turns notes into persisted chunks + embeddings, and keeps
// the store incremental. A chunk's id is stable for a (vault, path, position), so
// re-indexing skips chunks whose content hash is unchanged, re-embeds changed
// ones, and prunes chunks that no longer exist in the note. chunk_embeddings is
// deleted explicitly (not relying on FK cascade, which node:sqlite tests run with
// foreign_keys off). vec_chunks is kept in lock-step only when the extension loaded.
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { parseNote } from "../vault/frontmatter";
import { type ExtractedLink, extractLinks } from "../vault/links";
import { readNote } from "../vault/notes-io";
import { contentHash, resolveVaultPath, walkVault } from "../vault/paths";
import { chunkNote } from "./chunk";
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

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

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

// A note's chunk after secret-gating, carrying its stable chunk id.
type PlannedChunk = ReturnType<typeof chunkNote>[number] & { id: string };

// A note's pending writes, computed (including the embed() network call) WITHOUT touching the
// database or opening a transaction, so many plans can be applied inside one transaction.
interface NoteWritePlan {
  path: string;
  existing: ExistingRow[];
  desiredIds: Set<string>;
  toEmbed: PlannedChunk[];
  vectors: number[][];
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
// and crash it regardless of the input count.
const EMBED_BATCH = 512;
const EMBED_CONCURRENCY = 4;
const EMBED_MAX_BATCH_TOKENS = 8192;

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
): PlanResult {
  const body = parseNote(raw).body;
  // Secret-gate (THE-134 fold): a chunk whose content matches a credential shape is dropped
  // before embedding — never embedded, never stored, pruned if it existed. Class names only
  // are logged; the matched value is never logged or thrown.
  let secretsSkipped = 0;
  const flagged: string[] = [];
  const desired = chunkNote(body)
    .map((c) => ({ ...c, id: chunkId(vaultId, path, c.index) }))
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
): Promise<void> {
  const contents: string[] = [];
  for (const p of plans) for (const c of p.toEmbed) contents.push(c.content);
  if (contents.length === 0) return;
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
  const results: number[][][] = new Array(subBatches.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < subBatches.length; i = next++) {
      results[i] = await provider.embed(subBatches[i] as string[]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, subBatches.length) }, () => worker()),
  );
  const flat = results.flat();
  let off = 0;
  for (const p of plans) {
    p.vectors = flat.slice(off, off + p.toEmbed.length);
    off += p.toEmbed.length;
  }
}

// Single-note plan + embed (indexNote / index-on-write path). indexVault batches embeds instead.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
): Promise<PlanResult> {
  const res = computeNotePlan(db, vaultId, path, raw, ts);
  if (res.plan) await embedPlans(provider, [res.plan], EMBED_BATCH, EMBED_CONCURRENCY);
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
    if (hasVec) upsertVec(db, d.id, vec);
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
): Promise<{ upserted: number; deleted: number; unchanged: number; secretsSkipped: number }> {
  const { plan, unchanged, secretsSkipped, flagged } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
  );
  // THE-291: the metadata/FTS row rides the same write (skip empty content — a true delete goes
  // through deindexNote; an empty note has nothing to index).
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db, { now });
  const note: NoteRecord | null =
    hasNotes && raw !== "" ? buildNoteRecord(path, raw, flagged, null, now()) : null;
  if (!plan) {
    // Chunks unchanged; refresh the notes row only when missing/stale (backfill path).
    if (note && noteRowHash(db, vaultId, path) !== note.contentHash) {
      db.exec("BEGIN");
      try {
        upsertNoteRow(db, vaultId, note, hasFts, now());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
  }
  let result: { upserted: number; deleted: number };
  db.exec("BEGIN");
  try {
    result = applyNoteWrites(db, provider, vaultId, plan, hasVec);
    if (note) upsertNoteRow(db, vaultId, note, hasFts, now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
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
export function deindexNote(db: Database, vaultId: string, path: string, hasVec: boolean): void {
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db);
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
    }
    if (hasNotes) deleteNoteRow(db, vaultId, path, hasFts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
    await embedPlans(
      args.provider,
      applied,
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens ?? EMBED_MAX_BATCH_TOKENS,
    );
    args.db.exec("BEGIN");
    try {
      for (const plan of applied) {
        const r = applyNoteWrites(args.db, args.provider, args.vaultId, plan, hasVec);
        stats.chunks_upserted += r.upserted;
        stats.chunks_deleted += r.deleted;
        if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
      }
      args.db.exec("COMMIT");
    } catch (err) {
      args.db.exec("ROLLBACK");
      throw err;
    }
    for (const plan of applied) fireIndexHook(args.onIndexed, plan);
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
    } catch (err) {
      args.db.exec("ROLLBACK");
      throw err;
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
        deindexNote(args.db, args.vaultId, row.path, hasVec);
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
  }
  return stats;
}
