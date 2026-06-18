import { createRequire } from "node:module";
import type { Database } from "../db/types";

const requireFromHere = createRequire(import.meta.url);

// Encode a JS number[] as a little-endian float32 BLOB — the on-disk wire format
// shared by sqlite-vec's vec0 columns and the brute-force scan in search/semantic.
export function floatBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

// Decode a float32 BLOB (Uint8Array/Buffer from a SQLite row) back to number[].
export function blobToFloats(blob: Uint8Array): number[] {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Float32Array requires a 4-byte-aligned offset; copy when a row view isn't.
  const aligned = u8.byteOffset % 4 === 0 ? u8 : u8.slice();
  const floats = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  return Array.from(floats);
}

// Load the sqlite-vec extension on this connection. Returns false (never throws)
// when the runtime can't load extensions (node:sqlite) or the platform binary is
// unavailable, so callers degrade to the brute-force cosine scan.
export function loadVec(db: Database): boolean {
  if (typeof db.loadExtension !== "function") return false;
  try {
    const sqliteVec = requireFromHere("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(sqliteVec.getLoadablePath());
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

// Create the per-vault, dimension-bound vec0 virtual table (cosine metric) and
// record it in schema_migrations as 20260519_002_vec_chunks_<dims>, matching the
// schema.sql header. The table + row persist in the DB file; the extension still
// must be reloaded per connection via loadVec. Returns false when the extension
// can't load (caller uses the brute-force scan instead).
export function ensureVecChunks(
  db: Database,
  dims: number,
  opts: { now?: () => number } = {},
): boolean {
  if (!loadVec(db)) return false;
  const now = opts.now ?? Date.now;
  const version = `20260519_002_vec_chunks_${dims}`;
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`,
  );
  const recorded = db
    .prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get(version);
  if (!recorded) {
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
    ).run(version, now(), "m2-runtime", 0, `vec0:cosine:${dims}`);
  }
  return true;
}

// k-NN over vec_chunks for a query vector; returns chunk_id + cosine distance
// (0 = identical direction, 1 = orthogonal) nearest-first. Cosine similarity is
// 1 - distance. Requires loadVec to have already succeeded on this connection.
export function vecKnn(
  db: Database,
  query: number[],
  k: number,
): Array<{ chunk_id: string; distance: number }> {
  return db
    .prepare(
      "SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    )
    .all(floatBlob(query), k) as Array<{ chunk_id: string; distance: number }>;
}

// Insert/replace a chunk's vector in vec_chunks. vec0 has no UPSERT, so this is
// delete-then-insert. Call only when the extension is loaded on this connection.
export function upsertVec(db: Database, chunkId: string, vector: number[]): void {
  db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(chunkId);
  db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)").run(
    chunkId,
    floatBlob(vector),
  );
}
