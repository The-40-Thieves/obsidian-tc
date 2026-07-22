import { createRequire } from "node:module";
import { cachedPrepare, type Database } from "../db/types";
import { type VecFingerprint, vecFingerprint } from "./representation";

export type { VecFingerprint } from "./representation";
export { vecFingerprint } from "./representation";

const requireFromHere = createRequire(import.meta.url);

// Encode a JS number[] as a little-endian float32 BLOB — the on-disk wire format
// shared by sqlite-vec's vec0 columns and the brute-force scan in search/semantic.
export function floatBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

// Decode a float32 BLOB (Uint8Array/Buffer from a SQLite row) into a Float32Array view.
// Returned directly (zero-copy, THE-266) so the native cosine path takes the typed array
// without re-copying into a number[]; callers only index it and read .length.
export function blobToFloats(blob: Uint8Array): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Float32Array requires a 4-byte-aligned offset; copy when a row view isn't.
  const aligned = u8.byteOffset % 4 === 0 ? u8 : u8.slice();
  const floats = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  return floats;
}

// Connections that already loaded the sqlite-vec extension. semanticSearch calls loadVec on
// every query, so memoizing the idempotent require + loadExtension + vec_version() probe per
// connection makes it O(1) after the first success. Failures are NOT cached (a transient failure
// stays retryable); node:sqlite (no loadExtension) is rejected before the cache check.
const vecLoaded = new WeakSet<Database>();

// Load the sqlite-vec extension on this connection. Returns false (never throws)
// when the runtime can't load extensions (node:sqlite) or the platform binary is
// unavailable, so callers degrade to the brute-force cosine scan.
export function loadVec(db: Database): boolean {
  if (typeof db.loadExtension !== "function") return false;
  if (vecLoaded.has(db)) return true;
  try {
    const sqliteVec = requireFromHere("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(sqliteVec.getLoadablePath());
    db.prepare("SELECT vec_version()").get();
    vecLoaded.add(db);
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
//
// THE-460: `fp` is the full representation fingerprint (provider/model/dimensions + distance
// metric + chunker/enrichment versions + schema gen), not just dims. It's persisted in the
// dedicated vec_index_fingerprint table and compared on every call; ANY field changing (a
// same-dimension model swap, a chunker/enrichment version bump, a schema-gen bump, or a plain
// dimension change) triggers the same rebuild+backfill path as the legacy pre-partition shape.
export function ensureVecChunks(
  db: Database,
  fp: VecFingerprint,
  opts: { now?: () => number } = {},
): boolean {
  if (!loadVec(db)) return false;
  const now = opts.now ?? Date.now;
  const dims = fp.dimensions;
  const version = `20260519_002_vec_chunks_${dims}`;
  // THE-277 item 3 (sqlite-vec >= 0.1.9): vault_id as a PARTITION KEY pre-shards the KNN per
  // vault (the cross-vault crowding THE-287 worked around becomes structurally impossible when
  // the caller passes vaultId), and +path/+model aux columns kill the metadata JOIN for the
  // fields the hot path needs. +content is deliberately NOT aux — it would duplicate the whole
  // corpus text inside the vec file; content stays a batched JOIN only when requested.
  const ddl = `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, vault_id TEXT partition key, +path TEXT, +model TEXT, embedding float[${dims}] distance_metric=cosine)`;

  // THE-460: a dedicated one-row table tracks the computed fingerprint string. Created up front
  // (idempotent) so both the "table missing" and "table present" branches below can read/compare
  // against whatever was last recorded.
  db.exec(
    "CREATE TABLE IF NOT EXISTS vec_index_fingerprint (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL)",
  );
  const computedFp = vecFingerprint(fp);
  const storedFp = (
    db.prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1").get() as
      | { fingerprint: string }
      | undefined
  )?.fingerprint;

  const hasTable =
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_chunks'").get() !== undefined;
  if (!hasTable) {
    db.exec(ddl);
  } else {
    // Shape-detect a legacy (pre-partition) table and rebuild it IN PLACE from the stored
    // embeddings — chunk_embeddings holds every active vector, so no re-embed is needed and
    // the rebuilt index is bit-identical (same vectors, same cosine metric).
    let legacy = false;
    try {
      db.prepare("SELECT vault_id FROM vec_chunks LIMIT 1").get();
    } catch {
      legacy = true;
    }
    // THE-460: a fingerprint mismatch is the general rebuild trigger — it SUBSUMES the old
    // THE-457 dims-only check (dimensions are one of the fields folded into the fingerprint) and
    // additionally catches a same-dimension model swap, a chunker/enrichment version bump, or a
    // schema-gen bump. The backfill below only re-inserts vectors already at the current dims
    // (length = dims*4), so a mid-swap re-embed fills the rest on its own reconcile — same as
    // before.
    const fpChanged = storedFp !== computedFp;
    if (legacy || fpChanged) {
      db.exec("DROP TABLE vec_chunks");
      db.exec(ddl);
      const canBackfill =
        db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'chunk_embeddings'").get() !==
        undefined;
      // A pre-partition rebuild only backfills vectors whose byte length matches the CURRENT dims
      // (dims*4). Active embeddings at a DIFFERENT dimensionality (a model/dim swap not yet
      // re-embedded) are excluded and would otherwise vanish from the KNN index silently. Count the
      // skip so it lands in the migration checksum below (this module has no logger, and refusing
      // outright would brick a legitimate mid-swap rebuild).
      let skipped = 0;
      if (canBackfill) {
        const active = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1",
            )
            .get() as { n: number }
        ).n;
        // THE-460: filter on the MODEL as well as the byte length. Length alone cannot distinguish
        // a same-dimension model swap — old-model vectors are exactly dims*4 too, so they passed
        // the guard and refilled the index while the stored fingerprint claimed the new model.
        // Retrieval would then score new-model queries against old-model embeddings: not an error,
        // just quietly wrong results. Vectors from any other model are left for the re-embed to
        // regenerate, which is the same posture already taken for a dimension change.
        const inserted = db
          .prepare(
            `INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding)
             SELECT e.chunk_id, c.vault_id, c.path, e.model, e.embedding
             FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
             WHERE e.is_active = 1 AND length(e.embedding) = ${dims * 4} AND e.model = ?`,
          )
          .run(fp.model).changes as number;
        skipped = active - inserted;
      }
      const rebuiltVersion = `20260712_004_vec_chunks_aux_${dims}`;
      const rec = db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(rebuiltVersion);
      if (!rec) {
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
        ).run(
          rebuiltVersion,
          now(),
          "m2-runtime",
          0,
          `vec0:partition+aux:${dims}${skipped > 0 ? `:skipped${skipped}` : ""}`,
        );
      }
    }
  }
  const recorded = db
    .prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get(version);
  if (!recorded) {
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
    ).run(version, now(), "m2-runtime", 0, `vec0:cosine:${dims}`);
  }
  // THE-460: only write when the fingerprint actually changed — a no-change call (fingerprint
  // matches, table already current) stays a true no-op with no writes here.
  if (storedFp !== computedFp) {
    db.prepare(
      "INSERT INTO vec_index_fingerprint (id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint",
    ).run(computedFp);
  }
  return true;
}

// k-NN over vec_chunks for a query vector; returns chunk_id + cosine distance
// (0 = identical direction, 1 = orthogonal) nearest-first. Cosine similarity is
// 1 - distance. Requires loadVec to have already succeeded on this connection.
// THE-277: pass vaultId to prune the KNN to that vault's partition shard — the
// scan never touches other vaults' vectors, and the aux path rides along free.
export function vecKnn(
  db: Database,
  query: number[],
  k: number,
  vaultId?: string,
): Array<{ chunk_id: string; distance: number; path?: string }> {
  if (vaultId !== undefined) {
    return db
      .prepare(
        "SELECT chunk_id, path, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND vault_id = ? ORDER BY distance",
      )
      .all(floatBlob(query), k, vaultId) as Array<{
      chunk_id: string;
      distance: number;
      path?: string;
    }>;
  }
  return db
    .prepare(
      "SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    )
    .all(floatBlob(query), k) as Array<{ chunk_id: string; distance: number }>;
}

// Insert/replace a chunk's vector in vec_chunks. vec0 has no UPSERT, so this is
// delete-then-insert. Call only when the extension is loaded on this connection.
export function upsertVec(
  db: Database,
  chunkId: string,
  vector: number[],
  meta: { vaultId: string; path: string; model: string },
): void {
  // THE-316: static-arity SQL on the per-chunk reconcile write path — cache the compiled statement
  // by SQL text so a warm reindex does not recompile the vec0 DELETE/INSERT once per embedded chunk.
  cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?").run(chunkId);
  cachedPrepare(
    db,
    "INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding) VALUES (?, ?, ?, ?, ?)",
  ).run(chunkId, meta.vaultId, meta.path, meta.model, floatBlob(vector));
}
