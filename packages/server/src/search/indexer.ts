// Chunk-store writer: turns notes into persisted chunks + embeddings, and keeps
// the store incremental. A chunk's id is stable for a (vault, path, position), so
// re-indexing skips chunks whose content hash is unchanged, re-embeds changed
// ones, and prunes chunks that no longer exist in the note. chunk_embeddings is
// deleted explicitly (not relying on FK cascade, which node:sqlite tests run with
// foreign_keys off). vec_chunks is kept in lock-step only when the extension loaded.
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { parseNote } from "../vault/frontmatter";
import { readNote } from "../vault/notes-io";
import { contentHash, resolveVaultPath, walkVault } from "../vault/paths";
import { chunkNote } from "./chunk";
import { ensureVecChunks, floatBlob, upsertVec } from "./vec";

export interface IndexStats {
  notes_seen: number;
  notes_indexed: number;
  chunks_upserted: number;
  chunks_deleted: number;
  chunks_unchanged: number;
  vec_enabled: boolean;
  model: string;
  dimensions: number;
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
): Promise<{ upserted: number; deleted: number; unchanged: number }> {
  const body = parseNote(raw).body;
  const desired = chunkNote(body).map((c) => ({ ...c, id: chunkId(vaultId, path, c.index) }));
  const desiredIds = new Set(desired.map((d) => d.id));

  const existing = db
    .prepare("SELECT id, content_hash FROM chunks WHERE vault_id = ? AND path = ?")
    .all(vaultId, path) as ExistingRow[];
  const existingHash = new Map(existing.map((e) => [e.id, e.content_hash]));

  let deleted = 0;
  for (const e of existing) {
    if (desiredIds.has(e.id)) continue;
    db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?").run(e.id);
    db.prepare("DELETE FROM chunks WHERE id = ?").run(e.id);
    if (hasVec) db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(e.id);
    deleted += 1;
  }

  const toEmbed = desired.filter((d) => existingHash.get(d.id) !== d.contentHash);
  const unchanged = desired.length - toEmbed.length;

  if (toEmbed.length > 0) {
    const vectors = await provider.embed(toEmbed.map((d) => d.content));
    const ts = now();
    const upChunk = db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, token_count = excluded.token_count, updated_at = excluded.updated_at",
    );
    const upEmb = db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
    );
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
  }
  return { upserted: toEmbed.length, deleted, unchanged };
}

export interface IndexVaultArgs {
  db: Database;
  provider: EmbeddingProvider;
  vaultId: string;
  root: string;
  sub?: string;
  isReadable: (rel: string) => boolean;
  now?: () => number;
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
    vec_enabled: hasVec,
    model: args.provider.id,
    dimensions: args.provider.dimensions,
  };
  for (const rel of notes) {
    const raw = readNote(resolveVaultPath(args.root, rel)).raw;
    const r = await indexNote(args.db, args.provider, args.vaultId, rel, raw, hasVec, now);
    stats.chunks_upserted += r.upserted;
    stats.chunks_deleted += r.deleted;
    stats.chunks_unchanged += r.unchanged;
    if (r.upserted > 0 || r.deleted > 0) stats.notes_indexed += 1;
  }
  return stats;
}
