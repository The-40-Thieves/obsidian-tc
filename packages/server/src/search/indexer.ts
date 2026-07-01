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
  // Nothing to write (note unchanged on re-index) — the common warm-reindex path, so it must not
  // pay for an empty BEGIN/COMMIT.
  if (toEmbed.length === 0 && !willPrune) {
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
  }

  // The embedding call is network I/O, so it runs BEFORE the transaction — a slow provider must
  // never hold the write lock. The prune + upserts then commit as ONE transaction: every
  // statement otherwise autocommits (one fsync each) under better-sqlite3/bun:sqlite, so a
  // many-chunk note paid dozens of commits; now it pays one, and a mid-write crash can no longer
  // leave chunks / chunk_embeddings / vec_chunks partially diverged. (Batching the whole
  // indexVault boot walk into a single transaction is a deliberate follow-up: it would hold the
  // lock across each note's embed() network call, which this keeps outside.)
  const vectors = toEmbed.length > 0 ? await provider.embed(toEmbed.map((d) => d.content)) : [];
  const ts = now();

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
  db.exec("BEGIN");
  try {
    for (const e of existing) {
      if (desiredIds.has(e.id)) continue;
      delEmb.run(e.id);
      delChunk.run(e.id);
      if (delVec) delVec.run(e.id);
      deleted += 1;
    }
    toEmbed.forEach((d, i) => {
      const vec = vectors[i] ?? [];
      upChunk.run(
        d.id,
        vaultId,
        path,
        d.index,
        JSON.stringify(d.headings),
        d.content,
        d.contentHash,
        d.tokenCount,
        ts,
        ts,
      );
      upEmb.run(d.id, provider.id, provider.dimensions, floatBlob(vec), ts);
      if (hasVec) upsertVec(db, d.id, vec);
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Fire AFTER commit so consumers only ever observe committed chunks.
  if (onIndexed && toEmbed.length > 0) {
    onIndexed(
      toEmbed.map((d, i) => ({
        id: d.id,
        path,
        content: d.content,
        embedding: vectors[i] ?? [],
      })),
    );
  }
  return { upserted: toEmbed.length, deleted, unchanged, secretsSkipped };
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
  for (const rel of notes) {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    noteLinks.set(rel, extractLinks(parseNote(raw).body));
    const r = await indexNote(
      args.db,
      args.provider,
      args.vaultId,
      rel,
      raw,
      hasVec,
      now,
      args.onIndexed,
    );
    stats.chunks_upserted += r.upserted;
    stats.chunks_deleted += r.deleted;
    stats.chunks_unchanged += r.unchanged;
    stats.secrets_skipped += r.secretsSkipped;
    if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
  }
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
