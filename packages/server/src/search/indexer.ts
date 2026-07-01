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
}

// Compute a note's write plan and run its embedding network call — NO database writes, NO
// transaction. Returns { plan: null } when the note is unchanged (nothing to prune or embed), so
// the caller opens no transaction for a warm re-index. Keeping embed() here, outside any
// transaction, is what lets indexVault batch many notes' writes into ONE transaction without ever
// holding the write lock across a network call.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
): Promise<PlanResult> {
  const body = parseNote(raw).body;
  // Secret-gate (THE-134 fold): a chunk whose content matches a credential shape is dropped
  // before embedding — never embedded, never stored, pruned if it existed. Class names only
  // are logged; the matched value is never logged or thrown.
  let secretsSkipped = 0;
  const desired = chunkNote(body)
    .map((c) => ({ ...c, id: chunkId(vaultId, path, c.index) }))
    .filter((c) => {
      const scan = scanSecrets(c.content);
      if (scan.clean) return true;
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
    return { plan: null, unchanged, secretsSkipped };
  }
  // Network I/O — deliberately outside any transaction.
  const vectors = toEmbed.length > 0 ? await provider.embed(toEmbed.map((d) => d.content)) : [];
  return { plan: { path, existing, desiredIds, toEmbed, vectors, ts }, unchanged, secretsSkipped };
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
  const { plan, unchanged, secretsSkipped } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
  );
  if (!plan) return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
  let result: { upserted: number; deleted: number };
  db.exec("BEGIN");
  try {
    result = applyNoteWrites(db, provider, vaultId, plan, hasVec);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  fireIndexHook(onIndexed, plan);
  return { ...result, unchanged, secretsSkipped };
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
}

export async function indexVault(args: IndexVaultArgs): Promise<IndexStats> {
  const now = args.now ?? Date.now;
  const hasVec = ensureVecChunks(args.db, args.provider.dimensions, { now });
  const notes = walkVault(args.root, { sub: args.sub, extensions: [".md"] })
    .map((e) => e.relPath)
    .filter(args.isReadable);
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
  const flush = (): void => {
    if (batch.length === 0) return;
    const applied = batch;
    batch = [];
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
  for (const rel of notes) {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    noteLinks.set(rel, extractLinks(parseNote(raw).body));
    const { plan, unchanged, secretsSkipped } = await planNoteWrites(
      args.db,
      args.provider,
      args.vaultId,
      rel,
      raw,
      now(),
    );
    stats.chunks_unchanged += unchanged;
    stats.secrets_skipped += secretsSkipped;
    if (plan) {
      batch.push(plan);
      if (batch.length >= BATCH) flush();
    }
  }
  flush();
  // Edge maintenance is full-state (resolving targets needs the whole note universe), so it
  // runs once per indexVault pass, not per-note-write. Skipped gracefully when vault_edges is
  // absent (pre-integration, before W-SCHEMA lands).
  if (tableExists(args.db, "vault_edges")) {
    const edgeStats = reconcileVaultEdges(args.db, desiredEdges(noteLinks, notes), now);
    stats.edges_inserted = edgeStats.inserted;
    stats.edges_deleted = edgeStats.deleted;
  }
  return stats;
}
